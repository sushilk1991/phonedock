// iOS performance traces with Instruments' CLI, `xctrace` (simulators and real iPhones). One recorder per device:
// `xctrace record --attach <pid> --time-limit …` runs in the background while the agent drives the app; stop sends
// SIGINT (xctrace then finalizes the .trace), checks the file opens (`xctrace toc`), and summarizes it:
//   hangs      `xctrace show --track Hangs --list Hangs` (Apple's tiers) + `xctrace triage --style hangs` (capped)
//   hot spots  the main thread's inverted Time Profiler call tree (self time), and again with system libraries hidden
//              (= the app's own functions, charged with the system work they call)
// Templates without the Hangs or Time Profiler instrument get them added (--instrument), so every summary has the
// same keys. xctrace's own --time-limit ends a recording even when the daemon died.
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run, sleep } from '../core/exec.ts';
import { developerDir, toolEnv } from '../core/paths.ts';
import { PhoneDockError, type TraceCapture, type TraceHangs, type TraceHotspot, type TraceStarted } from '../core/types.ts';

export const DEFAULT_TEMPLATE = 'Time Profiler';
const START_TIMEOUT_MS = 150_000;     // xctrace takes 3–30 s to attach; well over 2 min at a load average of 60
const FINALIZE_TIMEOUT_MS = 150_000;  // after SIGINT: "Saving output file…"
const ANALYZE_TIMEOUT_MS = 120_000;
export const TRIAGE_CAP = 20_000;     // chars of compacted triage handed to the daemon (it trims to the caller's triageChars)
export const TOP_N = 25;              // hot spots handed to the daemon (it keeps the caller's `top`, default 5)

// ── xctrace binary ──────────────────────────────────────────────────────────
let xctraceBin: string | undefined;
/** Path to xctrace (spawned directly, not via xcrun, so SIGINT reaches it). Throws xctrace_missing. */
export async function xctracePath(): Promise<string> {
  if (xctraceBin && existsSync(xctraceBin)) return xctraceBin;
  const missing = (detail: string) => new PhoneDockError('xctrace (Instruments’ command-line tool) is not available', 'xctrace_missing', 501,
    ['Install Xcode from the App Store and open it once (xctrace ships with Xcode, not the Command Line Tools).', 'If Xcode is installed somewhere else, set DEVELOPER_DIR to its Contents/Developer folder.'], detail);
  if (!developerDir()) throw missing('No Xcode found (looked at $DEVELOPER_DIR and /Applications/Xcode.app)');
  const r = await run('xcrun', ['--find', 'xctrace'], { env: toolEnv(), allowFail: true, timeoutMs: 30_000 }).catch((e: Error) => ({ code: 1, stdout: '', stderr: e.message }));
  const p = r.stdout.trim();
  if (r.code !== 0 || !p || !existsSync(p)) throw missing(`xcrun --find xctrace failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  xctraceBin = p;
  return p;
}

// ── templates ───────────────────────────────────────────────────────────────
// Instruments in the standard templates (Xcode 27.2: read from the .tracetemplate files; used when a file can't be read).
const KNOWN: Record<string, { hangs: boolean; timeProfiler: boolean }> = {
  'Time Profiler': { hangs: true, timeProfiler: true },
  'Animation Hitches': { hangs: true, timeProfiler: true },
  'SwiftUI': { hangs: true, timeProfiler: true },
  'System Trace': { hangs: true, timeProfiler: true },
  'Swift Concurrency': { hangs: true, timeProfiler: true },
  'App Launch': { hangs: false, timeProfiler: true },
  'Allocations': { hangs: false, timeProfiler: false },
  'Leaks': { hangs: false, timeProfiler: false },
};
const templateCache = new Map<string, { hangs: boolean; timeProfiler: boolean } | null>();
function findTemplateFile(name: string): string | undefined {
  if (name.endsWith('.tracetemplate')) return existsSync(name) ? name : undefined;
  const dd = developerDir(); if (!dd) return undefined;
  const root = join(dd, '..', 'Applications', 'Instruments.app', 'Contents');
  const want = `${name}.tracetemplate`;
  const walk = (dir: string, depth: number): string | undefined => {
    let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return undefined; }
    for (const e of ents) if (e.name === want) return join(dir, e.name);
    if (depth >= 4) return undefined;
    for (const e of ents) if (e.isDirectory() && !e.name.endsWith('.tracetemplate')) { const f = walk(join(dir, e.name), depth + 1); if (f) return f; }
    return undefined;
  };
  return walk(root, 0);
}
/** Does the template already record Hangs and Time Profiler? undefined = unknown (custom template we can't read). */
export async function templateInstruments(name: string): Promise<{ hangs: boolean; timeProfiler: boolean } | undefined> {
  if (templateCache.has(name)) return templateCache.get(name) ?? undefined;
  let v: { hangs: boolean; timeProfiler: boolean } | null = KNOWN[name] ?? null;
  const f = findTemplateFile(name);
  if (f) {
    const r = await run('plutil', ['-convert', 'xml1', '-o', '-', f], { allowFail: true, timeoutMs: 15_000 }).catch(() => undefined);
    if (r?.code === 0) v = { hangs: r.stdout.includes('com.apple.dt-perfteam.hangs'), timeProfiler: /instrument-type\.coresampler2|>Time Profiler</.test(r.stdout) };
  }
  templateCache.set(name, v);
  return v ?? undefined;
}
/** Instruments to add so the summary can always be built (triage needs Hangs + Time Profiler). */
export function extraInstruments(has: { hangs: boolean; timeProfiler: boolean } | undefined): string[] {
  if (!has) return ['Hangs', 'Time Profiler'];   // unknown template: xctrace accepts an instrument the template already has
  return [...(has.hangs ? [] : ['Hangs']), ...(has.timeProfiler ? [] : ['Time Profiler'])];
}

// ── record ──────────────────────────────────────────────────────────────────
export interface RecordArgs { device: string; template: string; instruments: string[]; attach?: string; launch?: string[]; output: string; timeLimitSec: number }
/** argv for `xctrace record` (no shell). */
export function recordArgs(a: RecordArgs): string[] {
  const args = ['record', '--device', a.device, '--template', a.template];
  for (const i of a.instruments) args.push('--instrument', i);
  args.push('--output', a.output, '--time-limit', `${Math.max(1, Math.round(a.timeLimitSec))}s`, '--no-prompt');
  if (a.attach) args.push('--attach', a.attach);
  else if (a.launch?.length) args.push('--launch', '--', ...a.launch);
  else throw new Error('recordArgs: attach or launch required');
  return args;
}

/** A recording failure from xctrace's output → an error that says what to do. */
export function xctraceError(log: string, ctx: { device: string; appId: string; physical: boolean }): PhoneDockError {
  const tail = log.trim().split('\n').slice(-8).join('\n').slice(-1500);
  const L = log.toLowerCase();
  if (/developer mode/.test(L)) return new PhoneDockError('Developer Mode is off on the iPhone', 'developer_mode_off', 409, ['Turn on Settings › Privacy & Security › Developer Mode on the iPhone, restart it, then try again.'], tail);
  if (/(unable to|cannot|can't) find (a )?template|template .*(not found|does not exist)|no template/.test(L)) {   // Xcode 27.2: "Cannot find template matching name: X"
    return new PhoneDockError('That Instruments template does not exist', 'bad_template', 400, ['See the names with `xcrun xctrace list templates`; the default is "Time Profiler".'], tail);
  }
  if (/(cannot|can't|unable to) find (a )?device|no device|device .*not found|device is not available|unknown device/.test(L)) {
    return new PhoneDockError('Instruments cannot see this device', 'device_unavailable', 409,
      ctx.physical ? ['Unlock the iPhone, keep it connected (USB or the same Wi-Fi), and check it is listed by `xcrun xctrace list devices`.'] : ['Make sure the simulator is booted; `xcrun xctrace list devices` lists what Instruments can see.'], tail);
  }
  if (/not debuggable|get-task-allow|not permitted|operation not permitted|permission|failed to attach|unable to attach|cannot attach|could not attach|attach failed/.test(L)) {
    if (ctx.physical) {
      return new PhoneDockError('Instruments can’t attach to this app on the iPhone', 'app_not_debuggable', 409,
        [`Install a development-signed build of ${ctx.appId} (Xcode Run, or a Debug build signed with your team): App Store, TestFlight and Ad Hoc builds can’t be traced.`, 'Make sure the app is running and the iPhone is unlocked.'], tail);
    }
    return new PhoneDockError('Instruments couldn’t attach to the app', 'attach_failed', 409, [`Make sure ${ctx.appId} is running (launch it, or pass launch: true), then try again.`], tail);
  }
  if (/no (such )?process|process .*(not found|does not exist|exited)|target .*(exited|terminated)/.test(L)) {
    return new PhoneDockError('The app is not running', 'app_not_running', 409, [`Open ${ctx.appId} first (launch it), or pass launch: true.`], tail);
  }
  return new PhoneDockError('Couldn’t start the Instruments trace', 'trace_failed', 500, ['Check the device is ready and the app is running, then try again.'], tail);
}

interface Session {
  child: ChildProcess; dir: string; output: string; logFile: string; log: string;
  exited: Promise<number | null>; done: boolean; pid?: number; processName?: string; startedAt: number; template: string; appId: string;
}
const sessions = new Map<string, Session>();
// Last resort (the daemon exits without its shutdown path): ask every recorder to finalize. xctrace's own
// --time-limit covers a SIGKILLed daemon.
process.on('exit', () => { for (const s of sessions.values()) if (!s.done) { try { s.child.kill('SIGINT'); } catch { /* */ } } });

export function hasTrace(key: string): boolean { return sessions.has(key); }

/** Start `xctrace record` and resolve once it says it is recording. `key` identifies the device (one trace each). */
export async function startXctrace(key: string, dir: string, o: {
  device: string; template?: string; pid: number; processName?: string; appId: string; timeLimitSec: number; physical: boolean; launched?: boolean;
}): Promise<TraceStarted> {
  if (sessions.has(key)) throw new PhoneDockError('A trace is already running on this device', 'trace_active', 409, ['Stop it first.']);
  const bin = await xctracePath();
  const template = o.template?.trim() || DEFAULT_TEMPLATE;
  if (template.endsWith('.tracetemplate') && !existsSync(template)) throw new PhoneDockError('That template file does not exist', 'bad_template', 400, ['Pass a template name from `xcrun xctrace list templates`, or a path to a .tracetemplate file.'], template);
  const instruments = extraInstruments(await templateInstruments(template));
  const output = join(dir, 'trace.trace');
  const logFile = join(dir, 'xctrace.log');
  const args = recordArgs({ device: o.device, template, instruments, attach: String(o.pid), output, timeLimitSec: o.timeLimitSec });
  writeFileSync(join(dir, 'command.txt'), `${bin} ${args.map((a) => (/[\s"'$]/.test(a) ? JSON.stringify(a) : a)).join(' ')}\n`);
  // xctrace writes straight into xctrace.log (no pipe to the daemon) in its own process group: if the daemon exits
  // or dies while it records or finalizes, xctrace still finishes the .trace and exits by itself.
  const fd = openSync(logFile, 'a');
  let child: ChildProcess;
  try { child = spawn(bin, args, { env: toolEnv(), stdio: ['ignore', fd, fd], detached: true }); } finally { closeSync(fd); }
  const readLog = () => { try { return readFileSync(logFile, 'utf8').slice(-200_000); } catch { return ''; } };
  const s: Session = { child, dir, output, logFile, log: '', exited: new Promise((r) => {
    child.on('exit', (c) => { s.done = true; s.log = readLog(); r(c); });
    child.on('error', (e) => { s.log = `${readLog()}\nspawn error: ${e.message}`; s.done = true; r(null); });   // e.g. not executable
  }), done: false, pid: o.pid, processName: o.processName, startedAt: Date.now(), template, appId: o.appId };
  sessions.set(key, s);
  // Recording has begun once xctrace prints "Ctrl-C to stop the recording" (after "Starting recording …").
  const t0 = Date.now();
  while (Date.now() - t0 < START_TIMEOUT_MS) {
    if (!s.done) s.log = readLog();
    if (/ctrl-c to stop/i.test(s.log)) {
      return { tool: 'xctrace', template, instruments, process: { pid: o.pid, ...(o.processName ? { name: o.processName } : {}) }, hostPid: child.pid, ...(o.launched ? { launched: true } : {}) };
    }
    if (s.done) break;
    await sleep(200);
  }
  sessions.delete(key);
  const timedOut = !s.done;
  if (timedOut) { child.kill('SIGINT'); setTimeout(() => { if (!s.done) child.kill('SIGKILL'); }, 5000).unref(); }
  await Promise.race([s.exited, sleep(6000)]);
  if (timedOut) {
    throw new PhoneDockError('Instruments did not start recording in time', 'trace_timeout', 504,
      [`xctrace took more than ${START_TIMEOUT_MS / 1000} s to attach: the Mac is very busy. Try again when it is less loaded.`], s.log.trim().slice(-1500));
  }
  throw xctraceError(s.log, { device: o.device, appId: o.appId, physical: o.physical });
}

/** Stop the recorder without analysis (daemon exit, device gone): SIGINT, then wait up to `waitMs` for it to finish
 *  the file. Never SIGKILLs: a finalizing xctrace killed mid-write leaves a .trace that doesn't open; it exits by
 *  itself once the file is written, even after the daemon is gone. Never throws. */
export async function abortXctrace(key: string, waitMs = 20_000): Promise<void> {
  const s = sessions.get(key); if (!s) return;
  sessions.delete(key);
  if (!s.done) { try { s.child.kill('SIGINT'); } catch { /* gone */ } }
  await Promise.race([s.exited, sleep(waitMs)]);
}

/** SIGINT xctrace (if the time limit hasn't ended it already), wait for the .trace, then summarize it. */
export async function stopXctrace(key: string): Promise<TraceCapture> {
  const s = sessions.get(key);
  if (!s) throw new PhoneDockError('No trace is running on this device', 'not_tracing', 409, ['Start one first.']);
  try {
    if (!s.done) s.child.kill('SIGINT');
    const killer = setTimeout(() => { if (!s.done) s.child.kill('SIGKILL'); }, FINALIZE_TIMEOUT_MS); killer.unref();
    const code = await s.exited;
    clearTimeout(killer);
    if (!existsSync(s.output)) {
      throw new PhoneDockError('Instruments did not save the trace', 'trace_failed', 500, ['Try again with a shorter flow; make sure the app stays running while it is traced.'],
        `xctrace exited ${code}; no ${s.output}\n${s.log.trim().slice(-1500)}`);
    }
    return await analyzeTrace(s.output, s.dir, { pid: s.pid, appId: s.appId, log: s.log });
  } finally { sessions.delete(key); }
}

// ── analysis ────────────────────────────────────────────────────────────────
async function xc(args: string[], timeoutMs = ANALYZE_TIMEOUT_MS) {
  return run(await xctracePath(), args, { env: toolEnv(), allowFail: true, timeoutMs, maxBuffer: 512 * 1024 * 1024 });
}

/** "843.57 ms" / "1.15 s" / "15.00 µs" / "2 min" → milliseconds. */
export function parseDurationMs(s: string): number | undefined {
  const m = /(-?[\d.,]+)\s*(ns|µs|us|ms|s|sec|min|m|h)\b/.exec(s.trim().replace(/ /g, ' '));
  if (!m) return /^0$/.test(s.trim()) ? 0 : undefined;
  const v = Number(m[1].replace(/,/g, ''));
  const f: Record<string, number> = { ns: 1e-6, 'µs': 1e-3, us: 1e-3, ms: 1, s: 1000, sec: 1000, min: 60_000, m: 60_000, h: 3_600_000 };
  return Number.isFinite(v) ? v * f[m[2]] : undefined;
}
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Markdown table → rows of cells (header row first). Ignores the |---| separator. */
export function mdRows(md: string): string[][] {
  const rows: string[][] = [];
  for (const line of md.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|') || /^\|(\s*:?-+:?\s*\|)+$/.test(t)) continue;
    rows.push(t.slice(1, t.endsWith('|') ? -1 : undefined).split('|').map((c) => c.trim()));
  }
  return rows;
}

const HANG_TYPES: Record<string, keyof TraceHangs['byType']> = {
  'severe hang': 'severe', 'hang': 'hang', 'microhang': 'microhang', 'brief unresponsiveness': 'brief', 'potential interaction delay': 'delay',
};
/** `xctrace show --track Hangs --list Hangs --format markdown` → counts by tier (only rows of `pid`, when given). */
export function parseHangsList(md: string, pid?: number): TraceHangs {
  const out: TraceHangs = { count: 0, totalMs: 0, longestMs: 0, byType: { severe: 0, hang: 0, microhang: 0, brief: 0, delay: 0 } };
  const rows = mdRows(md);
  const head = rows[0]?.map((h) => h.toLowerCase()) ?? [];
  const iDur = head.indexOf('duration'), iType = head.indexOf('hang type'), iProc = head.indexOf('process');
  if (iDur < 0) return out;
  for (const r of rows.slice(1)) {
    if (pid !== undefined && iProc >= 0 && /\(\d+\)/.test(r[iProc] ?? '') && !(r[iProc] ?? '').includes(`(${pid})`)) continue;
    const ms = parseDurationMs(r[iDur] ?? ''); if (ms === undefined) continue;
    out.count++; out.totalMs += ms; out.longestMs = Math.max(out.longestMs, ms);
    const t = HANG_TYPES[(r[iType] ?? '').toLowerCase()];
    if (t) out.byType[t]++;
    else if (ms > 2000) out.byType.severe++; else if (ms > 500) out.byType.hang++; else if (ms > 250) out.byType.microhang++; else if (ms > 100) out.byType.brief++; else out.byType.delay++;
  }
  out.totalMs = round1(out.totalMs); out.longestMs = round1(out.longestMs);
  return out;
}

/** `xctrace list tracks --type Process/Thread` → the main thread track of `pid` (or the only main thread). */
export function pickMainThreadTrack(list: string, pid?: number): string | undefined {
  const lines = list.split('\n').map((l) => l.trim()).filter((l) => /\/Main Thread\b/.test(l));
  return (pid !== undefined ? lines.find((l) => l.includes(`(${pid})/Main Thread`)) : undefined) ?? (lines.length === 1 || pid === undefined ? lines[0] : undefined);
}

const ENTRY = /^(start|main|_main|UIApplicationMain|static .*\.\$main\(\)|static App\.main\(\)|.*\.main\(\))$/;
/** An inverted call tree of one thread (`--arrange-columns "Weight|Self Weight|Symbol Names|Library Name"`, markdown)
 *  → the thread's total weight and its heaviest leaf functions (one level below the thread row). */
export function parseInvertedTree(md: string, n = TOP_N, opts: { skipEntryPoints?: boolean } = {}): { threadMs: number | null; top: TraceHotspot[] } {
  const rows = mdRows(md);
  const head = rows[0]?.map((h) => h.toLowerCase()) ?? [];
  const iLvl = head.indexOf('tree level'), iW = head.indexOf('weight'), iSym = head.indexOf('symbol names'), iLib = head.indexOf('library name');
  if (iLvl < 0 || iW < 0 || iSym < 0) return { threadMs: null, top: [] };
  let threadLevel = -1; let threadMs: number | null = null; const top: TraceHotspot[] = []; const seen = new Set<string>();
  for (const r of rows.slice(1)) {
    const lvl = Number(r[iLvl]); if (!Number.isFinite(lvl)) continue;
    const sym = r[iSym] ?? '';
    if (threadLevel < 0) {
      if (/^Main Thread\b/.test(sym)) { threadLevel = lvl; threadMs = parseDurationMs((r[iW] ?? '').split('\t')[0]) ?? null; }
      continue;
    }
    if (lvl <= threadLevel) break;
    if (lvl !== threadLevel + 1) continue;
    const ms = parseDurationMs((r[iW] ?? '').split('\t')[0]); if (ms === undefined || ms <= 0) continue;
    if (opts.skipEntryPoints && ENTRY.test(sym)) continue;
    const lib = iLib >= 0 ? r[iLib] || undefined : undefined;
    const k = `${sym}|${lib ?? ''}`; if (seen.has(k)) continue; seen.add(k);
    top.push({ symbol: sym.length > 100 ? sym.slice(0, 99) + '…' : sym, ...(lib ? { library: lib } : {}), ms: round1(ms), pct: threadMs ? round1((ms / threadMs) * 100) : 0 });
  }
  top.sort((a, b) => b.ms - a.ms);
  return { threadMs: threadMs === null ? null : round1(threadMs), top: top.slice(0, n) };
}

/** Triage markdown for the summary: the per-hang sections only (the counts are in `hangs`). Empty sections are
 *  dropped, the CPU-usage table becomes one line (busy vs. waiting main thread), the profile loses its process and
 *  thread rows, and the trace path in the suggested `xctrace show` command is written as <trace>; capped on a line
 *  break. The full report stays in triage.md. */
export function compactTriage(md: string, cap = TRIAGE_CAP): string {
  const lines = md.split('\n');
  const first = lines.findIndex((l) => /^=+\s*Hang #\d+/.test(l.trim()));
  if (first < 0) return /Hang #|Hangs By Duration/.test(md) || /No Data/.test(md) ? 'No hangs in this trace.' : md.trim().slice(0, cap);
  const out: string[] = [];
  for (let i = first; i < lines.length; i++) {
    const l = lines[i]; const tl = l.trim();
    if (/^Summary of .*: N\/A$/.test(tl)) continue;
    if (/^CPU Usage of Main Thread/.test(tl)) {   // header, column names, "* All *  97.7%  10.0%  100.0%  11.4%"
      let j = i + 1; while (j < lines.length && lines[j].trim() && !/^\* All \*/.test(lines[j].trim())) j++;
      const avg = /^\* All \*\s+([\d.]+%)/.exec(lines[j]?.trim() ?? '')?.[1];
      if (avg) out.push(`Main-thread CPU during the hang: avg ${avg} (high = busy computing; low = blocked/waiting)`);
      i = j; continue;
    }
    if (/^Run `xctrace show .*--summary "Summary: CPU Usage"/.test(tl)) continue;
    if (/^\|[^|]*\|[12]\|/.test(tl)) continue;   // profile rows 1–2: the process and the thread (already known)
    out.push(l);
  }
  let t = out.join('\n').replace(/--input "[^"]*"/g, '--input <trace>').replace(/\n{3,}/g, '\n\n').trim();
  if (t.length > cap) { const cut = t.lastIndexOf('\n', cap); t = `${t.slice(0, cut > cap / 2 ? cut : cap)}\n… (truncated; full report in triage.md)`; }
  return t;
}
/** "Trace Duration: 15.58 s" from the triage report. */
export function triageDurationSec(md: string): number | undefined {
  const m = /Trace Duration:\s*([^\n]+)/i.exec(md); const ms = m ? parseDurationMs(m[1]) : undefined;
  return ms === undefined ? undefined : round1(ms / 1000);
}

/** Check the .trace opens (`toc`) and build the iOS part of the summary. */
export async function analyzeTrace(trace: string, dir: string, o: { pid?: number; appId: string; log?: string }): Promise<TraceCapture> {
  const files: Record<string, string> = { trace, log: join(dir, 'xctrace.log') };
  const notes: string[] = [];
  const toc = await xc(['toc', trace]);
  if (toc.code !== 0) {
    throw new PhoneDockError('The trace was saved but does not open', 'trace_invalid', 500, ['Record again; keep the app running until the trace stops.'], `xctrace toc ${trace} exited ${toc.code}: ${(toc.stderr || toc.stdout).trim().slice(0, 1200)}`);
  }
  writeFileSync(join(dir, 'toc.txt'), toc.stdout); files.toc = join(dir, 'toc.txt');
  const hasHangs = /^Hangs\b/m.test(toc.stdout), hasTP = /^Time Profiler\b/m.test(toc.stdout);
  const proc = o.pid !== undefined ? ['--process', String(o.pid)] : [];
  const [triage, hangsList, tracks] = await Promise.all([
    hasHangs && hasTP ? xc(['triage', trace, '--style', 'hangs', '--format', 'markdown', '--limit', '5', ...proc]) : undefined,
    hasHangs ? xc(['show', trace, '--track', 'Hangs', '--list', 'Hangs', '--format', 'markdown']) : undefined,
    hasTP ? xc(['list', 'tracks', '--type', 'Process/Thread', '--input', trace]) : undefined,
  ]);
  let triageMd: string | null = null; let durationSec: number | undefined; let triageNoProcess = false;
  if (triage?.code === 0) {
    writeFileSync(join(dir, 'triage.md'), triage.stdout); files.triage = join(dir, 'triage.md');
    triageMd = compactTriage(triage.stdout); durationSec = triageDurationSec(triage.stdout);
  } else if (triage) {
    const msg = (triage.stderr || triage.stdout).trim();
    if (/Tracks available at this level/i.test(msg)) triageNoProcess = true;   // the process has no samples in the trace (idle)
    else notes.push(`xctrace triage failed: ${msg.split('\n').slice(-1)[0]?.slice(0, 200)}`);
  }
  else notes.push('No hangs triage: the trace has no Hangs + Time Profiler instruments.');
  let hangs: TraceHangs | null = null;
  if (hangsList?.code === 0) hangs = parseHangsList(hangsList.stdout, o.pid);
  else if (hangsList) notes.push('Could not read the Hangs list.');
  if (triageNoProcess) { if (hangs && !hangs.count) triageMd = 'No hangs in this trace.'; else notes.push('xctrace triage found no samples of the app to report on.'); }
  let hotspots: TraceHotspot[] = []; let appHotspots: TraceHotspot[] = []; let mainThreadMs: number | null = null;
  const track = tracks?.code === 0 ? pickMainThreadTrack(tracks.stdout, o.pid) : undefined;
  let idle = hasTP && tracks?.code === 0 && !track;   // Time Profiler samples running threads only: no track = never ran
  if (track) {
    const base = ['show', trace, '--track', track, '--calltree', 'Profile', '--function', 'invert-calltree', '--format', 'markdown',
      '--hide-heaviest-stack', '--hide-node-ids', '--arrange-columns', 'Weight|Self Weight|Symbol Names|Library Name'];
    const [all, own] = await Promise.all([xc(base), xc([...base, '--function', 'hide-system-libraries'])]);
    if (all.code === 0) { const p = parseInvertedTree(all.stdout); hotspots = p.top; mainThreadMs = p.threadMs; idle = /^\s*No Data\s*$/m.test(all.stdout); }
    else notes.push('Could not read the main-thread call tree.');
    if (own.code === 0) appHotspots = parseInvertedTree(own.stdout, TOP_N, { skipEntryPoints: true }).top;
  } else if (hasTP && !idle) notes.push('Could not list the trace’s threads.');
  if (idle) {
    mainThreadMs = 0;
    notes.push(`The main thread of ${o.appId} used no CPU while tracing (idle). Drive the slow flow between start and stop.`);
  }
  if (!appHotspots.length && hotspots.length) notes.push('No main-thread time in the app’s own code (system frameworks only, or the binary has no symbols).');
  const err = o.log?.split('\n').find((l) => /\[error\]/i.test(l) && !/recovery suggestion/i.test(l));
  if (err) notes.push(`xctrace reported: ${err.replace(/^[\s*]+/, '').slice(0, 200)}`);
  return { files, ...(durationSec !== undefined ? { durationSec } : {}), hangs, mainThreadMs, hotspots, appHotspots, frames: null, triage: triageMd, notes };
}

/** `launchctl list` inside a simulator → the pid of the app's UIKitApplication job (undefined: not running). */
export function parseLaunchctlPid(out: string, appId: string): number | undefined {
  for (const line of out.split('\n')) {
    const m = /^(\d+)\s+\S+\s+UIKitApplication:([^[\s]+)\[/.exec(line.trim());
    if (m && m[2] === appId) return Number(m[1]);
  }
  return undefined;
}
