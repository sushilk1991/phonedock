// Idle sleep: once nobody has used an Android emulator PhoneDock created for a while (default 15 minutes), the daemon
// saves its whole state, checks the save, and stops it, which frees all of its memory. The next request that needs it
// running wakes it where it left off. docs/API.md "Idle sleep".
//
// Use vs observe. Only *use* (what an agent or the person deliberately does to a phone) resets its idle clock or wakes
// it. *Observe* requests (inventory, the app's polling and inspector refreshes, live views) never do: otherwise an open
// app would keep every phone awake, or keep waking them. classifyRequest() says which is which.
//
// Never asleep: iOS, physical, Wi-Fi and cloud devices, and emulators PhoneDock didn't create (Android Studio's AVDs,
// which something else may be using). Only devices this daemon may see (PHONEDOCK_DEVICE_FILTER) are considered.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';
import { stateDir } from '../core/paths.ts';
import { PhoneDockError, type Backend, type Device, type DeviceSleep, type SleepState, type WakeReport } from '../core/types.ts';
import {
  backends, createdByPhoneDock, deviceDecorators, deviceFilter, deviceJobRunning, emit, expectedStops, getBackend, getDevice, invalidateDevices, isDeviceAllowed,
  leaseView, listDevices, logAction, pendingHandoff, recordings, safeId, splitId, stopStreamsFor, uiCache, watched, withTransition,
} from './core.ts';
import { traces } from './trace.ts';
import { hasReceipt } from './requests.ts';
import { sleep } from '../core/exec.ts';
import type { Ctx } from './http.ts';

// ── the setting ─────────────────────────────────────────────────────────────
/** What the setting can be: never (null), 10, 15, 30 or 60 minutes. */
export const IDLE_SLEEP_CHOICES: readonly (number | null)[] = [null, 600, 900, 1800, 3600];
export const DEFAULT_IDLE_SLEEP_SEC = 900;
/** Same words everywhere (app, CLI, MCP): "asleep" and "Wake" already mean a screen that is off. */
export const SLEEPING_WORDS = 'Sleeping · memory freed · wakes when used';

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
/** "15 minutes", "1 hour", "never". */
export function idleDurationWords(sec: number | null): string {
  if (sec === null) return 'never';
  if (sec % 3600 === 0) return `${sec / 3600} hour${sec === 3600 ? '' : 's'}`;
  if (sec % 60 === 0) return `${sec / 60} minute${sec === 60 ? '' : 's'}`;
  return `${sec} seconds`;
}

export interface IdleSleepSetting {
  timeoutSec: number | null;
  /** env: PHONEDOCK_IDLE_SLEEP (tests) overrides the saved setting; setting: saved; default: never set. */
  source: 'env' | 'setting' | 'default';
  /** The saved value, when the environment overrides it. */
  saved?: number | null;
}
const settingFile = () => join(stateDir(), 'idle-sleep.json');
// Read again whenever the file changes: another daemon on this state dir (the app's, or a test one) may have saved it.
let saved: { mtimeMs: number; value: { timeoutSec: number | null } | null } | undefined;
let warnedEnv = false;
function readSaved(): { timeoutSec: number | null } | null {
  let mtimeMs = -1;
  try { mtimeMs = statSync(settingFile(), { throwIfNoEntry: false })?.mtimeMs ?? -1; } catch { /* unreadable: as if none */ }
  if (saved && saved.mtimeMs === mtimeMs) return saved.value;
  let value: { timeoutSec: number | null } | null = null;
  if (mtimeMs >= 0) {
    try {
      const j = JSON.parse(readFileSync(settingFile(), 'utf8')) as { timeoutSec?: unknown };
      value = j && (j.timeoutSec === null || IDLE_SLEEP_CHOICES.includes(j.timeoutSec as number)) ? { timeoutSec: j.timeoutSec as number | null } : null;
    } catch { value = null; }
  }
  saved = { mtimeMs, value };
  return value;
}
export function idleSleepSetting(): IdleSleepSetting {
  const file = readSaved();
  const env = process.env.PHONEDOCK_IDLE_SLEEP?.trim();
  if (env) {
    const v = parseIdleDuration(env);
    if (v !== undefined) return { timeoutSec: v, source: 'env', ...(file ? { saved: file.timeoutSec } : {}) };
    if (!warnedEnv) { warnedEnv = true; console.error(`[phonedockd] PHONEDOCK_IDLE_SLEEP=${env} isn't "off" or a duration such as 15m; using the saved setting`); }
  }
  return file ? { timeoutSec: file.timeoutSec, source: 'setting' } : { timeoutSec: DEFAULT_IDLE_SLEEP_SEC, source: 'default' };
}
export function setIdleSleep(timeoutSec: number | null): IdleSleepSetting {
  if (!IDLE_SLEEP_CHOICES.includes(timeoutSec)) {
    throw new PhoneDockError('Choose never, 10, 15 or 30 minutes, or 1 hour', 'bad_request', 400, ['Send { "timeoutSec": null | 600 | 900 | 1800 | 3600 } or { "after": "off" | "10m" | "15m" | "30m" | "1h" }.'],
      `Unsupported idle sleep timeout ${JSON.stringify(timeoutSec)}`);
  }
  const f = settingFile(); const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: 1, timeoutSec, updatedAt: new Date().toISOString() }, null, 2) + '\n');
  renameSync(tmp, f);
  saved = undefined;
  schedule();
  const s = idleSleepSetting();
  emit('idle-sleep', s);
  invalidateDevices();
  return s;
}

// ── sleep markers (per device, on disk: they outlive the daemon, which the app replaces on every update) ──────────
export interface SleepMarker {
  v: 1; since: string; reason: 'idle'; name: string; idleSec: number; state: SleepState;
  /** stopping: saved, and the daemon `owner` is stopping it; asleep (or absent, in older markers): it stopped. */
  phase?: 'stopping' | 'asleep';
  owner?: { pid: number };
}
const markerPath = (id: string) => join(stateDir('devices'), safeId(id), 'sleep.json');
const markerCache = new Map<string, { mtimeMs: number; marker: SleepMarker | undefined }>();
export function readMarker(id: string): SleepMarker | undefined {
  const p = markerPath(id);
  let st; try { st = statSync(p, { throwIfNoEntry: false }); } catch { st = undefined; }
  if (!st) { markerCache.delete(id); return undefined; }
  const c = markerCache.get(id);
  if (c && c.mtimeMs === st.mtimeMs) return c.marker;
  let marker: SleepMarker | undefined;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as SleepMarker;
    if (j?.v === 1 && typeof j.since === 'string' && j.state && typeof j.state.snapshot === 'string') marker = j;
  } catch { /* unreadable: not asleep */ }
  markerCache.set(id, { mtimeMs: st.mtimeMs, marker });
  return marker;
}
function writeMarker(id: string, m: SleepMarker) {
  const p = markerPath(id);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(`${p}.tmp`, JSON.stringify(m, null, 2) + '\n');
  renameSync(`${p}.tmp`, p);
  markerCache.delete(id);
}
export function clearMarker(id: string): boolean {
  const had = existsSync(markerPath(id));
  rmSync(markerPath(id), { force: true });
  markerCache.delete(id);
  return had;
}
export const isSleeping = (id: string) => !!readMarker(id);

/** The backend gives a stop 180 s before it calls it failed; past this, a stop nobody is running any more is over. */
const STOP_DEADLINE_MS = 200_000;
/** A live peer daemon still stopping a phone after this long has lost track of it. */
const PEER_STOP_GIVE_UP_MS = 600_000;
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}
/** Someone may still be stopping this phone: this daemon, a live peer, or a daemon that died after `emu kill` while the
 *  emulator saves and exits. Past the deadline, the phone itself says how the stop ended. */
function stopUnderway(id: string, m: SleepMarker): boolean {
  if (m.phase !== 'stopping') return false;
  if (ops.has(id)) return true;
  const age = Date.now() - Date.parse(m.since);
  const peer = !!m.owner && m.owner.pid !== process.pid && pidAlive(m.owner.pid);
  return age < (peer ? PEER_STOP_GIVE_UP_MS : STOP_DEADLINE_MS);
}

/** Boot, restart, shutdown and delete hold this for the whole operation: a wake waits for it (and then goes by what it
 *  left), and the sweep leaves the phone alone meanwhile. */
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
/** A sleep in progress. While it saves, a request cancels it (and waits for the save to end, the phone is paused);
 *  once it is stopping, a request waits for it and then wakes the phone. */
interface SleepOp { phase: 'saving' | 'stopping'; cancelled: boolean; settled: Promise<void> }
const ops = new Map<string, SleepOp>();
const wakes = new Map<string, Promise<WakeResult | undefined>>();

// Several daemons can share PHONEDOCK_HOME (the app's and a test or worker daemon on another port). Each one only
// sees its own requests, so every use and keep-awake signal also touches a per-device stamp the others read.
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

const sleepCapable = (b: Backend | undefined) => !!(b?.saveSleep && b.stopAfterSleep && b.wakeFromSleep);
function canSleep(id: string): boolean {
  const i = id.indexOf(':');
  return sleepCapable(i > 0 ? backends.find((x) => x.id === id.slice(0, i)) : undefined);
}
/** Devices of the backends that can sleep only: the sweep runs every few seconds and must not make an otherwise idle
 *  daemon poll simulators, phones and cloud providers. */
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
/** Device reads that never need the phone itself, and the live views (which keep a phone awake only while someone is
 *  watching a lit screen: core.watched). */
const OBSERVE = new Set([
  'GET /v1/devices/:id', 'GET /v1/devices/:id/actions', 'GET /v1/devices/:id/requests/:requestId', 'GET /v1/devices/:id/recording',
  'GET /v1/devices/:id/snapshots', 'GET /v1/devices/:id/info', 'GET /v1/devices/:id/trace', 'GET /v1/devices/:id/traces',
  'GET /v1/devices/:id/frame', 'GET /v1/devices/:id/stream', 'GET /v1/devices/:id/video', 'GET /v1/devices/:id/apps/:appId/data',
  'GET /v1/devices/:id/environment',   // the controls a kind of device supports: from its backend and kind alone
]);
/** Lifecycle requests: their handlers deal with a sleeping phone themselves (boot wakes it, shutdown and delete forget
 *  its sleep). Never woken by the gate. */
const CONTROL = new Set([
  'POST /v1/devices/:id/boot', 'POST /v1/devices/:id/shutdown', 'POST /v1/devices/:id/restart', 'DELETE /v1/devices/:id',
  'PATCH /v1/devices/:id', 'POST /v1/devices/:id/clone', 'DELETE /v1/devices/:id/lease', 'DELETE /v1/devices/:id/snapshots/:name',
]);
/** `X-PhoneDock-Observe: 1` on a GET: the client is only looking (the app's background refreshes). Never wakes, never
 *  counts. Ignored on anything but a GET: a request that changes the phone is use, whoever sends it. */
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
/** `X-PhoneDock-Woke: 7213; name=Pixel%208` on every response that woke the phone first (or waited for its wake). */
export const WOKE_HEADER = 'X-PhoneDock-Woke';
export const wokeHeader = (w: WakeResult) => `${w.ms}; name=${encodeURIComponent(w.name)}`;

/** Called before every request handler (src/daemon/main.ts). A use counts as use, waits for a sleep in progress and
 *  wakes a sleeping phone; the returned function ends it. Observe and other requests pass straight through. */
export async function enterRequest(c: Pick<Ctx, 'params' | 'req' | 'res'> & { owner?: string }, method: string, route: string): Promise<(() => void) | undefined> {
  const id = c.params?.id;
  if (!id) return undefined;
  const kind = classifyRequest(method, route, c.req?.headers);
  if (kind === 'observe' || kind === 'none' || !isDeviceAllowed(id)) return undefined;
  if (kind === 'control') return () => touchUse(id);
  // A resent request (the same X-PhoneDock-Request-Id) is answered from its receipt: it needs no wake, and a wake that
  // failed must never tell it "not sent, safe to retry" when the first one was delivered.
  if (hasReceipt(c)) return undefined;
  touchUse(id);
  inflight.set(id, (inflight.get(id) ?? 0) + 1);
  let left = false;
  const leave = () => {
    if (left) return; left = true;
    const n = (inflight.get(id) ?? 1) - 1;
    if (n > 0) inflight.set(id, n); else inflight.delete(id);
    touchUse(id);
  };
  try {
    const woke = await ensureAwake(id, 'daemon');
    if (woke && c.res && !c.res.headersSent) c.res.setHeader(WOKE_HEADER, wokeHeader(woke));
    // The caller may have given up during a wake: don't act on its behalf afterwards.
    if (c.res?.destroyed || (c.req as { aborted?: boolean } | undefined)?.aborted) {
      throw new PhoneDockError('The client disconnected while the phone was waking', 'aborted', 499, undefined, undefined, 'not_sent');
    }
  } catch (e) {
    leave();
    if (e instanceof PhoneDockError && !e.delivery) e.delivery = 'not_sent';   // nothing reached the device
    throw e;
  }
  return leave;
}

/** Wait for a sleep in progress (cancelling it while it is still saving), then wake the phone if it is asleep. */
export async function ensureAwake(id: string, by: string, onProgress?: (l: string) => void): Promise<WakeResult | undefined> {
  const op = ops.get(id);
  if (op) {
    if (op.phase === 'saving') op.cancelled = true;
    await op.settled;
  }
  if (!wakes.has(id) && !readMarker(id)) return undefined;
  // A boot, restart, shutdown or delete of a sleeping phone decides what it becomes: wait for it, then look again.
  while (lifecycles.has(id)) await lifecycles.get(id);
  let m = readMarker(id);
  // Another daemon (or one that died) may still be stopping it: wait for that, then go by the phone itself.
  while (m && stopUnderway(id, m)) {
    const own = ops.get(id);
    if (own) await own.settled; else await sleep(250);
    m = readMarker(id);
  }
  if (m?.phase === 'stopping') {
    const d = (await listDevices(true, splitId(id).backend).catch(() => [] as Device[])).find((x) => x.id === id);
    if (d?.state === 'running') { clearMarker(id); invalidateDevices(); m = undefined; }   // that stop never happened
  }
  if (!wakes.has(id) && !m) return undefined;
  return wakeDevice(id, by, onProgress);
}
/** Wait for a sleep or wake in progress to finish (shutdown, delete), without waking anything. */
export async function settleSleep(id: string): Promise<void> {
  const op = ops.get(id);
  if (op) { if (op.phase === 'saving') op.cancelled = true; await op.settled; }
  await wakes.get(id)?.catch(() => undefined);
}
/** The person (or an agent) stopped, restarted or deleted the phone: it isn't asleep any more, and the saved state
 *  won't be used. */
export async function forgetSleep(id: string, b?: Backend, nid?: string): Promise<boolean> {
  failures.delete(id);
  if (!clearMarker(id)) return false;
  await b?.discardSleep?.(nid ?? splitId(id).nativeId).catch(() => undefined);
  invalidateDevices();
  return true;
}

/** Wake a phone PhoneDock put to sleep. Requests that arrive meanwhile share the one wake. */
export function wakeDevice(id: string, by = 'daemon', onProgress?: (l: string) => void): Promise<WakeResult | undefined> {
  const cur = wakes.get(id);
  if (cur) return cur;
  const p = (async (): Promise<WakeResult | undefined> => {
    const marker = readMarker(id);
    if (!marker) return undefined;
    const { backend, nativeId } = splitId(id);
    // Under a device filter, act only on a device this daemon's latest scan still lists under it.
    if (deviceFilter) { await listDevices(true, backend).catch(() => undefined); if (!isDeviceAllowed(id)) return undefined; }
    const b = getBackend(backend);
    if (!b.wakeFromSleep) throw new PhoneDockError('This device can’t wake from sleep', 'not_supported', 501);
    const t0 = Date.now();
    onProgress?.(`waking ${marker.name} (it was sleeping since ${marker.since})`);
    invalidateDevices();
    let report: WakeReport;
    try { report = await b.wakeFromSleep(nativeId, marker.state, { onProgress }); }
    catch (e) {
      const pe = e as PhoneDockError;
      logAction(id, by, { action: 'device.wake_failed', error: [pe.message ?? String(e), pe.hints?.[0]].filter(Boolean).join(' ').slice(0, 400) });
      invalidateDevices();
      throw new PhoneDockError(`Couldn’t wake ${marker.name}`, 'wake_failed', 503,
        ['Start it from PhoneDock (Start); if that fails too, use Cold Boot. Its apps and data are kept either way.', ...(pe.hints ?? [])],
        [pe.message, pe.detail].filter(Boolean).join('\n'), 'not_sent');
    }
    const ms = Date.now() - t0;
    clearMarker(id);
    touchUse(id);
    const secs = (ms / 1000).toFixed(1);
    logAction(id, by, {
      action: 'device.wake', summary: report.resumed ? `Woke ${marker.name} (${secs} s)` : `Woke ${marker.name} (${secs} s), started fresh: ${report.note ?? 'its saved state didn’t load'}`,
      ms, resumed: report.resumed, via: report.via, ...(report.clock ? { clock: report.clock } : {}), ...(report.note ? { note: report.note } : {}),
    });
    // Release the waiting requests once the inventory says running: their handlers read it (a trace refuses a phone
    // that isn't running), and a stale read would undo the wake for them.
    invalidateDevices();
    for (let i = 0; i < 40; i++) {
      if ((await listDevices(true, backend).catch(() => [] as Device[])).find((x) => x.id === id)?.state === 'running') break;
      await sleep(250);
    }
    return { ms, name: marker.name, report };
  })().finally(() => { if (wakes.get(id) === p) wakes.delete(id); });
  wakes.set(id, p);
  return p;
}

/** Put one idle device to sleep. Exported for tests; the sweep calls it. */
export async function sleepDevice(d: Pick<Device, 'id' | 'name' | 'nativeId'>, b: Backend, timeoutSec: number): Promise<'slept' | 'cancelled' | 'failed'> {
  const id = d.id;
  if (ops.has(id) || wakes.has(id)) return 'cancelled';
  let settle!: () => void;
  const op: SleepOp = { phase: 'saving', cancelled: false, settled: new Promise<void>((r) => { settle = r; }) };
  ops.set(id, op);
  const idleSec = Math.round((now() - lastUseOf(id)) / 1000);
  const t0 = Date.now();
  try {
    let state: SleepState;
    try { state = await b.saveSleep!(d.nativeId); }
    catch (e) { recordFailure(id, d.name, e); return 'failed'; }
    const saveMs = Date.now() - t0;
    // Re-check just before stopping: anything that came during the save keeps it running, and so does a setting
    // another daemon changed meanwhile (read again).
    const setting = idleSleepSetting().timeoutSec;
    const extra = await b.keepAwake?.(d.nativeId, { timeoutSec: setting, guest: true }).catch((e: Error) => `can’t tell (${e.message})`);
    const still = !op.cancelled && !extra && setting !== null && idleDue({ now: now(), timeoutSec: setting, lastUseAt: lastUseOf(id), awake: keepAwakeReasons(id) }).due;
    if (!still) { void b.discardSleep?.(d.nativeId); return 'cancelled'; }
    // From here on a request waits for the stop and then wakes the phone (ensureAwake). The marker says who is stopping
    // it, so another daemon on this state dir waits too, and a daemon started after this one died can tell.
    op.phase = 'stopping';
    const marker: SleepMarker = { v: 1, since: new Date().toISOString(), reason: 'idle', name: d.name, idleSec, state, phase: 'stopping', owner: { pid: process.pid } };
    writeMarker(id, marker);
    const t1 = Date.now();
    try {
      await withTransition(id, 'stopping', async () => { stopStreamsFor(id); await b.stopAfterSleep!(d.nativeId); });
    } catch (e) {
      // Did it stop? The phone says: running, it keeps running (and the failure is shown); stopped, it is asleep after
      // all; can't tell, the marker stays and the phone itself settles it later (stopUnderway).
      const after = (await listDevices(true, b.id).catch(() => undefined))?.find((x) => x.id === id);
      if (after?.state !== 'stopped') {
        if (after?.state === 'running') clearMarker(id);
        recordFailure(id, d.name, e);
        return 'failed';
      }
    }
    writeMarker(id, { ...marker, phase: 'asleep' });
    uiCache.delete(id);
    const mins = Math.round(idleSec / 60);
    logAction(id, 'daemon', {
      action: 'device.sleep', summary: `${d.name} went to sleep after ${mins >= 1 ? `${mins} min` : `${idleSec} s`} without use (memory freed; using it wakes it)`,
      idleSec, timeoutSec, saveMs, stopMs: Date.now() - t1,
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
  if (sweeping) return;
  sweeping = true;
  try {
    const timeoutSec = idleSleepSetting().timeoutSec;   // read again: another daemon may have changed it
    if (started && timeoutSec !== scheduledFor) schedule();
    if (timeoutSec === null) return;
    const list = await sleepCapableDevices(false);   // filtered (PHONEDOCK_DEVICE_FILTER)
    for (const d of list) {
      if (d.state !== 'running' || sleepIneligible(d) || ops.has(d.id) || wakes.has(d.id) || lifecycles.has(d.id)) continue;
      const m = readMarker(d.id);
      if (m) {
        // Running with a sleep marker: someone is still stopping it (here, a peer, or a daemon that died during the
        // stop), the inventory hasn't caught up with a sleep yet, or someone started it outside PhoneDock's wake. Leave
        // a stop that may be under way alone; otherwise only a fresh read tells; never sleep it again on a stale one.
        if (stopUnderway(d.id, m)) continue;
        const fresh = m.phase === 'stopping' || Date.now() - Date.parse(m.since) > 30_000 ? await getDevice(d.id, true).catch(() => undefined) : undefined;
        if (fresh?.state === 'running' && !ops.has(d.id) && !wakes.has(d.id)) { clearMarker(d.id); invalidateDevices(); }
        continue;
      }
      const b = backends.find((x) => x.id === d.backend);
      if (!b) continue;
      // Just before saving: the backend's own check first (it reads processes), then the daemon's, current as of now.
      const extra = await b.keepAwake?.(d.nativeId).catch(() => undefined);
      const awake = [...keepAwakeReasons(d.id), ...(extra ? [extra] : [])];
      if (awake.length) { lastUse.set(d.id, now()); stampUse(d.id); continue; }
      if (failures.has(d.id)) continue;   // a failed attempt waits for the next use or restart
      if (!idleDue({ now: now(), timeoutSec, lastUseAt: lastUseOf(d.id), awake }).due) continue;
      // Due by PhoneDock's clock. Last, the phone's own (input from adb, Android Studio or a test run PhoneDock never
      // saw); when that can't be read, it stays awake.
      const guest = await b.keepAwake?.(d.nativeId, { timeoutSec, guest: true })
        .catch((e: Error) => `PhoneDock can’t tell whether it is in use (${e.message})`);
      if (guest) { lastUse.set(d.id, now()); stampUse(d.id); continue; }
      await sleepDevice(d, b, timeoutSec);
      break;   // one at a time: each save writes the phone's whole memory to disk
    }
  } catch (e) {
    console.error('[phonedockd] idle sleep sweep failed:', e);
  } finally { sweeping = false; }
}

/** How often the sweep runs: a sixth of the timeout (2–30 s). Also with Never, every 30 s, which only reads the setting:
 *  another daemon on this state dir may turn it on. */
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
export function startIdleSleep() { started = true; schedule(); }

/** Each device in words, for GET /v1/idle-sleep: asleep, or how long until it sleeps and what keeps it awake. */
export async function idleSleepStatus(): Promise<IdleSleepSetting & { choices: readonly (number | null)[]; devices: Record<string, unknown>[] }> {
  const s = idleSleepSetting();
  const list = await sleepCapableDevices(true);   // fresh: right after a sleep or wake the cached list lags
  const devices: Record<string, unknown>[] = [];
  for (const d of list) {
    if (!canSleep(d.id)) continue;
    const why = sleepIneligible(d);
    const base = { id: d.id, name: d.name, state: d.state };
    if (why) { devices.push({ ...base, eligible: false, why }); continue; }
    if (d.sleep) { devices.push({ ...base, eligible: true, sleep: d.sleep }); continue; }
    if (d.state !== 'running') { devices.push({ ...base, eligible: true }); continue; }
    const extra = await backends.find((x) => x.id === d.backend)?.keepAwake?.(d.nativeId).catch(() => undefined);
    const awake = [...keepAwakeReasons(d.id), ...(extra ? [extra] : [])];
    const due = idleDue({ now: now(), timeoutSec: s.timeoutSec, lastUseAt: awake.length ? now() : lastUseOf(d.id), awake });
    devices.push({ ...base, eligible: true, idleSec: due.idleSec, sleepsInSec: failures.has(d.id) ? null : due.sleepsInSec, keptAwakeBy: awake,
      ...(ops.has(d.id) ? { sleeping: ops.get(d.id)!.phase } : {}), ...(failures.get(d.id) ? { sleepFailure: failures.get(d.id) } : {}) });
  }
  return { ...s, choices: IDLE_SLEEP_CHOICES, devices };
}

// A phone that went to sleep (here or through another daemon on this state dir) stopped on purpose, not a crash.
expectedStops.push((id) => canSleep(id) && !!readMarker(id));

// Device.sleep / Device.sleepFailure on every device that can sleep.
deviceDecorators.push((d) => {
  if (!canSleep(d.id)) return;
  if (d.state !== 'running') failures.delete(d.id);   // stopped or starting: a new attempt later, not a stale failure
  const m = readMarker(d.id);
  const sleep: DeviceSleep | null = m && (d.state === 'stopped' || d.state === 'stopping') && !wakes.has(d.id) ? { since: m.since, reason: m.reason } : null;
  d.sleep = sleep;
  d.sleepFailure = failures.get(d.id) ?? null;
});

/** Test hooks. */
export function setIdleClockForTests(f?: () => number) { now = f ?? (() => Date.now()); }
export function resetIdleSleepForTests() {
  daemonStartedAt = now(); lastUse.clear(); inflight.clear(); failures.clear(); ops.clear(); wakes.clear(); stamped.clear(); markerCache.clear(); saved = undefined;
}
