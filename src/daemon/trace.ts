// Performance traces, one per device: start → (the agent drives the app) → stop → a small summary with the same keys
// every time, so "before the fix" and "after the fix" diff cleanly. Backends record (xctrace / perfetto, see
// src/backends/ios-trace.ts and android-trace.ts); this module owns the lifecycle: the time limit (clamped, also
// enforced by the recorder itself), one trace per device, Activity events, summary.json, the comparison with the
// previous run, stopping on daemon exit and cleaning up a recorder a crashed daemon left behind.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from '../core/paths.ts';
import {
  PhoneDockError, type Backend, type Device, type TraceCapture, type TraceComparison, type TraceMetrics, type TraceStarted, type TraceSummary,
} from '../core/types.ts';
import { emit, getBackend, logAction, safeId, splitId, withTimeout } from './core.ts';

export const TRACE_DEFAULT_SEC = 60;
export const TRACE_MIN_SEC = 2;
export const TRACE_MAX_SEC = 600;      // hard cap
export const DEFAULT_TOP = 5;
export const DEFAULT_TRIAGE_CHARS = 1200;
/** With default top/triageChars the summary JSON is kept under this many bytes:
 *  hot spots give way first (down to 3 each), then the triage excerpt (the full report is triage.md). */
export const SUMMARY_BUDGET = 3500;
let lastIdMs = 0;
const APP_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

/** Seconds to record: default 60, clamped to [2, 600]. Anything that isn't a positive number means the default. */
export function clampTimeLimit(v: unknown): number {
  if (v === undefined || v === null || v === '') return TRACE_DEFAULT_SEC;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return TRACE_DEFAULT_SEC;
  return Math.min(TRACE_MAX_SEC, Math.max(TRACE_MIN_SEC, Math.round(n)));
}

export interface TraceRequest { appId: string; template?: string; timeLimitSec: number; launch?: boolean }
export interface TraceState {
  traceId: string; deviceId: string; device: string; platform: Device['platform']; appId: string; owner: string; dir: string;
  requestedTemplate?: string; timeLimitSec: number; startedAt: string; startedMs: number;
  started?: TraceStarted; timer?: NodeJS.Timeout; stopping?: Promise<Finished>;
}
interface Finished { st: TraceState; capture: TraceCapture; endedAt: string; reason: string | null }
export interface TraceResult { ok: true; traceId: string; text: string; summary: TraceSummary }
export interface StopOptions { top?: number; triageChars?: number; compareTo?: string }

export const traces = new Map<string, TraceState>();
/** Traces the time limit (or a shutdown) ended before the caller asked: handed to the caller's next stop. */
const unclaimed = new Map<string, Finished>();

const activeFile = (st: TraceState) => join(st.dir, 'active.json');
const traceRoot = (deviceId: string) => stateDir('traces', safeId(deviceId));
/** Trace files are big (Time Profiler ≈ 10–20 MB for 10 s on a simulator, App Launch ≈ 200 MB): the newest this many
 *  traces per device keep theirs; older ones keep summary.json, summary.txt and triage.md (still compared and listed). */
export const KEEP_TRACE_FILES = 10;

/** Status for GET /v1/devices/:id/trace. */
export function traceStatus(deviceId: string): Record<string, unknown> {
  const st = traces.get(deviceId);
  if (st) return { active: true, traceId: st.traceId, appId: st.appId, template: st.started?.template ?? st.requestedTemplate ?? null, startedAt: st.startedAt, timeLimitSec: st.timeLimitSec, owner: st.owner, ready: !!st.started, dir: st.dir };
  const u = unclaimed.get(deviceId);
  return { active: false, ...(u ? { finished: { traceId: u.st.traceId, appId: u.st.appId, endedAt: u.endedAt, reason: u.reason } } : {}) };
}

/** Start a trace (resolves once the recorder is recording). 409 trace_active when one is running. */
export async function beginTrace(d: Pick<Device, 'id' | 'name' | 'platform'>, b: Backend, nid: string, req: TraceRequest, owner: string): Promise<Record<string, unknown>> {
  if (!b.startTrace || !b.stopTrace) throw new PhoneDockError('This device can’t record performance traces', 'not_supported', 501, ['Use an iOS simulator, an iPhone, an Android emulator or an Android phone.'], `${b.id} has no startTrace`);
  if (!APP_RE.test(req.appId)) throw new PhoneDockError('The app id is invalid', 'bad_request', 400, ['Pass the bundle id (iOS) or package name (Android), e.g. com.example.app.'], `Bad app id ${JSON.stringify(req.appId)}`);
  const cur = traces.get(d.id);
  if (cur) throw new PhoneDockError('A trace is already running on this device', 'trace_active', 409, ['Stop it first (stop_trace / phonedock trace stop), then start a new one.'], `Tracing ${cur.appId} since ${cur.startedAt} (trace ${cur.traceId}, owner ${cur.owner})`);
  const timeLimitSec = clampTimeLimit(req.timeLimitSec);
  const idMs = lastIdMs = Math.max(Date.now(), lastIdMs + 1);   // ids sort in start order, even two in one millisecond
  const traceId = `${new Date(idMs).toISOString().replace(/[:.]/g, '-').replace(/Z$/, '')}-${randomBytes(2).toString('hex')}`;
  const dir = stateDir('traces', safeId(d.id), traceId);
  const st: TraceState = {
    traceId, deviceId: d.id, device: d.name, platform: d.platform, appId: req.appId, owner, dir, requestedTemplate: req.template?.trim() || undefined,
    timeLimitSec, startedAt: new Date().toISOString(), startedMs: Date.now(),
  };
  traces.set(d.id, st);   // reserve before the slow backend call: a racing start gets 409
  unclaimed.delete(d.id);
  try {
    st.started = await withTimeout(b.startTrace(nid, dir, { appId: req.appId, template: st.requestedTemplate, timeLimitSec, launch: req.launch }), 210_000, `${b.id}.startTrace`);
  } catch (e) {
    traces.delete(d.id);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }   // a start that failed leaves nothing usable
    const pe = e as PhoneDockError;
    logAction(d.id, owner, { action: 'trace.start_failed', appId: req.appId, error: [pe.message, pe.hints?.[0]].filter(Boolean).join(' ').slice(0, 300) });
    throw e;
  }
  st.startedAt = new Date().toISOString(); st.startedMs = Date.now();
  try { writeFileSync(activeFile(st), JSON.stringify({ traceId, deviceId: d.id, daemonPid: process.pid, hostPid: st.started.hostPid ?? null, startedAt: st.startedAt, timeLimitSec })); } catch { /* */ }
  // The recorder stops itself at the limit; this collects the result (a few seconds later, so the file is complete).
  st.timer = setTimeout(() => { void stopTraceFor(d.id, `time limit (${timeLimitSec} s) reached`).catch(() => undefined); }, (timeLimitSec + 3) * 1000);
  st.timer.unref();
  const info = {
    ok: true, active: true, traceId, appId: req.appId, tool: st.started.tool, template: st.started.template, instruments: st.started.instruments ?? [],
    process: st.started.process ?? null, launched: !!st.started.launched, startedAt: st.startedAt, timeLimitSec, dir,
  };
  logAction(d.id, owner, { action: 'trace.start', appId: req.appId, template: st.started.template, timeLimitSec });
  emit('trace', { deviceId: d.id, ...info });
  return info;
}

/** Stop (or collect) the device's trace. Caller stops (no `reason`) also get a trace the time limit already ended.
 *  Resolves undefined when there is nothing to stop or collect. Throws when the backend fails to stop. */
export async function stopTraceFor(deviceId: string, reason?: string, opts: StopOptions = {}): Promise<TraceResult | undefined> {
  const st = traces.get(deviceId);
  if (!st) {
    const u = reason ? undefined : unclaimed.get(deviceId);
    if (!u) return undefined;
    unclaimed.delete(deviceId);
    return finish(u, opts);
  }
  if (!st.stopping) {
    if (st.timer) clearTimeout(st.timer);
    st.stopping = (async () => {
      const { backend, nativeId } = splitId(deviceId);
      const b = getBackend(backend);
      let capture: TraceCapture;
      try { capture = await withTimeout(b.stopTrace!(nativeId), 280_000, `${b.id}.stopTrace`); }
      catch (e) {
        traces.delete(deviceId); rmQuiet(activeFile(st));
        const pe = e as PhoneDockError;
        logAction(deviceId, st.owner, { action: 'trace.stop_failed', appId: st.appId, error: [pe.message, pe.hints?.[0]].filter(Boolean).join(' ').slice(0, 300) });
        emit('trace', { deviceId, active: false, traceId: st.traceId, error: pe.message });
        throw e;
      }
      traces.delete(deviceId); rmQuiet(activeFile(st));
      return { st, capture, endedAt: new Date().toISOString(), reason: reason ?? null };
    })();
    st.stopping.then((f) => { if (f.reason) { unclaimed.set(deviceId, f); void finish(f, {}); } }, () => undefined);
  }
  const f = await st.stopping;
  if (reason) return undefined;          // auto-stop: the summary is written by the .then above
  unclaimed.delete(deviceId);
  return finish(f, opts);
}

/** Build + save the summary (summary.json / summary.txt), log Activity once per trace. */
const logged = new Set<string>();
async function finish(f: Finished, opts: StopOptions): Promise<TraceResult> {
  const prev = opts.compareTo === 'none' ? undefined : findPrevious(f.st.deviceId, f.st.appId, f.st.started?.template ?? '', f.st.traceId, opts.compareTo);
  const summary = buildSummary(f, { top: opts.top, triageChars: opts.triageChars, previous: prev });
  const text = summaryText(summary);
  try {
    writeFileSync(summary.files.summary, JSON.stringify(summary, null, 2));
    writeFileSync(join(f.st.dir, 'summary.txt'), text + '\n');
  } catch { /* */ }
  pruneTraceFiles(f.st.deviceId);
  if (!logged.has(f.st.traceId)) {
    logged.add(f.st.traceId);
    logAction(f.st.deviceId, f.st.owner, { action: 'trace.stop', appId: f.st.appId, template: summary.template, durationSec: summary.metrics.durationSec, summary: headline(summary), ...(f.reason ? { reason: f.reason } : {}) });
    emit('trace', { deviceId: f.st.deviceId, active: false, traceId: f.st.traceId, metrics: summary.metrics, reason: f.reason });
  }
  return { ok: true, traceId: summary.traceId, text, summary };
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const pick = (o: Record<string, string>, keys: string[]) => Object.fromEntries(keys.filter((k) => o[k]).map((k) => [k, o[k]]));
export function buildSummary(f: Finished, o: { top?: number; triageChars?: number; previous?: TraceSummary } = {}): TraceSummary {
  const { st, capture: c } = f;
  const top = Math.max(0, Math.min(Math.round(o.top ?? DEFAULT_TOP), 25));
  const cap = Math.max(0, Math.min(Math.round(o.triageChars ?? DEFAULT_TRIAGE_CHARS), 20_000));
  const wall = Math.min(Date.parse(f.endedAt) - st.startedMs, st.timeLimitSec * 1000) / 1000;
  const fr = c.frames ?? null; const h = c.hangs ?? null;
  const metrics: TraceMetrics = {
    durationSec: r1(c.durationSec ?? Math.max(0, wall)),
    hangs: h ? h.count : null, hangsTotalMs: h ? h.totalMs : null, hangsLongestMs: h ? h.longestMs : null,
    mainThreadMs: c.mainThreadMs ?? null, topHotspotMs: c.hotspots?.[0]?.ms ?? null, topAppHotspotMs: c.appHotspots?.[0]?.ms ?? null,
    frames: fr ? fr.total : null, jankyFrames: fr ? fr.janky : null, jankyPct: fr ? fr.jankyPct : null,
    frameP50Ms: fr?.p50Ms ?? null, frameP90Ms: fr?.p90Ms ?? null, frameP95Ms: fr?.p95Ms ?? null, frameP99Ms: fr?.p99Ms ?? null,
  };
  const triage = c.triage ? (cap ? trimLines(c.triage, cap) : null) : null;
  const summary: TraceSummary = {
    v: 1, traceId: st.traceId, deviceId: st.deviceId, device: st.device, platform: st.platform, appId: st.appId,
    tool: st.started?.tool ?? (st.platform === 'android' ? 'perfetto' : 'xctrace'), template: st.started?.template ?? st.requestedTemplate ?? '',
    startedAt: st.startedAt, endedAt: f.endedAt, timeLimitSec: st.timeLimitSec, stopReason: f.reason,
    metrics, hangs: h, hotspots: (c.hotspots ?? []).slice(0, top), appHotspots: (c.appHotspots ?? []).slice(0, top), frames: fr, triage,
    compare: o.previous ? compareMetrics(o.previous, metrics) : null,
    files: { dir: st.dir, ...pick(c.files, ['trace', 'triage', 'gfxinfo']), summary: join(st.dir, 'summary.json') },
    notes: [...(st.started?.instruments?.length ? [`Added to the template so hangs and hot spots can be read: ${st.started.instruments.join(', ')}.`] : []), ...(st.started?.launched ? ['The app was launched for this trace.'] : []), ...(c.notes ?? [])],
  };
  if (o.top === undefined && o.triageChars === undefined) fitBudget(summary, SUMMARY_BUDGET);
  return summary;
}

/** Cut `t` to at most `cap` chars on a line break, saying where the rest is. */
function trimLines(t: string, cap: number): string {
  if (t.length <= cap) return t;
  const cut = t.lastIndexOf('\n', cap);
  return `${t.slice(0, cut > cap / 2 ? cut : cap)}\n… (truncated; full report in triage.md)`;
}

function fitBudget(s: TraceSummary, budget: number): void {
  const over = () => Buffer.byteLength(JSON.stringify(s)) - budget;
  while (over() > 0 && (s.hotspots.length > 3 || s.appHotspots.length > 3)) {
    if (s.appHotspots.length >= s.hotspots.length) s.appHotspots.pop(); else s.hotspots.pop();
  }
  if (over() > 0 && s.triage) { const keep = s.triage.length - over() - 50; s.triage = keep >= 300 ? trimLines(s.triage, keep) : null; }
}

/** Metric-by-metric before/after for every metric either run measured. */
export function compareMetrics(prev: TraceSummary, cur: TraceMetrics): TraceComparison {
  const changes: TraceComparison['changes'] = {};
  for (const k of Object.keys(cur) as (keyof TraceMetrics)[]) {
    const before = typeof prev.metrics?.[k] === 'number' ? prev.metrics[k] as number : null;
    const after = typeof cur[k] === 'number' ? cur[k] as number : null;
    if (before === null && after === null) continue;
    changes[k] = { before, after, delta: before !== null && after !== null ? Math.round((after - before) * 100) / 100 : null };
  }
  return { traceId: prev.traceId, startedAt: prev.startedAt, changes };
}

/** The newest earlier trace of the same app + template on this device (or the one named by `compareTo`). */
export function findPrevious(deviceId: string, appId: string, template: string, exceptId: string, compareTo?: string): TraceSummary | undefined {
  const root = traceRoot(deviceId);
  const read = (id: string): TraceSummary | undefined => { try { return JSON.parse(readFileSync(join(root, id, 'summary.json'), 'utf8')) as TraceSummary; } catch { return undefined; } };
  if (compareTo) {
    const s = read(compareTo);
    if (!s) throw new PhoneDockError('That earlier trace was not found', 'not_found', 404, ['Pass a traceId from an earlier stop (or from `phonedock trace ls`).'], `No summary for trace ${compareTo} on ${deviceId}`);
    return s;
  }
  let ids: string[] = []; try { ids = readdirSync(root).filter((x) => x < exceptId).sort().reverse(); } catch { /* */ }
  for (const id of ids.slice(0, 200)) { const s = read(id); if (s && s.appId === appId && s.template === template) return s; }
  return undefined;
}

/** Delete the trace files (not the summaries) of all but the newest `keep` traces of a device. Returns what it removed. */
export function pruneTraceFiles(deviceId: string, keep = KEEP_TRACE_FILES): string[] {
  const root = traceRoot(deviceId); const removed: string[] = [];
  let ids: string[] = []; try { ids = readdirSync(root).sort().reverse(); } catch { return removed; }
  for (const id of ids.slice(keep)) {
    if (existsSync(join(root, id, 'active.json'))) continue;   // still recording
    for (const f of ['trace.trace', 'trace.perfetto-trace']) {
      const file = join(root, id, f);
      if (existsSync(file)) { try { rmSync(file, { recursive: true, force: true }); removed.push(file); } catch { /* */ } }
    }
  }
  return removed;
}

/** Recent traces of a device, newest first (GET /v1/devices/:id/traces). */
export function listTraces(deviceId: string, limit = 20): Pick<TraceSummary, 'traceId' | 'appId' | 'template' | 'startedAt' | 'metrics' | 'files'>[] {
  const root = traceRoot(deviceId); let ids: string[] = [];
  try { ids = readdirSync(root).sort().reverse(); } catch { /* */ }
  const out: Pick<TraceSummary, 'traceId' | 'appId' | 'template' | 'startedAt' | 'metrics' | 'files'>[] = [];
  for (const id of ids) {
    if (out.length >= limit) break;
    try { const s = JSON.parse(readFileSync(join(root, id, 'summary.json'), 'utf8')) as TraceSummary; out.push({ traceId: s.traceId, appId: s.appId, template: s.template, startedAt: s.startedAt, metrics: s.metrics, files: s.files }); } catch { /* still running / no summary */ }
  }
  return out;
}

// ── text ────────────────────────────────────────────────────────────────────
const ms = (n: number | null | undefined) => (n === null || n === undefined ? '–' : n >= 1000 ? `${r1(n / 1000)} s` : `${Math.round(n)} ms`);
function headline(s: TraceSummary): string {
  const m = s.metrics;
  if (s.platform === 'android' || s.frames) return m.frames === null ? 'no frame stats' : `${m.frames} frames, ${m.jankyPct}% janky, p90 ${ms(m.frameP90Ms)}`;
  return m.hangs === null ? `main thread ${ms(m.mainThreadMs)}` : `${m.hangs} hang${m.hangs === 1 ? '' : 's'}${m.hangs ? ` (longest ${ms(m.hangsLongestMs)})` : ''}, main thread ${ms(m.mainThreadMs)}`;
}
/** Compact, agent-readable rendering of a summary (CLI / MCP). */
export function summaryText(s: TraceSummary): string {
  const m = s.metrics; const L: string[] = [];
  L.push(`Trace ${s.traceId}: ${s.appId} on ${s.device} — ${s.tool} "${s.template}", ${m.durationSec} s (limit ${s.timeLimitSec} s${s.stopReason ? `; ended: ${s.stopReason}` : ''})`);
  if (s.hangs) {
    const t = s.hangs.byType;
    L.push(`Hangs: ${s.hangs.count}${s.hangs.count ? ` (longest ${ms(s.hangs.longestMs)}, total ${ms(s.hangs.totalMs)})` : ''} · severe ${t.severe} · hang ${t.hang} · microhang ${t.microhang} · brief ${t.brief} · delay ${t.delay}`);
  }
  if (m.mainThreadMs !== null) L.push(`Main thread: ${ms(m.mainThreadMs)} of CPU samples`);
  const hs = (list: typeof s.hotspots) => list.map((h, i) => `${i + 1}. ${h.symbol}${h.library ? ` [${h.library}]` : ''} ${ms(h.ms)} (${h.pct}%)`).join('  ');
  if (s.hotspots.length) L.push(`Main-thread hot spots (self time): ${hs(s.hotspots)}`);
  if (s.appHotspots.length) L.push(`Your code on the main thread (with the system calls it makes): ${hs(s.appHotspots)}`);
  if (s.frames) {
    const f = s.frames;
    L.push(`Frames: ${f.total} rendered, ${f.janky} janky (${f.jankyPct}%) · p50 ${ms(f.p50Ms)} · p90 ${ms(f.p90Ms)} · p95 ${ms(f.p95Ms)} · p99 ${ms(f.p99Ms)} · missed vsync ${f.missedVsync ?? '–'} · slow UI thread ${f.slowUiThread ?? '–'} · deadline missed ${f.deadlineMissed ?? '–'}`);
  }
  if (s.compare) {
    const ch = Object.entries(s.compare.changes).filter(([k, v]) => k !== 'durationSec' && v.before !== v.after);
    L.push(`vs ${s.compare.traceId}: ${ch.length ? ch.map(([k, v]) => `${k} ${v.before ?? '–'} → ${v.after ?? '–'}${v.delta !== null ? ` (${v.delta > 0 ? '+' : ''}${v.delta})` : ''}`).join(' · ') : 'no metric changed'}`);
  }
  L.push(`Metrics: ${JSON.stringify(m)}`);
  if (s.triage) L.push(`Hangs triage (xctrace triage --style hangs; <trace> = the trace below):\n${s.triage}`);
  if (s.notes.length) L.push(`Notes: ${s.notes.join(' ')}`);
  const { dir, ...rest } = s.files;
  L.push(`Trace: ${s.files.trace ?? '–'}`);
  L.push(`Files in ${dir ?? '–'}: ${Object.entries(rest).filter(([k]) => k !== 'trace').map(([, v]) => v.split('/').pop()).join(', ')}`);
  return L.join('\n');
}

// ── daemon exit / crashed-daemon leftovers ──────────────────────────────────
/** Daemon exit: stop every recorder now (no summary). The .trace / device file stays where it was. */
export async function abortAllTraces(why: string): Promise<void> {
  await Promise.allSettled([...traces.values()].map(async (st) => {
    if (st.timer) clearTimeout(st.timer);
    try {
      const { backend, nativeId } = splitId(st.deviceId);
      const b = getBackend(backend);
      if (b.abortTrace) await withTimeout(b.abortTrace(nativeId), 22_000, `${b.id}.abortTrace`);
    } catch { /* */ }
    traces.delete(st.deviceId); rmQuiet(activeFile(st));
    logAction(st.deviceId, st.owner, { action: 'trace.stop', appId: st.appId, reason: why, summary: 'stopped without a summary' });
  }));
}

/** At daemon start: a recorder whose daemon is gone (killed hard) is stopped (SIGINT: xctrace finalizes its file). */
export function reapOrphanTraces(): string[] {
  const reaped: string[] = [];
  let devs: string[] = []; try { devs = readdirSync(stateDir('traces')); } catch { return reaped; }
  for (const dv of devs) {
    let ids: string[] = []; try { ids = readdirSync(join(stateDir('traces'), dv)); } catch { continue; }
    for (const id of ids) {
      const f = join(stateDir('traces'), dv, id, 'active.json');
      if (!existsSync(f)) continue;
      let a: { daemonPid?: number; hostPid?: number | null } = {};
      try { a = JSON.parse(readFileSync(f, 'utf8')); } catch { rmQuiet(f); continue; }
      if (a.daemonPid && a.daemonPid !== process.pid && alive(a.daemonPid)) continue;   // another daemon (port) owns it
      if (a.hostPid && alive(a.hostPid) && /xctrace/.test(spawnSync('ps', ['-o', 'comm=', '-p', String(a.hostPid)], { encoding: 'utf8' }).stdout ?? '')) {
        try { process.kill(a.hostPid, 'SIGINT'); reaped.push(`${id} (xctrace pid ${a.hostPid})`); } catch { /* */ }
      }
      rmQuiet(f);
    }
  }
  return reaped;
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } }
function rmQuiet(p: string) { try { rmSync(p, { force: true }); } catch { /* */ } }
