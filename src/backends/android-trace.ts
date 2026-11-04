// Android performance traces: a perfetto system trace (CPU scheduling + frequency, SurfaceFlinger frame timeline, the
// app's atrace categories) recorded on the device in the background, plus `dumpsys gfxinfo <pkg>` frame stats for the
// same window (reset at start, read at stop). perfetto runs with --background and duration_ms = the time limit, so it
// stops by itself even if the daemon dies; stop sends it SIGTERM (it then writes the file), and the trace is pulled.
// The summary comes from gfxinfo; the .perfetto-trace opens in https://ui.perfetto.dev (or trace_processor_shell).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sleep } from '../core/exec.ts';
import { which } from '../core/paths.ts';
import { PhoneDockError, type TraceCapture, type TraceFrames, type TraceStarted } from '../core/types.ts';
import { adb, launchApp } from './android-common.ts';

export const PERFETTO_TEMPLATE = 'default: sched, cpufreq, frametimeline, atrace';
const REMOTE_DIR = '/data/misc/perfetto-traces';
const PKG_RE = /^[A-Za-z0-9._]+$/;

/** perfetto text-proto config for one app. `durationMs` is the hard stop perfetto enforces itself. */
export function perfettoConfig(pkg: string, durationMs: number): string {
  if (!PKG_RE.test(pkg)) throw new PhoneDockError('The package name is invalid', 'bad_request', 400, undefined, `Invalid package name ${JSON.stringify(pkg)}`);
  const ev = ['sched/sched_switch', 'sched/sched_waking', 'sched/sched_wakeup_new', 'sched/sched_process_exit', 'sched/sched_process_free',
    'task/task_newtask', 'task/task_rename', 'power/cpu_frequency', 'power/cpu_idle', 'power/suspend_resume'];
  const cats = ['gfx', 'view', 'input', 'am', 'wm', 'dalvik', 'binder_driver', 'hal', 'res', 'sched', 'freq'];
  return [
    'buffers { size_kb: 65536 fill_policy: RING_BUFFER }',
    'buffers { size_kb: 4096 fill_policy: RING_BUFFER }',
    'data_sources { config { name: "linux.ftrace" target_buffer: 0 ftrace_config {',
    ...ev.map((e) => `  ftrace_events: "${e}"`),
    ...cats.map((c) => `  atrace_categories: "${c}"`),
    `  atrace_apps: "${pkg}"`,
    '} } }',
    'data_sources { config { name: "linux.process_stats" target_buffer: 1 process_stats_config { scan_all_processes_on_start: true proc_stats_poll_ms: 1000 } } }',
    'data_sources { config { name: "linux.sys_stats" target_buffer: 1 sys_stats_config { stat_period_ms: 250 stat_counters: STAT_CPU_TIMES stat_counters: STAT_FORK_COUNT } } }',
    'data_sources { config { name: "android.surfaceflinger.frametimeline" } }',
    'data_sources { config { name: "android.packages_list" target_buffer: 1 } }',
    `duration_ms: ${Math.max(1000, Math.round(durationMs))}`,
    'write_into_file: true',
    'file_write_period_ms: 2500',
    'flush_period_ms: 5000',
    `max_file_size_bytes: ${200 * 1024 * 1024}`,
    '',
  ].join('\n');
}

/** `dumpsys gfxinfo <pkg>` → frame stats (null when the app drew nothing / isn't running). */
export function parseGfxinfo(out: string): TraceFrames | null {
  const num = (re: RegExp) => { const m = re.exec(out); return m ? Number(m[1]) : null; };
  const total = num(/^\s*Total frames rendered:\s*(\d+)/m);
  if (total === null) return null;
  const jm = /^\s*Janky frames:\s*(\d+)\s*\(([\d.]+)%\)/m.exec(out);
  const legacy = /^\s*Janky frames \(legacy\):\s*\d+\s*\(([\d.]+)%\)/m.exec(out);
  // With no frames Android prints its histogram's top bucket (4950 ms) for every percentile: report null instead.
  const pct = (p: number) => (total ? num(new RegExp(`^\\s*${p}th percentile:\\s*(\\d+(?:\\.\\d+)?)ms`, 'm')) : null);
  const janky = jm ? Number(jm[1]) : 0;
  return {
    total, janky, jankyPct: jm ? Number(jm[2]) : total ? Math.round((janky / total) * 10000) / 100 : 0,
    p50Ms: pct(50), p90Ms: pct(90), p95Ms: pct(95), p99Ms: pct(99),
    missedVsync: num(/^\s*Number Missed Vsync:\s*(\d+)/m), slowUiThread: num(/^\s*Number Slow UI thread:\s*(\d+)/m),
    deadlineMissed: num(/^\s*Number Frame deadline missed:\s*(\d+)/m), jankyLegacyPct: legacy ? Number(legacy[1]) : null,
  };
}

/** The pid perfetto --background prints (last number on its own line). */
export function parsePerfettoPid(stdout: string): number | undefined {
  const m = /(?:^|\n)\s*(\d+)\s*$/.exec(stdout.trim());
  return m ? Number(m[1]) : undefined;
}

export function traceProcessorPath(): string | undefined { return which('trace_processor_shell') ?? which('trace_processor'); }

interface Session { serial: string; pid: number; remote: string; dir: string; appId: string; startedAt: number; timeLimitSec: number; config: string }
const sessions = new Map<string, Session>();

async function appPid(serial: string, pkg: string): Promise<number | undefined> {
  const r = await adb(serial, ['shell', 'pidof', pkg], { allowFail: true, timeoutMs: 15_000 });
  const p = Number(r.stdout.trim().split(/\s+/)[0]);
  return Number.isFinite(p) && p > 0 ? p : undefined;
}

export async function startPerfetto(serial: string, dir: string, o: { appId: string; timeLimitSec: number; launch?: boolean }): Promise<TraceStarted> {
  if (sessions.has(serial)) throw new PhoneDockError('A trace is already running on this device', 'trace_active', 409, ['Stop it first.']);
  const pkg = o.appId;
  const config = perfettoConfig(pkg, o.timeLimitSec * 1000);
  const installed = await adb(serial, ['shell', 'pm', 'path', pkg], { allowFail: true, timeoutMs: 20_000 });
  if (!/package:/.test(installed.stdout)) throw new PhoneDockError('The app is not installed on this device', 'app_not_installed', 404, [`Install ${pkg} first (phonedock install), or check the package name with list_apps.`], `pm path ${pkg}: ${(installed.stdout + installed.stderr).trim().slice(0, 300)}`);
  let pid = await appPid(serial, pkg); let launched = false;
  if (!pid) {
    if (!o.launch) throw new PhoneDockError('The app is not running', 'app_not_running', 409, [`Open ${pkg} first (launch it), or pass launch: true.`], `pidof ${pkg} found no process`);
    await launchApp(serial, pkg); launched = true;
    for (let i = 0; i < 40 && !pid; i++) { await sleep(500); pid = await appPid(serial, pkg); }
    if (!pid) throw new PhoneDockError('The app did not start', 'app_not_running', 409, [`Open ${pkg} by hand and try again.`], `pidof ${pkg} found no process 20 s after launching it`);
  }
  const pf = await adb(serial, ['shell', 'command', '-v', 'perfetto'], { allowFail: true, timeoutMs: 15_000 });
  if (!pf.stdout.trim()) throw new PhoneDockError('This Android version has no perfetto', 'perfetto_missing', 501, ['Use Android 10 or later (perfetto ships with the OS from Android 9; it is on by default from Android 11).'], 'command -v perfetto: not found');
  // Frame stats for exactly this window.
  await adb(serial, ['shell', 'dumpsys', 'gfxinfo', pkg, 'reset'], { allowFail: true, timeoutMs: 20_000 });
  const remote = `${REMOTE_DIR}/phonedock-${Date.now()}.perfetto-trace`;
  writeFileSync(join(dir, 'perfetto-config.pbtxt'), config);
  const r = await adb(serial, ['shell', 'perfetto', '--background', '--txt', '-c', '-', '-o', remote], { input: config, allowFail: true, timeoutMs: 30_000 });
  const tracePid = parsePerfettoPid(r.stdout);
  if (r.code !== 0 || !tracePid) {
    const msg = (r.stderr + '\n' + r.stdout).trim();
    const hints = /traced|persist\.traced/i.test(msg)
      ? ['Enable the tracing service: adb shell setprop persist.traced.enable 1 (Android 9–10), then try again.']
      : ['Check the device is unlocked and has free storage, then try again.'];
    throw new PhoneDockError('Couldn’t start the perfetto trace', 'trace_failed', 500, hints, `perfetto exited ${r.code}: ${msg.slice(-1200)}`);
  }
  sessions.set(serial, { serial, pid: tracePid, remote, dir, appId: pkg, startedAt: Date.now(), timeLimitSec: o.timeLimitSec, config });
  return { tool: 'perfetto', template: PERFETTO_TEMPLATE, process: { pid, name: pkg }, ...(launched ? { launched: true } : {}) };
}

async function alive(serial: string, pid: number): Promise<boolean> {
  const r = await adb(serial, ['shell', `kill -0 ${pid} 2>/dev/null && echo alive || echo gone`], { allowFail: true, timeoutMs: 15_000 });
  return r.stdout.includes('alive');
}
/** SIGTERM perfetto (it flushes and writes the file) and wait for it to exit. */
async function endPerfetto(s: Session, waitMs = 30_000): Promise<boolean> {
  await adb(s.serial, ['shell', 'kill', '-TERM', String(s.pid)], { allowFail: true, timeoutMs: 15_000 });
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) { if (!(await alive(s.serial, s.pid))) return true; await sleep(500); }
  return false;
}

export function hasTrace(serial: string): boolean { return sessions.has(serial); }

export async function stopPerfetto(serial: string): Promise<TraceCapture> {
  const s = sessions.get(serial);
  if (!s) throw new PhoneDockError('No trace is running on this device', 'not_tracing', 409, ['Start one first.']);
  try {
    const notes: string[] = [];
    const endedAt = Date.now();
    // gfxinfo first: its window should end where the trace ends.
    const g = await adb(serial, ['shell', 'dumpsys', 'gfxinfo', s.appId], { allowFail: true, timeoutMs: 30_000 });
    writeFileSync(join(s.dir, 'gfxinfo.txt'), g.stdout);
    const frames = parseGfxinfo(g.stdout);
    if (!frames) notes.push(`No frame stats: ${s.appId} drew no frames, or it is no longer running.`);
    else if (!frames.total) notes.push('The app rendered no frames while traced (nothing moved on screen?).');
    if (!(await endPerfetto(s))) notes.push('perfetto did not exit within 30 s of SIGTERM; the pulled trace may be cut short.');
    const local = join(s.dir, 'trace.perfetto-trace');
    const pull = await adb(serial, ['pull', s.remote, local], { allowFail: true, timeoutMs: 300_000 });
    await adb(serial, ['shell', 'rm', '-f', s.remote], { allowFail: true, timeoutMs: 15_000 });
    if (pull.code !== 0) {
      throw new PhoneDockError('Couldn’t copy the trace from the device', 'trace_failed', 500, ['Check the device is still connected, then trace again.'], `adb pull ${s.remote}: ${(pull.stderr || pull.stdout).trim().slice(-600)}`);
    }
    const tp = traceProcessorPath();
    notes.push(tp ? `Query it with ${tp} ${local}` : 'Open trace.perfetto-trace in https://ui.perfetto.dev for CPU scheduling, the frame timeline and app slices (trace_processor_shell is not installed).');
    const durationSec = Math.round(Math.min(endedAt - s.startedAt, s.timeLimitSec * 1000) / 100) / 10;
    return { files: { trace: local, gfxinfo: join(s.dir, 'gfxinfo.txt'), config: join(s.dir, 'perfetto-config.pbtxt') }, durationSec, hangs: null, mainThreadMs: null, hotspots: [], appHotspots: [], frames, triage: null, notes };
  } finally { sessions.delete(serial); }
}

/** Stop perfetto now (daemon exit). The file stays on the device; perfetto would have stopped at its duration anyway. */
export async function abortPerfetto(serial: string): Promise<void> {
  const s = sessions.get(serial); if (!s) return;
  sessions.delete(serial);
  try {   // stop it, then remove its file from the device (nothing will pull it)
    if (await endPerfetto(s, 8000)) await adb(serial, ['shell', 'rm', '-f', s.remote], { allowFail: true, timeoutMs: 5000 });
  } catch { /* device gone */ }
}
