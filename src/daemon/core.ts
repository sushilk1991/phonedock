// Daemon state: backends, device cache, persistence, jobs, leases, events, shared frame streams.
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { loadBackends } from '../backends/index.ts';
import { probeVideo } from '../backends/ios-common.ts';
import { instrumentBackend } from './metrics.ts';
import { PHONEDOCK_HOME, daemonInfoName, stateDir } from '../core/paths.ts';
import { PhoneDockError, type Backend, type Device, type DeviceSpec, type FrameStream, type Handoff, type HandoffState, type Lease, type ScreenInfo, type UiTree, type VideoStream } from '../core/types.ts';
import { VideoFanout } from '../core/video.ts';

// ── backends ────────────────────────────────────────────────────────────────
export let backends: Backend[] = [];
export let loadFailures: { module: string; error: string }[] = [];
export async function initBackends() {
  const r = await loadBackends();
  backends = r.backends.map((b) => instrumentBackend(b, b.id)); loadFailures = r.failures;
}
export function getBackend(id: string): Backend {
  const b = backends.find((x) => x.id === id);
  if (!b) throw new PhoneDockError("Couldn’t find the device provider", 'not_found', 404, undefined, `Unknown backend "${id}"\nBackends: ${backends.map((x) => x.id).join(', ')}`);
  return b;
}
// ── device filter (test isolation) ──────────────────────────────────────────
// PHONEDOCK_DEVICE_FILTER=<prefix> limits this service to devices whose name starts with <prefix>: others are not
// listed and can't be controlled, new devices must use the prefix, and physical phones can't be connected or
// discovered. For test runs and CI that share a Mac with devices they must never touch.
export const deviceFilter = process.env.PHONEDOCK_DEVICE_FILTER?.trim() || undefined;
const filteredIds = new Set<string>();   // ids this service has listed under the filter
export function assertDeviceAllowed(id: string) {
  if (deviceFilter && !filteredIds.has(id)) throw filteredOut(id);
}
export function assertNameAllowed(name: string | undefined) {
  if (deviceFilter && !name?.startsWith(deviceFilter)) {
    throw new PhoneDockError(`Device names must start with “${deviceFilter}”`, 'bad_request', 400,
      [`Name it ${deviceFilter}<something>.`], `PHONEDOCK_DEVICE_FILTER=${deviceFilter} is set for this service`);
  }
}
export function assertPhysicalAllowed(what: string) {
  if (deviceFilter) {
    throw new PhoneDockError('Physical phones are turned off for this service', 'not_supported', 501, undefined,
      `${what} is disabled while PHONEDOCK_DEVICE_FILTER=${deviceFilter} is set`);
  }
}
function filteredOut(id: string) {
  return new PhoneDockError("Couldn’t find the device", 'not_found', 404, ["Check the list of available devices."],
    `No device ${id} (this service only shows devices named ${deviceFilter}…)`);
}
function applyFilter(list: Device[]): Device[] {
  if (!deviceFilter) return list;
  const out = list.filter((d) => d.name.startsWith(deviceFilter) && d.kind !== 'physical');
  for (const d of out) filteredIds.add(d.id);
  return out;
}

export function splitId(id: string): { backend: string; nativeId: string } {
  const i = id.indexOf(':');
  if (i <= 0) throw new PhoneDockError("The device identifier is invalid", 'bad_request', 400, undefined, `Bad device id "${id}" (expected backend:nativeId)`);
  return { backend: id.slice(0, i), nativeId: id.slice(i + 1) };
}

// ── persistence ─────────────────────────────────────────────────────────────
export interface ManagedRecord { id: string; backend: string; nativeId: string; spec?: Partial<DeviceSpec>; autoStart?: boolean; name?: string; createdAt: string }
interface StateFile { devices: ManagedRecord[] }
const STATE_FILE = () => join(stateDir(), 'state.json');
export let state: StateFile = { devices: [] };
export function loadState() {
  try { state = JSON.parse(readFileSync(STATE_FILE(), 'utf8')); if (!Array.isArray(state.devices)) state.devices = []; } catch { state = { devices: [] }; }
}
export function saveState() {
  const tmp = STATE_FILE() + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_FILE());
}
export function record(id: string): ManagedRecord | undefined { return state.devices.find((d) => d.id === id); }
export function upsertRecord(r: ManagedRecord) {
  const i = state.devices.findIndex((d) => d.id === r.id);
  if (i >= 0) state.devices[i] = { ...state.devices[i], ...r }; else state.devices.push(r);
  saveState();
}
export function removeRecord(id: string) { state.devices = state.devices.filter((d) => d.id !== id); saveState(); }

// ── daemon.json ─────────────────────────────────────────────────────────────
export function writeDaemonInfo(port: number, version: string): string {
  const file = join(stateDir(), daemonInfoName(port));
  let token: string | undefined;
  try { token = JSON.parse(readFileSync(file, 'utf8')).token; } catch { /* new */ }
  if (!token || !/^[0-9a-f]{32,}$/.test(token)) token = randomBytes(24).toString('hex');
  writeFileSync(file, JSON.stringify({ port, token, pid: process.pid, version, startedAt: new Date().toISOString(), home: PHONEDOCK_HOME }, null, 2), { mode: 0o600 });
  return token;
}

// ── leases ──────────────────────────────────────────────────────────────────
// Agent leases (every owner but the Mac app's person, `app:human`) slide: they expire `ttlSec` (default 10 min)
// after the owner's last call on the device, and every call the owner makes renews them. `app:human` leases
// without a TTL are held until handed back. A lease whose owner process has exited (owner strings carry the pid:
// `mcp:<client>:<pid>`, `sdk:<pid>`) is stale: the next other owner that runs into it reclaims it.
export const HUMAN_OWNER = 'app:human';
export const DEFAULT_AGENT_LEASE_SEC = 600;
const leases = new Map<string, Lease>();
/** Test hook: is this pid alive? (process.kill(pid, 0); EPERM = alive, owned by someone else). */
export let pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};
export function setPidAlive(f: (pid: number) => boolean) { pidAlive = f; }
/** The pid an owner string carries: `mcp:<client>:<pid>` or `sdk:<pid>`. CLI (`cli:<user>`), app and custom owners have none. */
export function ownerPid(owner: string): number | undefined {
  const m = /^mcp:[^:]*:(\d+)$/.exec(owner) ?? /^sdk:(\d+)$/.exec(owner);
  const pid = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
}
/** True when the owner's process has exited (only owners that carry a pid can be stale). */
export function ownerGone(owner: string): boolean {
  const pid = ownerPid(owner);
  return pid !== undefined && pid !== process.pid && !pidAlive(pid);
}
function setExpiry(l: Lease, now = Date.now()) { if (l.ttlSec) l.expiresAt = new Date(now + l.ttlSec * 1000).toISOString(); }
export function getLease(id: string): Lease | null {
  const l = leases.get(id);
  if (!l) return null;
  if (l.expiresAt && Date.parse(l.expiresAt) < Date.now()) {
    // An agent blocked in request_human makes no device calls: its lease lasts as long as its handoff is pending.
    if (pendingHandoff(id)?.requestedBy === l.owner) { setExpiry(l); return l; }
    leases.delete(id);
    console.error(`[phonedockd] lease on ${id} held by ${l.owner} expired (${l.ttlSec ?? '?'} s without a call)`);
    logAction(id, 'daemon', { action: 'lease.expired', previousOwner: l.owner, ttlSec: l.ttlSec });
    emit('lease', { deviceId: id, lease: null, reason: 'expired', previousOwner: l.owner });
    invalidateDevices();
    return null;
  }
  return l;
}
/** The lease as clients see it: `stale: true` when its owner process has exited. */
export function leaseView(id: string): Lease | null {
  const l = getLease(id);
  return l && ownerGone(l.owner) ? { ...l, stale: true } : l;
}
/** Renew the owner's sliding lease (called for every device call the owner makes). */
export function touchLease(id: string, owner: string) {
  const l = getLease(id);
  if (l && l.owner === owner) setExpiry(l);
}
/** Drop `cur` if its owner process has exited; logs who reclaimed it. */
function reclaimStale(id: string, cur: Lease, by: string): boolean {
  if (!ownerGone(cur.owner)) return false;
  leases.delete(id);
  console.error(`[phonedockd] reclaimed the lease on ${id} from ${cur.owner} for ${by}: that process has exited`);
  logAction(id, by, { action: 'lease.reclaim', previousOwner: cur.owner, reason: 'owner process exited' });
  emit('lease', { deviceId: id, lease: null, reason: 'stale', previousOwner: cur.owner, reclaimedBy: by });
  invalidateDevices();
  return true;
}
const who = (owner: string) => (owner === HUMAN_OWNER ? 'the person at the Mac (app:human)' : owner);
function leaseConflict(id: string, cur: Lease): PhoneDockError {
  const h = pendingHandoff(id);
  const hints = cur.owner === HUMAN_OWNER
    ? ['A person is using this device (they took it over in the PhoneDock app). Wait until they hand it back, or ask them for it with a handoff request. It cannot be taken over from them.']
    : [`${cur.owner} is using this device. Wait for it to finish (agent leases end ${Math.round((cur.ttlSec ?? DEFAULT_AGENT_LEASE_SEC) / 60)} min after its last call), or ask the person to hand it back.`];
  if (h) hints.push(`A person was asked to do something on it (handoff ${h.id} by ${h.requestedBy}: ${JSON.stringify(h.reason.slice(0, 80))}).`);
  return new PhoneDockError(`The device is in use by ${who(cur.owner)}`, 'lease_conflict', 409, hints, [
    `Device ${id} is leased by ${cur.owner} since ${cur.acquiredAt}`,
    cur.expiresAt ? `The lease ends at ${cur.expiresAt} unless its owner uses the device again` : 'The lease is held until it is handed back',
  ].join('\n'));
}
export function acquireLease(id: string, owner: string, ttlSec?: number, force = false, log = true): Lease {
  let cur = getLease(id); let reclaimedFrom: string | undefined;
  if (cur && cur.owner !== owner && !force && reclaimStale(id, cur, owner)) { reclaimedFrom = cur.owner; cur = null; }
  if (cur && cur.owner !== owner && !force) throw leaseConflict(id, cur);
  const ttl = ttlSec && ttlSec > 0 ? Math.round(ttlSec) : owner === HUMAN_OWNER ? undefined : DEFAULT_AGENT_LEASE_SEC;
  const now = new Date();
  // The person taking the device from an agent remembers the agent, so Hand Back can return it.
  const preempted = owner === HUMAN_OWNER ? (cur && cur.owner !== HUMAN_OWNER ? { owner: cur.owner, ...(cur.ttlSec ? { ttlSec: cur.ttlSec } : {}), at: now.toISOString() } : cur?.preempted) : undefined;
  const l: Lease = { owner, acquiredAt: cur && cur.owner === owner ? cur.acquiredAt : now.toISOString(), expiresAt: null, ...(ttl ? { ttlSec: ttl } : {}), ...(preempted ? { preempted } : {}) };
  setExpiry(l, now.getTime());
  leases.set(id, l);
  // Activity: new holders only (not renewals). app:human taking a device = the app's Take Over.
  if (log && (!cur || cur.owner !== owner)) logAction(id, owner, { action: owner === HUMAN_OWNER ? 'lease.take_over' : 'lease.acquire', ...(cur ? { previousOwner: cur.owner } : {}) });
  emit('lease', { deviceId: id, lease: l, takeover: !!(cur && cur.owner !== owner), previousOwner: cur && cur.owner !== owner ? cur.owner : undefined });
  invalidateDevices();
  return reclaimedFrom ? { ...l, reclaimedFrom } : l;
}
export interface ReleaseResult { ok: true; released: boolean; heldBy?: string; note?: string; returnedTo?: string }
/** A readable name for an owner string: `mcp:claude-code:123` → Claude Code. */
export function ownerLabel(owner: string): string {
  const m = /^mcp:([^:]*):/.exec(owner); const n = m ? m[1] : owner.startsWith('sdk:') ? 'an SDK script' : owner.replace(/^cli:/, '');
  if (n === 'an SDK script') return n;
  return n.split(/[-_ ]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') || owner;
}
/** Release `owner`'s lease. Not holding it is not an error: nothing changes and the result says who holds it. */
export function releaseLease(id: string, owner: string, force = false): ReleaseResult {
  const h = pendingHandoff(id);
  if (h && h.requestedBy === owner && h.returnLease) h.returnLease = false;   // it let go: don't hand it back later
  const cur = getLease(id);
  if (!cur) return { ok: true, released: false, note: 'The device was not leased.' };
  if (cur.owner !== owner && !force) {
    return { ok: true, released: false, heldBy: cur.owner, note: `You don't hold this device's lease (${who(cur.owner)} does), so there was nothing to release.` };
  }
  leases.delete(id);
  // Hand Back: the device returns to the agent the person took it from, if that session is still alive.
  const back = cur.owner === HUMAN_OWNER ? cur.preempted : undefined;
  const returnTo = back && !ownerGone(back.owner) ? back : undefined;
  logAction(id, owner, {
    action: owner === HUMAN_OWNER ? 'lease.hand_back' : 'lease.release',
    ...(cur.owner !== owner ? { previousOwner: cur.owner } : {}),
    ...(returnTo ? { returnedTo: returnTo.owner, summary: `Handed back to ${ownerLabel(returnTo.owner)}` } : {}),
    ...(back && !returnTo ? { previousAgent: back.owner, summary: `${ownerLabel(back.owner)} is gone, so the phone is free` } : {}),
  });
  emit('lease', { deviceId: id, lease: null, releasedBy: owner });
  if (returnTo) {
    acquireLease(id, returnTo.owner, returnTo.ttlSec, false, false);
    return { ok: true, released: true, returnedTo: returnTo.owner, note: `The device went back to ${ownerLabel(returnTo.owner)}.` };
  }
  invalidateDevices();
  return { ok: true, released: true, ...(back ? { note: `${ownerLabel(back.owner)} is no longer running, so the device is now free.` } : {}) };
}
/** Throws lease_conflict unless `owner` may act on the device: it holds the lease (renewed), nobody does, the holder's
 *  process has exited (reclaimed), or it is the person (`app:human`) while a handoff is pending on the device. */
export function checkLease(id: string, owner: string) {
  const cur = getLease(id);
  if (!cur) return;
  if (cur.owner === owner) { setExpiry(cur); return; }
  if (owner === HUMAN_OWNER && pendingHandoff(id)) return;
  if (reclaimStale(id, cur, owner)) return;
  throw leaseConflict(id, cur);
}
/** Test hook. */
export function clearLeases() { leases.clear(); }

// ── transitions the daemon is carrying out on a device ─────────────────────
// 'stopping': a shutdown is running (the device shows "stopping" at once, not "running" until it is gone).
// 'restoring' / 'restarting': the device is expected to blink; not a crash.
export type Transition = 'stopping' | 'restoring' | 'restarting';
const transitions = new Map<string, Transition>();
const recentlyStopped = new Map<string, number>();   // device id → when the daemon last stopped it on purpose
export function transitionOf(id: string): Transition | undefined { return transitions.get(id); }
export async function withTransition<T>(id: string, kind: Transition, fn: () => Promise<T>): Promise<T> {
  transitions.set(id, kind);
  invalidateDevices();
  try { return await fn(); }
  finally { transitions.delete(id); if (kind !== 'restoring') recentlyStopped.set(id, Date.now()); invalidateDevices(); }
}
/** A stopped phone has no one in control: the person's lease (and what it remembers) ends with the shutdown. */
export function dropLeaseOnStop(id: string) {
  const l = leases.get(id);
  if (!l) return;
  leases.delete(id);
  emit('lease', { deviceId: id, lease: null, reason: 'stopped', previousOwner: l.owner });
}

// ── devices (aggregated, 2s cache) ──────────────────────────────────────────
let devCache: { at: number; list: Device[] } | undefined;
let devPending: Promise<Device[]> | undefined;
export function invalidateDevices() { devCache = undefined; if (sseClients.size) setTimeout(() => void pollDevices(), 50); }
/** A fresh read of the screen (UI tree, screenshot) has this size: when the cached list says otherwise (the screen
 *  turned since), drop the cache so Device.screen / orientation follow at once instead of up to 2 s later. */
export function noteScreen(id: string, width?: number, height?: number) {
  if (!width || !height || !devCache) return;
  const d = devCache.list.find((x) => x.id === id);
  if (d?.screen?.width && (d.screen.width !== width || d.screen.height !== height)) invalidateDevices();
}
const listErrors = new Map<string, string>();
// Last successful listing per backend. A slow/failed listDevices (e.g. simctl under heavy load) must not
// make that backend's devices "vanish" mid-task for agents — serve the last good list, marked stale.
const lastGood = new Map<string, Device[]>();
export async function listDevices(fresh = false): Promise<Device[]> {
  if (!fresh && devCache && Date.now() - devCache.at < 2000) return applyFilter(decorate(devCache.list));
  if (!devPending) {
    devPending = (async () => {
      const lists = await Promise.all(backends.map(async (b) => {
        try { const l = await withTimeout(b.listDevices(), 30_000, `${b.id}.listDevices`); listErrors.delete(b.id); lastGood.set(b.id, l); return l; }
        catch (e) {
          listErrors.set(b.id, (e as Error).message);
          return (lastGood.get(b.id) ?? []).map((d) => ({ ...d, meta: { ...(d.meta ?? {}), stale: true, listError: (e as Error).message } }));
        }
      }));
      const list = lists.flat();
      devCache = { at: Date.now(), list };
      return list;
    })().finally(() => { devPending = undefined; });
  }
  const list = applyFilter(decorate(await devPending));
  refreshScreens(list);
  return list;
}

// Device.screen follows the screen as it is turned: backends keep it from screenshots, streams and rotations, and
// here every running device's screen is read once it starts (also after a restore, a reboot or a daemon restart),
// then every SCREEN_REFRESH_MS while someone watches its live view (an app can turn the screen by itself).
// Only devices this service may control.
export const SCREEN_REFRESH_MS = 10_000;
const screenReads = new Map<string, number>();   // device id → when its screen was last read
function refreshScreens(list: Device[]) {
  const now = Date.now();
  for (const d of list) {
    if (d.state !== 'running') { screenReads.delete(d.id); continue; }
    const last = screenReads.get(d.id);
    if (last !== undefined && (now - last < SCREEN_REFRESH_MS || !isStreaming(d.id))) continue;
    const b = backends.find((x) => x.id === d.backend);
    if (!b?.screenInfo) continue;
    screenReads.set(d.id, now);
    void withTimeout(b.screenInfo(d.nativeId), 20_000, `${b.id}.screenInfo`).then((s) => {
      if (s.width !== d.screen?.width || s.height !== d.screen?.height) invalidateDevices();
    }, () => undefined);
  }
}
function decorate(list: Device[]): Device[] {
  return list.map((d) => {
    const r = record(d.id);
    const out: Device = { ...d, lease: leaseView(d.id), handoff: pendingHandoff(d.id) };
    if (d.screen?.width && d.screen.height) out.orientation = d.screen.width > d.screen.height ? 'landscape' : 'portrait';
    if (r?.name) out.name = r.name;
    if (r) out.spec = { ...(d.spec ?? {}), ...(r.spec ?? {}), autoStart: !!r.autoStart };
    if (r && !d.managed) out.managed = true;
    if ((transitions.get(d.id) === 'stopping' || transitions.get(d.id) === 'restarting') && (d.state === 'running' || d.state === 'stopped' || d.state === 'offline')) out.state = 'stopping';   // until the shutdown call returns
    // A phone that isn't running isn't in anyone's hands (a stale lease from before it stopped is not shown).
    if (out.lease && (out.state === 'stopped' || out.state === 'stopping') && out.lease.owner === HUMAN_OWNER) out.lease = null;
    const job = activeDeviceJob(d.id);
    if (job && (d.state === 'stopped' || d.state === 'offline')) out.state = job.kind === 'create' ? 'creating' : job.kind === 'boot' ? 'booting' : out.state;
    return out;
  });
}
export async function getDevice(id: string, fresh = false): Promise<Device> {
  const { backend } = splitId(id);
  getBackend(backend);
  let d = (await listDevices(fresh)).find((x) => x.id === id);
  if (!d && !fresh) d = (await listDevices(true)).find((x) => x.id === id);
  if (!d && deviceFilter) throw filteredOut(id);
  if (!d) throw new PhoneDockError("Couldn’t find the device", 'not_found', 404, ["Check the list of available devices."], `No device ${id}`);
  return d;
}
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new PhoneDockError("The operation timed out", 'timeout', 504, undefined, `${what} timed out`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// ── jobs ────────────────────────────────────────────────────────────────────
export interface Job { id: string; kind: string; state: 'running' | 'done' | 'failed'; progress: string[]; result?: unknown; error?: { code: string; message: string; hints?: string[]; detail?: string }; startedAt: string; endedAt?: string; deviceId?: string }
const jobs = new Map<string, Job>();
export function getJob(id: string): Job {
  const j = jobs.get(id); if (!j) throw new PhoneDockError("Couldn’t find the job", 'not_found', 404, undefined, `No job ${id}`); return j;
}
export function listJobs(): Job[] { return [...jobs.values()].reverse(); }
function activeDeviceJob(deviceId: string): Job | undefined {
  for (const j of jobs.values()) if (j.deviceId === deviceId && j.state === 'running') return j;
  return undefined;
}
export function startJob(kind: string, fn: (progress: (l: string) => void, job: Job) => Promise<unknown>, deviceId?: string): Job {
  const job: Job = { id: randomBytes(6).toString('hex'), kind, state: 'running', progress: [], startedAt: new Date().toISOString(), deviceId };
  jobs.set(job.id, job);
  if (jobs.size > 300) { const first = jobs.keys().next().value; if (first) jobs.delete(first); }
  let lastEmit = 0;
  const progress = (l: string) => {
    job.progress.push(`${new Date().toTimeString().slice(0, 8)} ${l}`);   // local time, like the rest of what people read
    if (job.progress.length > 50) job.progress.splice(0, job.progress.length - 50);
    if (Date.now() - lastEmit > 1000) { lastEmit = Date.now(); emit('job', job); }
  };
  emit('job', job);
  if (deviceId) invalidateDevices();
  void (async () => {
    try { job.result = await fn(progress, job); job.state = 'done'; }
    catch (e) {
      const pe = e as PhoneDockError;
      job.state = 'failed';
      job.error = { code: pe.code ?? 'internal', message: pe.message ?? String(e), hints: pe.hints, detail: pe.detail ?? (e instanceof Error && !(e instanceof PhoneDockError) ? e.stack : undefined) };
      progress(`failed: ${job.error.message}`);
    }
    job.endedAt = new Date().toISOString();
    emit('job', job);
    invalidateDevices();
  })();
  return job;
}

// ── SSE events ──────────────────────────────────────────────────────────────
export const sseClients = new Set<ServerResponse>();
export function emit(event: string, data: unknown) {
  if (!sseClients.size) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) { try { c.write(msg); } catch { sseClients.delete(c); } }
}
let lastSeen = new Map<string, string>();
let lastDevices = new Map<string, Device>();
let polling = false;
export async function pollDevices() {
  if (polling) return; polling = true;
  try {
    const list = await listDevices(true);
    const seen = new Map<string, string>();
    for (const d of list) {
      const was = lastDevices.get(d.id);
      if (was?.state === 'running' && (d.state === 'stopped' || d.state === 'offline') && !transitions.has(d.id) && Date.now() - (recentlyStopped.get(d.id) ?? 0) > 15_000 && !(d.meta as { stale?: boolean } | undefined)?.stale) {
        const virtual = d.kind === 'virtual';
        logAction(d.id, 'daemon', { action: virtual ? 'device.crashed' : 'device.disconnected', summary: virtual ? `${d.name} stopped unexpectedly` : `${d.name} disconnected` });
        dropLeaseOnStop(d.id);
      }
      const key = JSON.stringify([d.state, d.name, d.lease, d.error, d.managed, d.handoff?.id ?? null, d.screen?.width ?? null, d.screen?.height ?? null]);
      seen.set(d.id, key);
      if (lastSeen.get(d.id) !== key) emit('device', d);
    }
    for (const [id] of lastSeen) if (!seen.has(id)) emit('device', { ...(lastDevices.get(id) ?? { id }), state: 'unknown', removed: true });
    lastSeen = seen; lastDevices = new Map(list.map((d) => [d.id, d]));
  } catch { /* ignore */ } finally { polling = false; }
}
setInterval(() => { if (sseClients.size) void pollDevices(); }, 3000).unref();
setInterval(() => { for (const c of sseClients) { try { c.write(': ping\n\n'); } catch { /* */ } } }, 15_000).unref();

// ── action log ──────────────────────────────────────────────────────────────
export const safeId = (id: string) => id.replace(/[^A-Za-z0-9._-]+/g, '_');
/** Secret text never reaches the log or SSE: `{action:'type', secret:true}` is stored as '•••' + length. */
export function maskAction(action: unknown): unknown {
  const a = action as { action?: string; text?: unknown; secret?: boolean; value?: unknown } | null;
  if (!a || typeof a !== 'object' || !a.secret) return action;
  if (a.action === 'type') return { action: 'type', text: '•••', length: typeof a.text === 'string' ? [...a.text].length : 0, secret: true };
  const { value, text, ...rest } = a;
  return { ...rest, ...(value !== undefined ? { value: '•••', length: String(value).length } : {}), ...(text !== undefined ? { text: '•••' } : {}), secret: true };
}
/** When each device last had an action logged (ms). src/daemon/observe.ts uses it. */
export const lastActionAt = new Map<string, number>();
/** Actions logged per device (src/daemon/delivery.ts: did a request send anything?). */
export const actionCount = new Map<string, number>();
export function logAction(deviceId: string, owner: string, action: unknown, extra?: Record<string, unknown>) {
  const entry = { at: new Date().toISOString(), owner, action: maskAction(action), ...extra };
  lastActionAt.set(deviceId, Date.now());
  actionCount.set(deviceId, (actionCount.get(deviceId) ?? 0) + 1);
  try { appendFileSync(join(stateDir('devices', safeId(deviceId)), 'actions.jsonl'), JSON.stringify(entry) + '\n'); } catch { /* */ }
  emit('action', { deviceId, ...entry });
}
export function readActions(deviceId: string, limit: number): unknown[] {
  const f = join(stateDir('devices', safeId(deviceId)), 'actions.jsonl');
  if (!existsSync(f)) return [];
  const size = statSync(f).size;
  const want = Math.min(size, Math.max(64 * 1024, limit * 600));
  const fd = openSync(f, 'r'); const buf = Buffer.alloc(want);
  readSync(fd, buf, 0, want, size - want); closeSync(fd);
  const lines = buf.toString('utf8').split('\n').filter(Boolean);
  if (want < size) lines.shift();
  return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ── UI tree cache (ref → element) ───────────────────────────────────────────
/** Called with every fresh tree put in the cache (src/daemon/observe.ts notes what was on screen for `flow save`). */
export const uiCacheListeners: ((deviceId: string, tree: UiTree) => void)[] = [];
class UiCache extends Map<string, UiTree> {
  set(id: string, tree: UiTree): this {
    super.set(id, tree);
    for (const f of uiCacheListeners) { try { f(id, tree); } catch { /* best effort */ } }
    return this;
  }
}
export const uiCache = new UiCache();

// ── shared live frame streams ───────────────────────────────────────────────
/** A screenshot-based frame served while the live stream has not delivered its first frame. */
export interface FallbackFrame { data: Buffer; etag: string; at: number; headers: Record<string, string | number> }
interface SharedStream {
  key: string; stream: FrameStream; latest?: Buffer; etag?: string; latestAt: number; viewers: number; lastAccess: number;
  screen?: ScreenInfo;   // the device screen the latest frame shows (when the backend says)
  listeners: Set<(j: Buffer) => void>; ended: boolean; err?: Error; startedAt: number; firstFrameAt?: number;
  fallback?: FallbackFrame; fallbackPending?: Promise<FallbackFrame>; fallbackCaptures: number;
}
const streams = new Map<string, SharedStream>();
/** Minimum gap between two fallback captures of one stream (each is a screencap + JPEG conversion). */
export const FALLBACK_MIN_INTERVAL_MS = 1000;

/** Resolves when the stream has a frame (immediately if it already has one) or after `ms`. */
export function waitForStreamFrame(s: { latest?: Buffer; listeners: Set<(j: Buffer) => void> }, ms: number, signal?: AbortSignal): Promise<boolean> {
  if (s.latest) return Promise.resolve(true);
  if (ms <= 0 || signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (v: boolean) => { clearTimeout(t); s.listeners.delete(on); signal?.removeEventListener('abort', onAbort); resolve(v); };
    const on = () => done(true);
    const onAbort = () => done(false);
    const t = setTimeout(() => done(false), ms);
    s.listeners.add(on);
    signal?.addEventListener('abort', onAbort);
  });
}

/** The stream's fallback frame: at most one capture in flight per stream (concurrent callers share it) and at most
 *  one per `minIntervalMs`; between captures callers get the last one, so `If-None-Match` polls see 304s. */
export function fallbackFrame(
  s: { fallback?: FallbackFrame; fallbackPending?: Promise<FallbackFrame>; fallbackCaptures: number },
  capture: () => Promise<{ data: Buffer; headers: Record<string, string | number> }>,
  minIntervalMs = FALLBACK_MIN_INTERVAL_MS, now = Date.now(),
): Promise<FallbackFrame> {
  if (s.fallback && now - s.fallback.at < minIntervalMs) return Promise.resolve(s.fallback);
  if (s.fallbackPending) return s.fallback ? Promise.resolve(s.fallback) : s.fallbackPending;
  s.fallbackCaptures++;
  const p = capture().then((r) => {
    const f: FallbackFrame = { data: r.data, headers: r.headers, at: Date.now(), etag: s.fallback?.data.equals(r.data) ? s.fallback.etag : `"${randomBytes(16).toString('hex')}"` };
    s.fallback = f;
    return f;
  }).finally(() => { if (s.fallbackPending === p) s.fallbackPending = undefined; });
  s.fallbackPending = p;
  return s.fallback ? Promise.resolve(s.fallback) : p;
}
export function sharedStream(deviceId: string, maxSize: number, fps = 15): SharedStream {
  const key = `${deviceId}|${maxSize}`;
  let s = streams.get(key);
  if (s && !s.ended) { s.lastAccess = Date.now(); return s; }
  const { backend, nativeId } = splitId(deviceId);
  const b = getBackend(backend);
  if (!b.stream) throw new PhoneDockError("Live streaming is unavailable for this device", 'not_supported', 501, undefined, `${backend} has no live stream`);
  const stream = b.stream(nativeId, { maxSize, fps: Math.max(fps, 15) });
  const ns: SharedStream = { key, stream, latestAt: 0, viewers: 0, lastAccess: Date.now(), listeners: new Set(), ended: false, startedAt: Date.now(), fallbackCaptures: 0 };
  stream.onFrame((j, screen) => {
    if (!ns.latest || !ns.latest.equals(j)) ns.etag = `"${randomBytes(16).toString('hex')}"`;
    ns.latest = j; ns.screen = screen; ns.latestAt = Date.now(); ns.firstFrameAt ??= ns.latestAt; ns.fallback = undefined;
    for (const l of [...ns.listeners]) l(j);
  });
  stream.onEnd((e) => { ns.ended = true; ns.err = e; if (streams.get(key) === ns) streams.delete(key); });
  streams.set(key, ns);
  return ns;
}
/** A stream with no viewers is stopped this long after its last one left (a viewer that comes back, e.g. switching
 *  devices in the app and back, gets the running stream: the picture at once). */
const STREAM_LINGER_MS = 5_000;
setInterval(() => {
  for (const [k, s] of streams) {
    if (s.viewers <= 0 && Date.now() - s.lastAccess > STREAM_LINGER_MS) { s.ended = true; streams.delete(k); try { s.stream.stop(); } catch { /* */ } }
  }
  for (const [k, v] of videos) {
    if (v.viewers <= 0 && Date.now() - v.lastAccess > STREAM_LINGER_MS) endVideo(k, v);
  }
}, 1000).unref();
function isStreaming(deviceId: string): boolean {
  for (const [k, s] of streams) if (k.startsWith(deviceId + '|') && !s.ended) return true;
  for (const [k, v] of videos) if (k.startsWith(deviceId + '|') && !v.ended) return true;
  return false;
}
export function stopStreamsFor(deviceId: string) {
  for (const [k, s] of streams) if (k.startsWith(deviceId + '|')) { s.ended = true; streams.delete(k); try { s.stream.stop(); } catch { /* */ } }
  for (const [k, v] of videos) if (k.startsWith(deviceId + '|')) endVideo(k, v);
}
/** The screen turned: streams that can restart at the new size do (viewers keep the last frame meanwhile); others stop
 *  and the next viewer starts a fresh one. */
export function restartStreamsFor(deviceId: string) {
  for (const [k, s] of streams) {
    if (!k.startsWith(deviceId + '|')) continue;
    if (s.stream.restart) { try { s.stream.restart(); } catch { /* */ } continue; }
    s.ended = true; streams.delete(k); try { s.stream.stop(); } catch { /* */ }
  }
  for (const [k, v] of videos) {
    if (!k.startsWith(deviceId + '|')) continue;
    if (v.stream.restart) { try { v.stream.restart(); } catch { /* */ } continue; }
    endVideo(k, v);
  }
}
export function streamStats() {
  return [
    ...[...streams.values()].map((s) => ({ key: s.key, kind: 'jpeg', viewers: s.viewers, hasFrame: !!s.latest, ageMs: s.latestAt ? Date.now() - s.latestAt : null, firstFrameMs: s.latestAt && s.firstFrameAt ? s.firstFrameAt - s.startedAt : null, fallbackCaptures: s.fallbackCaptures })),
    ...[...videos.values()].map((v) => ({ key: v.key, kind: 'video', viewers: v.viewers, hasFrame: v.fanout.cache.decodable, ageMs: v.lastFrameAt ? Date.now() - v.lastFrameAt : null, firstFrameMs: v.firstFrameAt ? v.firstFrameAt - v.startedAt : null,
      frames: v.frames, cachedFrames: v.fanout.cache.frames.length, cachedBytes: v.fanout.cache.bytes, dropped: v.fanout.dropped, resyncs: v.fanout.resyncs })),
  ];
}

// ── shared live video ───────────────────────────────────────────────────────
/** One backend video stream per device (and size), fanned out to the GET /video viewers. Each viewer starts from the
 *  fan-out's cache (screen, config, the frames since the key frame) and is dropped back to a resync if it falls
 *  behind (src/core/video.ts). */
export interface SharedVideo {
  key: string; deviceId: string; stream: VideoStream; fanout: VideoFanout;
  viewers: number; lastAccess: number; ended: boolean; err?: Error;
  startedAt: number; firstFrameAt?: number; lastFrameAt?: number; frames: number;
  /** Called when the stream ends (its viewers' responses are closed). */
  endListeners: Set<(err?: Error) => void>;
  /** A screenshot for viewers that join before the first frame (shared by them, at most one in flight). */
  still?: Promise<{ data: Buffer; at: number } | undefined>;
}
const videos = new Map<string, SharedVideo>();
function endVideo(k: string, v: SharedVideo, err?: Error) {
  if (videos.get(k) === v) videos.delete(k);
  if (v.ended) return;
  v.ended = true; v.err = err;
  try { v.stream.stop(); } catch { /* */ }
  for (const l of [...v.endListeners]) { try { l(err); } catch { /* */ } }
}
export function sharedVideo(deviceId: string, maxSize: number): SharedVideo {
  const key = `${deviceId}|${maxSize}`;
  const s = videos.get(key);
  if (s && !s.ended) { s.lastAccess = Date.now(); return s; }
  const { backend, nativeId } = splitId(deviceId);
  const b = getBackend(backend);
  if (!b.video) throw new PhoneDockError('Live video is unavailable for this device', 'not_supported', 501, ['Use GET /v1/devices/:id/frame (JPEG) instead.'], `${backend} has no live video`);
  const stream = b.video(nativeId, { maxSize });
  const fanout = new VideoFanout();
  const v: SharedVideo = { key, deviceId, stream, fanout, viewers: 0, lastAccess: Date.now(), ended: false, startedAt: Date.now(), frames: 0, endListeners: new Set() };
  fanout.onNeedKeyFrame = () => { try { stream.requestKeyFrame?.(); } catch { /* */ } };
  stream.onPacket((p) => {
    if (v.ended) return;
    if (p.type === 'frame') { v.frames++; v.lastFrameAt = Date.now(); v.firstFrameAt ??= v.lastFrameAt; }
    else if (p.type === 'screen') noteScreen(deviceId, p.screen.width, p.screen.height);
    fanout.packet(p);
  });
  stream.onEnd((e) => endVideo(key, v, e));
  videos.set(key, v);
  return v;
}

// ── human handoffs ──────────────────────────────────────────────────────────
// In memory only (a daemon restart drops them; requesters then see 404 and may ask again).
const handoffs = new Map<string, Handoff>();
const handoffTimers = new Map<string, NodeJS.Timeout>();
const handoffWaiters = new Map<string, Set<(h: Handoff) => void>>();
const handoffLeaseTtl = new Map<string, number>();   // handoff id → the requester's lease TTL, restored with the lease
export function pendingHandoff(deviceId: string): Handoff | null {
  for (const h of handoffs.values()) if (h.deviceId === deviceId && h.state === 'pending') return h;
  return null;
}
export function getHandoff(hid: string): Handoff {
  const h = handoffs.get(hid);
  if (!h) throw new PhoneDockError("Couldn’t find the handoff", 'not_found', 404, ["Check the list of handoffs."], `No handoff ${hid} (handoffs do not survive a daemon restart)`);
  return h;
}
export function listHandoffs(state?: HandoffState): Handoff[] {
  return [...handoffs.values()].filter((h) => !state || h.state === state).reverse();
}
function finishHandoff(h: Handoff) {
  const t = handoffTimers.get(h.id); if (t) { clearTimeout(t); handoffTimers.delete(h.id); }
  emit('handoff', h);
  for (const w of handoffWaiters.get(h.id) ?? []) w(h);
  handoffWaiters.delete(h.id);
  invalidateDevices();
}
/** The requester made no device calls while it waited: restart its lease's TTL as the handoff ends (before the state
 *  changes, while getLease still keeps it), so it has the full TTL to carry on. */
function keepRequesterLease(h: Handoff) {
  const l = getLease(h.deviceId);
  if (l && l.owner === h.requestedBy) setExpiry(l);
}
export function createHandoff(deviceId: string, reason: string, requestedBy: string, timeoutSec = 900): Handoff {
  const cur = pendingHandoff(deviceId);
  if (cur) throw new PhoneDockError("The device already has a pending handoff", 'handoff_pending', 409, ["Wait for the handoff or resolve it."], [`Device already has a pending handoff (${cur.id}, requested by ${cur.requestedBy}: ${JSON.stringify(cur.reason.slice(0, 80))})`, 'Wait for the person to finish it (or cancel it in the PhoneDock app)'].join('\n'));
  const ttl = Math.max(10, Math.min(Number.isFinite(timeoutSec) ? timeoutSec : 900, 24 * 3600));
  const now = Date.now();
  const lease = getLease(deviceId);
  const h: Handoff = {
    id: randomBytes(5).toString('hex'), deviceId, reason: reason.slice(0, 2000), requestedBy, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + ttl * 1000).toISOString(), state: 'pending',
    leaseHolder: lease?.owner ?? null, returnLease: lease?.owner === requestedBy,
  };
  if (lease?.owner === requestedBy && lease.ttlSec) handoffLeaseTtl.set(h.id, lease.ttlSec);
  handoffs.set(h.id, h);
  logAction(deviceId, requestedBy, { action: 'handoff.requested', handoffId: h.id, reason: h.reason, timeoutSec: ttl });
  if (handoffs.size > 200) for (const [k, v] of handoffs) { if (handoffs.size <= 200) break; if (v.state !== 'pending') handoffs.delete(k); }
  const timer = setTimeout(() => {
    if (h.state !== 'pending') return;
    keepRequesterLease(h);
    h.state = 'timeout'; h.resolvedAt = new Date().toISOString(); h.resolvedBy = 'daemon';
    handoffLeaseTtl.delete(h.id); h.leaseHolder = getLease(h.deviceId)?.owner ?? null;
    logAction(h.deviceId, 'daemon', { action: 'handoff.timeout', handoffId: h.id, reason: h.reason });
    finishHandoff(h);
  }, ttl * 1000);
  timer.unref();
  handoffTimers.set(h.id, timer);
  emit('handoff', h);
  invalidateDevices();
  return h;
}
export function resolveHandoff(hid: string, state: 'done' | 'cancelled', by: string, note?: string): Handoff {
  const h = getHandoff(hid);
  if (h.state !== 'pending') throw new PhoneDockError("The handoff has already been resolved", 'handoff_resolved', 409, undefined, `Handoff ${hid} is already ${h.state}`);
  keepRequesterLease(h);
  h.state = state; h.resolvedAt = new Date().toISOString(); h.resolvedBy = by;
  if (note) h.note = note.slice(0, 4000);
  // Activity: Done (with the person's note) / Can't Do It (with their reason)
  logAction(h.deviceId, by, { action: state === 'done' ? 'handoff.done' : 'handoff.cancelled', handoffId: h.id, ...(h.note ? { [state === 'done' ? 'note' : 'reason']: h.note } : {}) });
  // The person took the device over (Take Over = an app:human lease) to do what the agent asked: give it back to the
  // agent, if the agent held it when it asked (and hasn't let go or exited since).
  const cur = getLease(h.deviceId);
  if (h.returnLease && cur?.owner === HUMAN_OWNER && !ownerGone(h.requestedBy)) {
    acquireLease(h.deviceId, h.requestedBy, handoffLeaseTtl.get(h.id), true, false);
    h.leaseReturned = true;
    logAction(h.deviceId, 'daemon', { action: 'lease.returned', to: h.requestedBy, from: HUMAN_OWNER, handoffId: h.id });
  }
  handoffLeaseTtl.delete(h.id);
  h.leaseHolder = getLease(h.deviceId)?.owner ?? null;
  finishHandoff(h);
  return h;
}
/** Resolve when the handoff leaves 'pending' or after waitMs (returns it either way). */
export function waitHandoff(hid: string, waitMs: number, signal?: { onClose: (cb: () => void) => void }): Promise<Handoff> {
  const h = getHandoff(hid);
  if (h.state !== 'pending' || waitMs <= 0) return Promise.resolve(h);
  return new Promise((resolve) => {
    const set = handoffWaiters.get(hid) ?? new Set(); handoffWaiters.set(hid, set);
    const done = (x: Handoff) => { clearTimeout(t); set.delete(done); resolve(x); };
    const t = setTimeout(() => done(h), waitMs);
    set.add(done);
    signal?.onClose(() => done(h));
  });
}

// ── screen recordings (one per device) ──────────────────────────────────────
export interface RecordingState { deviceId: string; path: string; startedAt: string; maxSeconds: number; owner: string; timer?: NodeJS.Timeout; stopping?: Promise<RecordingResult> }
export interface RecordingResult { path: string; sizeBytes: number; durationSec: number; autoStopped?: boolean; warning?: string }
export const recordings = new Map<string, RecordingState>();
/** Stop (and finalize) a device's recording if one is active; never throws. Used on stop/auto-stop/shutdown/delete. */
export async function stopRecordingFor(deviceId: string, reason?: string): Promise<RecordingResult | undefined> {
  const rec = recordings.get(deviceId);
  if (!rec) return undefined;
  if (rec.stopping) return rec.stopping;
  if (rec.timer) clearTimeout(rec.timer);
  rec.stopping = (async () => {
    let path = rec.path; let warning: string | undefined;
    const stopAt = Date.now();   // finalizing takes seconds: that time is not in the recording
    try {
      const { backend, nativeId } = splitId(deviceId);
      const b = getBackend(backend);
      if (b.stopRecording) path = (await withTimeout(b.stopRecording(nativeId), 60_000, `${b.id}.stopRecording`)) || rec.path;
    } catch (e) { warning = `stopRecording failed: ${(e as Error).message}`; }
    let sizeBytes = 0; try { sizeBytes = statSync(path).size; } catch { warning ??= `recording file missing: ${path}`; }
    // The length of the video itself; the time between start and stop only when the file can't be read.
    let durationSec = Math.round((stopAt - Date.parse(rec.startedAt)) / 100) / 10;
    const probed = sizeBytes ? await probeVideo(path).catch(() => undefined) : undefined;
    if (probed?.duration && probed.duration > 0) durationSec = Math.round(probed.duration * 10) / 10;
    const res: RecordingResult = { path, sizeBytes, durationSec, ...(reason ? { autoStopped: true } : {}), ...(warning ? { warning } : {}) };
    recordings.delete(deviceId);
    emit('recording', { deviceId, active: false, ...res, reason });
    return res;
  })();
  return rec.stopping;
}
