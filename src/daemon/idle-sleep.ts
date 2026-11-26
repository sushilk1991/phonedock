// Idle sleep (docs/API.md): an idle Android emulator PhoneDock created is stopped the ordinary way (memory freed) and
// marked asleep; the next request that needs it boots it the ordinary way, usually where it left off, else fresh with its
// apps and data. Every failure or race ends one of those ways, or as a request that fails and is safe to retry. Only
// *use* resets the idle clock or wakes a phone; *observe* (inventory, the app's polling, live views) never does.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';
import { DEFAULT_PORT, stateDir } from '../core/paths.ts';
import { PhoneDockError, type Backend, type BootOptions, type Device, type DeviceSleep, type SleepState, type WakeReport } from '../core/types.ts';
import {
  assertDeviceAllowed, backends, createdByPhoneDock, deviceDecorators, deviceJobRunning, emit, expectedStops, getBackend, getDevice, invalidateDevices, isDeviceAllowed,
  leaseView, listDevices, logAction, pendingHandoff, recordings, safeId, splitId, stopStreamsFor, uiCache, watched, withTransition,
} from './core.ts';
import { traces } from './trace.ts';
import { proxyManager } from './proxies.ts';
import { sleep } from '../core/exec.ts';
import type { Ctx } from './http.ts';

// ── the setting ─────────────────────────────────────────────────────────────
/** What the setting can be: never (null), 10, 15, 30 or 60 minutes. */
export const IDLE_SLEEP_CHOICES: readonly (number | null)[] = [null, 600, 900, 1800, 3600];
/** The default until someone chooses: null, off (0.7.0 ships it off; 15 minutes is the suggested choice). Keep the
 *  default sentence in docs/API.md in step. */
export const DEFAULT_IDLE_SLEEP_SEC: number | null = null;
let defaultSec: number | null = DEFAULT_IDLE_SLEEP_SEC;

/** One sleeper: only the app's service (the default port), or one a test opts in with PHONEDOCK_IDLE_SLEEP set to a
 *  duration, puts phones to sleep and wakes them. Any other service treats a sleeping phone as stopped; booting it the
 *  ordinary way is safe (the backend's disk rule). */
export function isSleeper(port = DEFAULT_PORT, env = process.env.PHONEDOCK_IDLE_SLEEP): boolean {
  return port === 47420 || typeof parseIdleDuration(env?.trim() || undefined) === 'number';
}
let sleeper = isSleeper();

/** `off` / `never` / `0` → null (never); `90`, `90s`, `10m`, `1.5h` → seconds. undefined when it is neither. */
export function parseIdleDuration(v: unknown): number | null | undefined {
  if (v === null || v === false) return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? (v === 0 ? null : Math.round(v)) : undefined;
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  if (['off', 'never', 'none', '0'].includes(s)) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)?$/.exec(s);
  if (!m) return undefined;
  const unit = (m[2] ?? 's')[0];
  const sec = Math.round(Number(m[1]) * (unit === 'h' ? 3600 : unit === 'm' ? 60 : 1));
  return sec > 0 ? sec : null;
}

export interface IdleSleepSetting {
  timeoutSec: number | null;
  /** env: PHONEDOCK_IDLE_SLEEP (tests) overrides the saved setting; setting: saved; default: never set. */
  source: 'env' | 'setting' | 'default';
  /** The saved value, when the environment overrides it. */
  saved?: number | null;
}
const settingFile = () => join(stateDir(), 'idle-sleep.json');
let warnedEnv = false;
/** Read every time (a tiny file): another daemon on this state dir (the app's, or a test one) may have saved it. */
function readSaved(): { timeoutSec: number | null } | null {
  try {
    const j = JSON.parse(readFileSync(settingFile(), 'utf8')) as { timeoutSec?: unknown };
    return j && (j.timeoutSec === null || IDLE_SLEEP_CHOICES.includes(j.timeoutSec as number)) ? { timeoutSec: j.timeoutSec as number | null } : null;
  } catch { return null; }
}
export function idleSleepSetting(): IdleSleepSetting {
  const file = readSaved();
  const env = process.env.PHONEDOCK_IDLE_SLEEP?.trim();
  if (env) {
    const v = parseIdleDuration(env);
    if (v !== undefined) return { timeoutSec: v, source: 'env', ...(file ? { saved: file.timeoutSec } : {}) };
    if (!warnedEnv) { warnedEnv = true; console.error(`[phonedockd] PHONEDOCK_IDLE_SLEEP=${env} isn't "off" or a duration such as 15m; using the saved setting`); }
  }
  return file ? { timeoutSec: file.timeoutSec, source: 'setting' } : { timeoutSec: defaultSec, source: 'default' };
}
export function setIdleSleep(timeoutSec: number | null): IdleSleepSetting {
  if (!IDLE_SLEEP_CHOICES.includes(timeoutSec)) {
    throw new PhoneDockError('Choose never, 10, 15 or 30 minutes, or 1 hour', 'bad_request', 400, ['Send { "timeoutSec": null | 600 | 900 | 1800 | 3600 } or { "after": "off" | "10m" | "15m" | "30m" | "1h" }.'],
      `Unsupported idle sleep timeout ${JSON.stringify(timeoutSec)}`);
  }
  const f = settingFile(); const tmp = `${f}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;   // one per writer
  writeFileSync(tmp, JSON.stringify({ v: 1, timeoutSec, updatedAt: new Date().toISOString() }, null, 2) + '\n');
  renameSync(tmp, f);
  schedule();
  const s = idleSleepSetting();
  emit('idle-sleep', s);
  invalidateDevices();
  return s;
}

// ── sleep markers (per device, on disk: they outlive the daemon, which the app replaces on every update) ──────────
/** Written just before the stop (a request waits for it, then wakes the phone); the stop adds `state.exitSave` once it
 *  is proven. A marker on a running phone that no sleep here is stopping is stale: someone else started it. */
export interface SleepMarker { v: 1; since: string; reason: 'idle'; name: string; idleSec: number; state: SleepState }
const markerPath = (id: string) => join(stateDir('devices'), safeId(id), 'sleep.json');
export function readMarker(id: string): SleepMarker | undefined {
  try {
    const j = JSON.parse(readFileSync(markerPath(id), 'utf8')) as SleepMarker;
    return j?.v === 1 && typeof j.since === 'string' && j.state && typeof j.state === 'object' ? j : undefined;
  } catch { return undefined; }   // none, or unreadable: not asleep
}
function writeMarker(id: string, m: SleepMarker) {
  const p = markerPath(id); const tmp = `${p}.${process.pid}.tmp`;
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n');
  renameSync(tmp, p);
}
export function clearMarker(id: string): boolean {
  const had = existsSync(markerPath(id));
  outcomes.delete(id);   // how that sleep's wake came back goes with it
  rmSync(markerPath(id), { force: true });
  return had;
}
export const isSleeping = (id: string) => !!readMarker(id);
/** A sleep of this phone is being decided or its stop is under way (pool acquire waits for it). */
export const sleepInProgress = (id: string) => ops.has(id);
/** Lifecycle and snapshot routes on a sleeping id act only on the device that went to sleep (never a same-named one). */
export async function assertSleepTarget(id: string): Promise<void> {
  const m = readMarker(id);
  if (!m) return;
  const { backend, nativeId } = splitId(id);
  await getBackend(backend).checkSleeping?.(nativeId, m.state);
}

/** Held by boot, restart, shutdown and delete: a wake waits for it, then goes by what it left; the sweep skips it. */
const lifecycles = new Map<string, Promise<void>>();
export async function withLifecycle<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = lifecycles.get(id);
  let release!: () => void;
  const mine = new Promise<void>((r) => { release = r; });
  const tail = (prev ?? Promise.resolve()).then(() => mine);
  lifecycles.set(id, tail);
  try { await prev; return await fn(); }
  finally { release(); if (lifecycles.get(id) === tail) lifecycles.delete(id); }
}

// ── idle clocks ─────────────────────────────────────────────────────────────
let now = () => Date.now();
let daemonStartedAt = now();   // idle clocks start fresh when the daemon starts
const lastUse = new Map<string, number>();
const inflight = new Map<string, number>();
const failures = new Map<string, { at: string; code: string; message: string }>();
/** A sleep in progress: a request calls it off while it decides, or waits for its stop and then wakes the phone. */
interface SleepOp { phase: 'saving' | 'stopping'; cancelled: boolean; settled: Promise<void> }
const ops = new Map<string, SleepOp>();
const wakes = new Map<string, Promise<WakeResult | undefined>>();
/** A wake whose phone booted but didn't read running in time (not_ready): the next request finishes it with this, or
 *  the sweep does once it is `KEEP_OUTCOME_SEC` old (by then a retry isn't coming). */
const outcomes = new Map<string, WakeResult & { keptAt: number; since: string }>();
const KEEP_OUTCOME_SEC = 120;
/** How each phone's last sleep (by its marker's `since`) came back: a request that met that sleep on arrival but
 *  reaches its gate later (a receipt read its body meanwhile) still learns that the phone started fresh. */
const woken = new Map<string, { since: string; w: WakeResult }>();

// Every use also touches a stamp, so use through another service (a test one on another port) counts here too.
const stampPath = (id: string) => join(stateDir('devices'), safeId(id), 'last-use');
const stamped = new Map<string, number>();
function stampUse(id: string, at = now()) {
  if (at - (stamped.get(id) ?? 0) < 10_000) return;
  stamped.set(id, at);
  try {
    const p = stampPath(id);
    mkdirSync(join(p, '..'), { recursive: true });
    if (!existsSync(p)) writeFileSync(p, '');
    utimesSync(p, at / 1000, at / 1000);
  } catch { /* best effort */ }
}
function sharedStamp(id: string): number {
  try { return statSync(stampPath(id), { throwIfNoEntry: false })?.mtimeMs ?? 0; } catch { return 0; }
}
/** A use: the idle clock starts again, and a failed attempt to sleep no longer holds it awake. */
export function touchUse(id: string) {
  lastUse.set(id, now());
  if (failures.delete(id)) invalidateDevices();
  if (canSleep(id)) stampUse(id);
}
function lastUseOf(id: string): number { return Math.max(daemonStartedAt, lastUse.get(id) ?? 0, sharedStamp(id)); }

const sleepCapable = (b: Backend | undefined) => !!(b?.prepareSleep && b.stopForSleep && b.wakeFromSleep);
function canSleep(id: string): boolean {
  const i = id.indexOf(':');
  return sleepCapable(i > 0 ? backends.find((x) => x.id === id.slice(0, i)) : undefined);
}
/** Only backends that can sleep: the sweep must not make an idle daemon poll simulators, phones and clouds. */
async function sleepCapableDevices(fresh: boolean): Promise<Device[]> {
  const out: Device[] = [];
  for (const b of backends.filter(sleepCapable)) out.push(...await listDevices(fresh, b.id));
  return out;
}
/** Why a device can't be put to sleep at all, or undefined when it can. */
export function sleepIneligible(d: Pick<Device, 'id' | 'kind' | 'connection'>): string | undefined {
  if (!canSleep(d.id)) return 'its kind of device can’t sleep';
  if (d.kind !== 'virtual' || (d.connection && d.connection !== 'local')) return 'it isn’t a virtual device on this Mac';
  if (!createdByPhoneDock(d.id)) return 'PhoneDock didn’t create it (something else may be using it)';
  if (!isDeviceAllowed(d.id)) return 'this service doesn’t control it';
  return undefined;
}

/** What keeps a running device awake right now, in words (none: it is idle). The backend may add its own reasons. */
export function keepAwakeReasons(id: string): string[] {
  const out: string[] = [];
  if ((inflight.get(id) ?? 0) > 0) out.push('a request is running');
  const lease = leaseView(id);
  if (lease && !lease.stale) out.push(`${lease.owner} holds it`);
  if (pendingHandoff(id)) out.push('a person was asked to do something on it');
  if (recordings.has(id)) out.push('its screen is being recorded');
  if (traces.has(id)) out.push('a performance trace is running');
  if (deviceJobRunning(id)) out.push('a job is running on it');
  if (watched(id)) out.push('its screen is on view');
  return out;
}

/** The decision itself, without the daemon (unit-tested with a fake clock). */
export function idleDue(f: { now: number; timeoutSec: number | null; lastUseAt: number; awake: readonly string[] }): { due: boolean; idleSec: number; sleepsInSec: number | null } {
  if (f.awake.length) return { due: false, idleSec: 0, sleepsInSec: f.timeoutSec };
  const idleSec = Math.max(0, Math.floor((f.now - f.lastUseAt) / 1000));
  if (f.timeoutSec === null) return { due: false, idleSec, sleepsInSec: null };
  return { due: idleSec >= f.timeoutSec, idleSec, sleepsInSec: Math.max(0, f.timeoutSec - idleSec) };
}

// ── use / observe ───────────────────────────────────────────────────────────
export type RequestKind = 'use' | 'observe' | 'control' | 'none';
/** Reads that never need the phone, and the live views (awake only while watched on a lit screen: core.watched). */
const OBSERVE = new Set([
  'GET /v1/devices/:id', 'GET /v1/devices/:id/actions', 'GET /v1/devices/:id/requests/:requestId', 'GET /v1/devices/:id/recording',
  'GET /v1/devices/:id/snapshots', 'GET /v1/devices/:id/info', 'GET /v1/devices/:id/trace', 'GET /v1/devices/:id/traces',
  'GET /v1/devices/:id/frame', 'GET /v1/devices/:id/stream', 'GET /v1/devices/:id/video', 'GET /v1/devices/:id/apps/:appId/data',
  'GET /v1/devices/:id/environment',   // the controls a kind of device supports: from its backend and kind alone
  'GET /v1/devices/:id/proxy',
]);
/** Lifecycle requests deal with a sleeping phone themselves (boot wakes it, shutdown and delete forget its sleep). */
const CONTROL = new Set([
  'POST /v1/devices/:id/boot', 'POST /v1/devices/:id/shutdown', 'POST /v1/devices/:id/restart', 'DELETE /v1/devices/:id',
  'PATCH /v1/devices/:id', 'POST /v1/devices/:id/clone', 'DELETE /v1/devices/:id/lease', 'DELETE /v1/devices/:id/snapshots/:name',
  'POST /v1/devices/:id/window',   // a sleeping phone wakes with its own window, as a stopped one boots with it
  'PUT /v1/devices/:id/proxy', 'DELETE /v1/devices/:id/proxy',   // attach/detach saves now and applies on wake
]);
/** `X-PhoneDock-Observe: 1` on a GET (the app's background reads): never wakes, never counts. Other methods are use. */
export const OBSERVE_HEADER = 'x-phonedock-observe';
export function classifyRequest(method: string, route: string, headers: IncomingHttpHeaders = {}): RequestKind {
  if (!route.startsWith('/v1/devices/:id')) return 'none';
  const key = `${method} ${route}`;
  if (CONTROL.has(key)) return 'control';
  if (OBSERVE.has(key)) return 'observe';
  const h = headers[OBSERVE_HEADER];
  if (method === 'GET' && (h === '1' || h === 'true')) return 'observe';
  return 'use';
}

export interface WakeResult { ms: number; name: string; report: WakeReport }
/** `X-PhoneDock-Woke: 7213; name=Pixel%208` on every response that woke the phone first (or waited for its wake), and
 *  `; fresh=1` when it started fresh instead of where it left off. */
export const WOKE_HEADER = 'X-PhoneDock-Woke';
export const wokeHeader = (w: WakeResult) => `${w.ms}; name=${encodeURIComponent(w.name)}${w.report.resumed ? '' : '; fresh=1'}`;
/** Input routes not aimed at a screen: after a fresh start they go ahead; every other (tap, swipe, back…) is handed back. */
const NOT_SCREEN_INPUT = new Set([
  'POST /v1/devices/:id/apps/:appId/launch', 'POST /v1/devices/:id/clipboard', 'PUT /v1/devices/:id/clipboard',
  'POST /v1/devices/:id/keyboard/hide', 'POST /v1/devices/:id/environment',
]);
/** Requests without a receipt that may act on a screen: a replay's job, and a shell command (`input tap …`, or anything
 *  else written for the screen it had). After a fresh start they are handed back before they run. */
const SCREEN_JOBS = new Set(['POST /v1/devices/:id/replay', 'POST /v1/devices/:id/shell']);

/** Before every request handler (src/daemon/main.ts): a use waits for a sleep in progress and wakes the phone; the
 *  returned function ends it. `receipt`: an input route whose wake runs inside its receipt (Ctx.beforeRun), for a new
 *  execution only (a resent one needs no wake; a failed wake must not become what the receipt answers). */
export async function enterRequest(c: Pick<Ctx, 'params' | 'req' | 'res'> & { owner?: string; beforeRun?: Ctx['beforeRun'] }, method: string, route: string, receipt = false): Promise<(() => void) | undefined> {
  const id = c.params?.id;
  if (!id) return undefined;
  const kind = classifyRequest(method, route, c.req?.headers);
  if (kind === 'observe' || kind === 'none' || !isDeviceAllowed(id)) return undefined;
  if (!sleeper) { if (kind === 'use' && canSleep(id)) stampUse(id); return undefined; }
  if (kind === 'control') return () => touchUse(id);
  touchUse(id);
  inflight.set(id, (inflight.get(id) ?? 0) + 1);
  let left = false;
  const leave = () => {
    if (left) return; left = true;
    const n = (inflight.get(id) ?? 1) - 1;
    if (n > 0) inflight.set(id, n); else inflight.delete(id);
    touchUse(id);
  };
  const met = readMarker(id)?.since;   // the sleep this request met on arrival: its gate may run later (a receipt's body first)
  const gate = () => wakeGate(c, id, (receipt && !NOT_SCREEN_INPUT.has(`${method} ${route}`)) || SCREEN_JOBS.has(`${method} ${route}`), met, route === '/v1/devices/:id/shell');
  if (receipt) { c.beforeRun = gate; return leave; }
  try { await gate(); } catch (e) { leave(); throw e; }
  return leave;
}
async function wakeGate(c: Pick<Ctx, 'req' | 'res'>, id: string, screenInput: boolean, met?: string, command = false): Promise<void> {
  try {
    // This request's wake, or (another request woke it since this one arrived) how the sleep it met came back.
    const woke = await ensureAwake(id, 'daemon') ?? (met && woken.get(id)?.since === met ? woken.get(id)!.w : undefined);
    if (woke && c.res && !c.res.headersSent) c.res.setHeader(WOKE_HEADER, wokeHeader(woke));
    // The caller may have given up during a wake: don't act on its behalf afterwards.
    if (c.res?.destroyed || (c.req as { aborted?: boolean } | undefined)?.aborted) {
      throw new PhoneDockError('The client disconnected while the phone was waking', 'aborted', 499, undefined, undefined, 'not_sent');
    }
    // A tap or a swipe was aimed at a screen that is gone after a fresh start: hand it back unsent, so the caller looks again.
    if (woke && screenInput && !woke.report.resumed) {
      throw new PhoneDockError(`${woke.name} started fresh, so its previous screen is gone`, 'woke_fresh', 409,
        [command ? 'Nothing was run. If the command depends on the screen, read it again; then run the command again.' : 'Nothing was sent. Read the screen again, then send the input for what is on it now.'],
        woke.report.note, 'not_sent');
    }
  } catch (e) {
    if (e instanceof PhoneDockError && !e.delivery) e.delivery = 'not_sent';   // nothing reached the device
    throw e;
  }
}

/** Wait for a sleep in progress (calling it off while it is still deciding), then wake the phone if it is asleep, with the
 *  caller's boot options (a wake already under way is shared as it is). Only the sleeper wakes phones. */
export async function ensureAwake(id: string, by: string, onProgress?: (l: string) => void, boot: BootOptions = {}): Promise<WakeResult | undefined> {
  if (!sleeper) return undefined;
  await settleOp(id);
  if (!wakes.has(id) && !readMarker(id)) return undefined;
  // A boot, restart, shutdown or delete of a sleeping phone decides what it becomes: wait for it, then look again.
  while (lifecycles.has(id)) await lifecycles.get(id);
  if (!wakes.has(id) && !readMarker(id)) return undefined;
  return wakeDevice(id, by, onProgress, boot);
}
async function settleOp(id: string) { const op = ops.get(id); if (op) { if (op.phase === 'saving') op.cancelled = true; await op.settled; } }
/** Wait for a sleep or wake in progress to finish (shutdown, delete), without waking anything. */
export async function settleSleep(id: string): Promise<void> { await settleOp(id); await wakes.get(id)?.catch(() => undefined); }
/** The person (or an agent) stopped, restarted or deleted the phone: it isn't asleep any more. */
export function forgetSleep(id: string): boolean {
  failures.delete(id);
  if (!clearMarker(id)) return false;
  invalidateDevices();
  return true;
}
const freshDevice = async (id: string, backend: string) => (await listDevices(true, backend).catch(() => [] as Device[])).find((x) => x.id === id);

/** Wake a phone PhoneDock put to sleep. Requests that arrive meanwhile share the one wake. */
export function wakeDevice(id: string, by = 'daemon', onProgress?: (l: string) => void, boot: BootOptions = {}): Promise<WakeResult | undefined> {
  const cur = wakes.get(id);
  if (cur) return cur;
  const p = (async (): Promise<WakeResult | undefined> => {
    const { backend, nativeId } = splitId(id);
    const d = await freshDevice(id, backend);
    assertDeviceAllowed(id);                    // under a device filter: only what this fresh scan lists under it
    const marker = readMarker(id);
    if (!marker) return undefined;              // that sleep was called off
    // Already running (started elsewhere) too: the backend waits until it has booted and says how it came back.
    const b = getBackend(backend);
    if (!b.wakeFromSleep) throw new PhoneDockError('This device can’t wake from sleep', 'not_supported', 501);
    const t0 = Date.now();
    onProgress?.(`waking ${marker.name} (it was sleeping since ${marker.since})`);
    invalidateDevices();
    let report: WakeReport;
    // The marker stays until the phone is ready (booted, and a fresh device list shows it running): a failed or slow
    // wake leaves it asleep for the next request, which also gets how it came back (a fresh start hands its tap back).
    const prior = d?.state === 'running' ? outcomes.get(id) : undefined;   // still stopped: that wake didn't hold, so again
    if (!prior) outcomes.delete(id);
    try {
      report = prior?.report ?? await b.wakeFromSleep(nativeId, marker.state, { ...boot, onProgress });
      try { await untilRunning(id, backend); }
      catch (e) { outcomes.set(id, prior ?? { ms: Date.now() - t0, name: marker.name, report, keptAt: now(), since: marker.since }); throw e; }
      const wokenDev = await freshDevice(id, backend);
      if (wokenDev) await proxyManager().reapplyDevice(wokenDev).catch(() => undefined);
    } catch (e) {
      const pe = e as PhoneDockError;
      logAction(id, by, { action: 'device.wake_failed', error: [pe.message ?? String(e), pe.hints?.[0]].filter(Boolean).join(' ').slice(0, 400) });
      invalidateDevices();
      if (pe.code === 'not_found' || pe.code === 'not_ready') { pe.delivery = 'not_sent'; throw pe; }
      throw new PhoneDockError(`Couldn’t wake ${marker.name}`, 'wake_failed', 503,
        ['Nothing was sent. Try again; if it keeps failing, use Cold Boot (its apps and data are kept).', ...(pe.hints ?? [])],
        [pe.message, pe.detail].filter(Boolean).join('\n'), 'not_sent');
    }
    return wakeDone(id, by, { ms: (prior?.ms ?? 0) + Date.now() - t0, name: marker.name, report }, marker.since);
  })().finally(() => { if (wakes.get(id) === p) wakes.delete(id); });
  wakes.set(id, p);
  return p;
}
function wakeDone(id: string, by: string, w: WakeResult, since: string): WakeResult {
  const { ms, name, report } = w;
  clearMarker(id);
  woken.set(id, { since, w: { ms, name, report } });
  touchUse(id);
  const secs = (ms / 1000).toFixed(1);
  logAction(id, by, {
    action: 'device.wake', summary: report.resumed ? `Woke ${name} (${secs} s)` : `Woke ${name} (${secs} s), started fresh: ${report.note ?? 'its saved state didn’t load'}`,
    ms, resumed: report.resumed, via: report.via, ...(report.clock ? { clock: report.clock } : {}), ...(report.note ? { note: report.note } : {}),
  });
  return { ms, name, report };
}
/** Waiting requests go once a fresh device list says running (their handlers read it); past one deadline they fail
 *  unsent rather than run on a phone that isn't ready. Tests make it short. */
export const wakeTiming = { readyMs: 30_000 };
async function untilRunning(id: string, backend: string, ms = wakeTiming.readyMs): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    invalidateDevices();   // each look a new scan, never one from before the wake
    const left = deadline - Date.now();
    const d = await Promise.race([freshDevice(id, backend), sleep(left).then(() => undefined)]);
    if (d?.state === 'running' && !d.meta?.stale) return;   // a stale row (that scan failed or is still running) is no proof
    await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
  }
  throw new PhoneDockError('The phone woke but isn’t ready yet', 'not_ready', 503, ['Nothing was sent. Try again in a few seconds.'],
    `${id}: the device list didn't show it running within ${ms / 1000} s of its wake`, 'not_sent');
}


/** Put one idle device to sleep. Exported for tests; the sweep calls it. */
export async function sleepDevice(d: Pick<Device, 'id' | 'name' | 'nativeId'>, b: Backend, timeoutSec: number): Promise<'slept' | 'cancelled' | 'failed'> {
  const id = d.id;
  if (ops.has(id) || wakes.has(id) || lifecycles.has(id)) return 'cancelled';
  let settle!: () => void;
  const op: SleepOp = { phase: 'saving', cancelled: false, settled: new Promise<void>((r) => { settle = r; }) };
  ops.set(id, op);
  const idleSec = Math.round((now() - lastUseOf(id)) / 1000);
  try {
    let state: SleepState;
    try { state = await b.prepareSleep!(d.nativeId); }
    catch (e) { recordFailure(id, d.name, e); return 'failed'; }
    // The marker (a request now waits for the stop, then wakes the phone), then the phone's own idle clock (slow).
    const marker: SleepMarker = { v: 1, since: new Date().toISOString(), reason: 'idle', name: d.name, idleSec, state };
    writeMarker(id, marker);
    const guest = await b.keepAwake?.(d.nativeId, { timeoutSec, guest: true }).catch((e: Error) => `PhoneDock can’t tell whether it is in use (${e.message})`);
    if (guest) { clearMarker(id); lastUse.set(id, now()); stampUse(id); return 'cancelled'; }
    // The last look, after the guest's sync and just before the stop, with no await between it and the stop: a request
    // (or the stamp of a use elsewhere), a lease, the filter, the setting (Never wins). A use lands before it or waits.
    const confirm = () => {
      const setting = idleSleepSetting().timeoutSec;
      if (op.cancelled) return 'a request came';
      if (!isDeviceAllowed(id)) return 'this service no longer controls it';
      if (setting === null) return 'idle sleep was turned off';
      const awake = keepAwakeReasons(id);
      if (awake.length) return awake[0];
      if (!idleDue({ now: now(), timeoutSec: setting, lastUseAt: lastUseOf(id), awake }).due) return 'it was used';
      stopStreamsFor(id);   // committed: its live views end now, never before the look that counts their viewers
      return undefined;
    };
    op.phase = 'stopping';
    const t1 = Date.now();
    let slept: SleepState;
    try { slept = await withTransition(id, 'stopping', () => b.stopForSleep!(d.nativeId, state, { confirm })); }
    catch (e) {
      // Called off, or it failed before the stop: it keeps running, not asleep. No proof it stopped: the marker stays,
      // and a request wakes it once it reads stopped.
      const running = (await getDevice(id, true).catch(() => undefined))?.state === 'running';
      if (running || (e as PhoneDockError).code === 'sleep_called_off') clearMarker(id);
      if ((e as PhoneDockError).code === 'sleep_called_off') return 'cancelled';
      recordFailure(id, d.name, e);
      return 'failed';
    }
    writeMarker(id, { ...marker, state: slept });
    await proxyManager().onDeviceStopped(id).catch(() => undefined);
    uiCache.delete(id);
    const mins = Math.round(idleSec / 60);
    logAction(id, 'daemon', {
      action: 'device.sleep', summary: `${d.name} went to sleep after ${mins >= 1 ? `${mins} min` : `${idleSec} s`} without use (memory freed; using it wakes it)`,
      idleSec, timeoutSec, stopMs: Date.now() - t1, exitSave: !!slept.exitSave,
    });
    return 'slept';
  } finally {
    ops.delete(id);
    settle();
    invalidateDevices();
  }
}

function recordFailure(id: string, name: string, e: unknown) {
  const pe = e as PhoneDockError;
  const message = [pe.message ?? String(e), pe.hints?.[0]].filter(Boolean).join(' ').slice(0, 400);
  failures.set(id, { at: new Date(now()).toISOString(), code: pe.code ?? 'sleep_failed', message });
  console.error(`[phonedockd] couldn't put ${id} to sleep: ${message}${pe.detail ? ` (${pe.detail.split('\n')[0]})` : ''}`);
  logAction(id, 'daemon', { action: 'device.sleep_failed', summary: `${name} couldn’t go to sleep, so it keeps running: ${message}`, code: pe.code, error: message });
}

// ── the sweep ───────────────────────────────────────────────────────────────
let sweeping = false;
/** Look at every running device this daemon may control; put at most one idle one to sleep. */
export async function sweep(): Promise<void> {
  if (sweeping || !sleeper) return;
  sweeping = true;
  try {
    const timeoutSec = idleSleepSetting().timeoutSec;   // read again: another daemon may have changed it
    if (started && timeoutSec !== scheduledFor) schedule();
    if (timeoutSec === null) return;
    const list = await sleepCapableDevices(false);   // filtered (PHONEDOCK_DEVICE_FILTER)
    for (const d of list) {
      const m = d.state === 'stopped' ? readMarker(d.id) : undefined;
      if (m) {
        // Asleep, but the AVD that went to sleep is gone (deleted outside PhoneDock): forget it, so the id is what it names now.
        await backends.find((x) => x.id === d.backend)?.checkSleeping?.(d.nativeId, m.state).catch((e: PhoneDockError) => {
          if (e.code === 'not_found' && !wakes.has(d.id) && !lifecycles.has(d.id)) { clearMarker(d.id); invalidateDevices(); }
        });
        continue;
      }
      if (d.state !== 'running' || sleepIneligible(d) || ops.has(d.id) || wakes.has(d.id) || lifecycles.has(d.id)) continue;
      // Running with a marker no sleep or wake here is handling, as a fresh read confirms: someone else started it (stale),
      // or a wake here that wasn't ready in time and that no request has finished since (the sweep finishes it).
      if (readMarker(d.id)) {
        if ((await getDevice(d.id, true).catch(() => undefined))?.state !== 'running' || ops.has(d.id) || wakes.has(d.id)) continue;
        const kept = outcomes.get(d.id);
        if (kept && now() - kept.keptAt < KEEP_OUTCOME_SEC * 1000) continue;
        if (kept) wakeDone(d.id, 'daemon', kept, kept.since); else clearMarker(d.id);
        invalidateDevices();
        continue;
      }
      const b = backends.find((x) => x.id === d.backend);
      if (!b) continue;
      // The backend's cheap check, then the daemon's; the phone's own idle clock comes last, in sleepDevice.
      const extra = await b.keepAwake?.(d.nativeId).catch((e: Error) => `PhoneDock can’t tell whether it is in use (${e.message})`);
      const awake = [...keepAwakeReasons(d.id), ...(extra ? [extra] : [])];
      if (awake.length) { lastUse.set(d.id, now()); stampUse(d.id); continue; }
      if (failures.has(d.id)) continue;   // a failed attempt waits for the next use or restart
      if (!idleDue({ now: now(), timeoutSec, lastUseAt: lastUseOf(d.id), awake }).due) continue;
      await sleepDevice(d, b, timeoutSec);
      break;   // one at a time: each exit save writes the phone's whole memory to disk
    }
  } catch (e) {
    console.error('[phonedockd] idle sleep sweep failed:', e);
  } finally { sweeping = false; }
}


/** A sixth of the timeout (2–30 s); with Never, every 30 s, only to read the setting (another daemon may change it). */
export function sweepEveryMs(timeoutSec: number | null): number {
  return timeoutSec === null ? 30_000 : Math.max(2_000, Math.min(30_000, (timeoutSec * 1000) / 6));
}
let timer: NodeJS.Timeout | undefined;
let scheduledFor: number | null | undefined;
function schedule() {
  if (timer) { clearInterval(timer); timer = undefined; }
  if (!started) return;
  scheduledFor = idleSleepSetting().timeoutSec;
  timer = setInterval(() => { void sweep(); }, sweepEveryMs(scheduledFor));
  timer.unref();
}
let started = false;
/** The sweep runs only in the sleeper. */
export function startIdleSleep() { if (!sleeper) return; started = true; schedule(); }

/** Each device in words, for GET /v1/idle-sleep: asleep, or how long until it sleeps and what keeps it awake. */
export async function idleSleepStatus(): Promise<IdleSleepSetting & { sleeper: boolean; choices: readonly (number | null)[]; devices: Record<string, unknown>[] }> {
  const s = idleSleepSetting();
  const list = await sleepCapableDevices(true);   // fresh: right after a sleep or wake the cached list lags
  const devices: Record<string, unknown>[] = [];
  for (const d of list) {
    const why = sleepIneligible(d);
    const base = { id: d.id, name: d.name, state: d.state };
    if (why) { devices.push({ ...base, eligible: false, why }); continue; }
    if (d.sleep) { devices.push({ ...base, eligible: true, sleep: d.sleep }); continue; }
    if (d.state !== 'running') { devices.push({ ...base, eligible: true }); continue; }
    const extra = await backends.find((x) => x.id === d.backend)?.keepAwake?.(d.nativeId).catch(() => undefined);
    const awake = [...keepAwakeReasons(d.id), ...(extra ? [extra] : [])];
    const due = idleDue({ now: now(), timeoutSec: s.timeoutSec, lastUseAt: awake.length ? now() : lastUseOf(d.id), awake });
    devices.push({ ...base, eligible: true, idleSec: due.idleSec, sleepsInSec: failures.has(d.id) || !sleeper ? null : due.sleepsInSec, keptAwakeBy: awake,
      ...(ops.has(d.id) ? { sleeping: ops.get(d.id)!.phase } : {}), ...(failures.get(d.id) ? { sleepFailure: failures.get(d.id) } : {}) });
  }
  return { ...s, sleeper, choices: IDLE_SLEEP_CHOICES, devices };
}

// A phone the sleeper put to sleep stopped on purpose, not a crash (also as seen by any other service on this state dir).
expectedStops.push((id) => canSleep(id) && !!readMarker(id));

// Device.sleep / Device.sleepFailure on every device that can sleep.
deviceDecorators.push((d) => {
  if (!canSleep(d.id)) return;
  if (d.state !== 'running') failures.delete(d.id);   // stopped or starting: a new attempt later, not a stale failure
  const m = sleeper ? readMarker(d.id) : undefined;   // elsewhere a sleeping phone is a stopped one
  const sleep: DeviceSleep | null = m && (d.state === 'stopped' || d.state === 'stopping') && !wakes.has(d.id) ? { since: m.since, reason: m.reason } : null;
  d.sleep = sleep;
  d.sleepFailure = failures.get(d.id) ?? null;
});

/** Test hooks. */
export function setIdleClockForTests(f?: () => number) { now = f ?? (() => Date.now()); }
export function setIdleSleepRoleForTests(o: { sleeper?: boolean; defaultSec?: number | null }) {
  if (o.sleeper !== undefined) sleeper = o.sleeper;
  if (o.defaultSec !== undefined) defaultSec = o.defaultSec;
}
export function resetIdleSleepForTests() {
  daemonStartedAt = now(); lastUse.clear(); inflight.clear(); failures.clear(); ops.clear(); wakes.clear(); stamped.clear(); outcomes.clear(); woken.clear();
}
