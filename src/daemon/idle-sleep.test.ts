import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhoneDockError, type Backend, type Device, type DeviceState, type SleepState, type VideoPacket, type VideoStream, type WakeReport } from '../core/types.ts';
import type { Ctx } from './http.ts';

process.env.PHONEDOCK_HOME = mkdtempSync(join(tmpdir(), 'pd-idle-'));
delete process.env.PHONEDOCK_DEVICE_FILTER;   // core.ts reads it on import (idle-sleep-filter.test.ts covers the filter)
delete process.env.PHONEDOCK_IDLE_SLEEP;
const core = await import('./core.ts');
const { router } = await import('./routes.ts');
await import('./routes-extra.ts');
await import('./routes-idle.ts');
const S = await import('./idle-sleep.ts');
// These tests are of the sleeper (the app's service); CI and test runs set PHONEDOCK_PORT to a spare port.
S.setIdleSleepRoleForTests({ sleeper: true });

// ── a fake sleep-capable backend ────────────────────────────────────────────
interface Deferred { promise: Promise<void>; resolve: () => void }
const deferred = (): Deferred => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
const states = new Map<string, DeviceState>();
const managed = new Map<string, boolean>();
let calls: string[] = [];
const hooks: { save?: () => Promise<void>; sync?: () => Promise<void>; stop?: () => Promise<void>; wake?: () => Promise<void>; del?: () => Promise<void>; guest?: () => Promise<string | undefined>;
  saveError?: PhoneDockError; stopError?: PhoneDockError; wakeReport?: WakeReport; wakeLeavesStopped?: boolean; window?: boolean; listDelayMs?: number; avdGone?: boolean;
  listFails?: boolean; bootError?: PhoneDockError } = {};
let wakeOpts: Record<string, unknown>[] = [];
let videoListeners: ((p: VideoPacket) => void)[] = [];
let framesAsleep = false;
const fake = {
  id: 'fake-emu', displayName: 'Fake emulator', platform: 'android', kind: 'virtual', capabilities: ['boot', 'shutdown', 'video'],
  async available() { return { ok: true }; },
  async listDevices(): Promise<Device[]> {
    if (hooks.listDelayMs) await new Promise((r) => setTimeout(r, hooks.listDelayMs));   // adb takes a while
    if (hooks.listFails) throw new Error('adb devices failed');
    return [...states].map(([nid, state]) => ({
      id: `fake-emu:${nid}`, backend: 'fake-emu', nativeId: nid, name: nid, platform: 'android', kind: 'virtual', state,
      managed: managed.get(nid) ?? true, connection: 'local', capabilities: ['boot', 'shutdown', 'video'],
    }));
  },
  async boot(nid: string) { calls.push(`boot:${nid}`); if (hooks.bootError) throw hooks.bootError; states.set(nid, 'running'); },
  async openWindow(nid: string) {   // like the emulator's: a stopped one boots with its window; a running one needs scrcpy
    calls.push(`window:${nid}`);
    if (states.get(nid) === 'running') throw new PhoneDockError('The emulator window could not be opened', 'scrcpy_missing', 501);
    states.set(nid, 'running');
  },
  async shutdown(nid: string) { calls.push(`shutdown:${nid}`); states.set(nid, 'stopped'); },
  async screenshot() { return Buffer.alloc(0); },
  async tap() {}, async swipe() {}, async type() {}, async key() {},
  async prepareSleep(nid: string): Promise<SleepState> {
    calls.push(`prepare:${nid}`);
    await hooks.save?.();
    if (hooks.saveError) throw hooks.saveError;
    return { at: new Date().toISOString(), bootId: 'boot-1', uptimeSec: 100 };
  },
  async stopForSleep(nid: string, st: SleepState, opts: { confirm?: () => string | undefined } = {}) {
    await hooks.sync?.();                          // the guest's sync: what comes meanwhile meets the last look
    const why = opts.confirm?.();
    if (why) throw new PhoneDockError(`It keeps running: ${why}`, 'sleep_called_off', 409);
    calls.push(`stop:${nid}`); await hooks.stop?.(); states.set(nid, 'stopped');
    if (hooks.stopError) throw hooks.stopError;
    return { ...st, exitSave: { mtimeMs: 1 } };
  },
  async wakeFromSleep(nid: string, _st: SleepState, opts: Record<string, unknown> = {}) {
    calls.push(`wake:${nid}`); wakeOpts.push(opts); await hooks.wake?.();
    if (!hooks.wakeLeavesStopped) states.set(nid, 'running');
    return hooks.wakeReport ?? { resumed: true, via: 'quickboot' as const };
  },
  async delete(nid: string) { calls.push(`delete:${nid}`); await hooks.del?.(); states.delete(nid); },
  async deleteSnapshot(nid: string, n: string) { calls.push(`snapshot-delete:${nid}:${n}`); },
  async restoreSnapshot(nid: string, n: string) { calls.push(`snapshot-restore:${nid}:${n}`); },
  async checkSleeping() { if (hooks.avdGone) throw new PhoneDockError('PhoneDock’s emulator is gone', 'not_found', 404); },
  async listSnapshots() { return ['phonedock_sleep', 'default_boot', 'mine'].map((name) => ({ name, createdAt: new Date().toISOString() })); },
  async keepAwake(_nid: string, opts: { guest?: boolean } = {}) { return hooks.window ? 'its emulator window is open' : opts.guest ? hooks.guest?.() : undefined; },
  stream() { return { onFrame() {}, onEnd() {}, stop() {}, asleep: () => framesAsleep }; },
  video(): VideoStream {
    return { onPacket: (cb: (p: VideoPacket) => void) => { videoListeners.push(cb); }, onEnd() {}, stop() {} };
  },
} as unknown as Backend;
// No saveSleep: like an iOS simulator.
const plain = {
  id: 'fake-sim', displayName: 'Fake simulator', platform: 'ios', kind: 'virtual', capabilities: ['boot'],
  async available() { return { ok: true }; },
  async listDevices(): Promise<Device[]> { return [{ id: 'fake-sim:pdtest-ios', backend: 'fake-sim', nativeId: 'pdtest-ios', name: 'pdtest-ios', platform: 'ios', kind: 'virtual', state: 'running', managed: true, capabilities: ['boot'] }]; },
  async screenshot() { return Buffer.alloc(0); }, async tap() {}, async swipe() {}, async type() {}, async key() {},
} as unknown as Backend;
core.backends.push(fake, plain);

const ID = 'fake-emu:pdtest-a';
let clock = 1_000_000_000_000;
S.setIdleClockForTests(() => clock);
const advance = (sec: number) => { clock += sec * 1000; };
const ctx = (id: string, headers: Record<string, string> = {}) => {
  const set: Record<string, string> = {};
  return { c: { params: { id }, req: { headers }, res: { headersSent: false, destroyed: false, setHeader: (k: string, v: string) => { set[k] = v; } } } as unknown as Ctx, set };
};
const device = async (id = ID) => (await core.listDevices(true)).find((d) => d.id === id)!;
const tick = () => new Promise((r) => setImmediate(r));
/** Until `f` holds, or fail after 10 s (a regression fails here instead of hanging the run). */
const until = async (f: () => boolean, what: string) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > 10_000) throw new Error(`timed out waiting for ${what}`); await tick(); } };

beforeEach(async () => {
  states.clear(); managed.clear(); calls = []; videoListeners = []; wakeOpts = [];
  for (const k of Object.keys(hooks)) delete (hooks as Record<string, unknown>)[k];
  states.set('pdtest-a', 'running');
  process.env.PHONEDOCK_IDLE_SLEEP = '60s';
  core.clearLeases(); core.recordings.clear();
  for (const h of core.listHandoffs('pending')) core.resolveHandoff(h.id, 'cancelled', 'test');
  S.clearMarker(ID);
  core.invalidateDevices();
  await core.listDevices(true);
  S.resetIdleSleepForTests();
});

// ── the setting ─────────────────────────────────────────────────────────────
test('durations: off, plain seconds and units; anything else is refused', () => {
  assert.equal(S.parseIdleDuration('off'), null);
  assert.equal(S.parseIdleDuration('never'), null);
  assert.equal(S.parseIdleDuration('0'), null);
  assert.equal(S.parseIdleDuration('90'), 90);
  assert.equal(S.parseIdleDuration('1m'), 60);
  assert.equal(S.parseIdleDuration('15 minutes'), 900);
  assert.equal(S.parseIdleDuration('1h'), 3600);
  assert.equal(S.parseIdleDuration(null), null);
  assert.equal(S.parseIdleDuration(600), 600);
  assert.equal(S.parseIdleDuration('soon'), undefined);
});

test('the setting: 15 minutes by default, saved under the state dir, the environment overrides it for tests', () => {
  delete process.env.PHONEDOCK_IDLE_SLEEP;
  assert.deepEqual(S.idleSleepSetting(), { timeoutSec: 900, source: 'default' });
  assert.throws(() => S.setIdleSleep(120), (e: PhoneDockError) => e.code === 'bad_request');
  S.setIdleSleep(1800);
  assert.ok(existsSync(join(process.env.PHONEDOCK_HOME!, 'idle-sleep.json')));
  S.resetIdleSleepForTests();   // read back from disk, as a restarted daemon would
  assert.deepEqual(S.idleSleepSetting(), { timeoutSec: 1800, source: 'setting' });
  S.setIdleSleep(null);
  assert.equal(S.idleSleepSetting().timeoutSec, null);
  process.env.PHONEDOCK_IDLE_SLEEP = '1m';
  assert.deepEqual(S.idleSleepSetting(), { timeoutSec: 60, source: 'env', saved: null });
  S.setIdleSleep(900);
});

test('GET/POST /v1/idle-sleep', async () => {
  delete process.env.PHONEDOCK_IDLE_SLEEP;
  const call = (method: string, body: Record<string, unknown> = {}) => hit(method, '/v1/idle-sleep', ID, body) as Promise<{ timeoutSec: number | null; choices: unknown[]; devices: { id: string }[] }>;
  assert.equal((await call('POST', { after: '30m' })).timeoutSec, 1800);
  assert.equal((await call('POST', { timeoutSec: null })).timeoutSec, null);
  await assert.rejects(call('POST', { after: 'later' }), (e: PhoneDockError) => e.code === 'bad_request');
  await assert.rejects(call('POST', { timeoutSec: 5 }), (e: PhoneDockError) => e.code === 'bad_request');
  const st = await call('GET');
  assert.deepEqual(st.choices, [null, 600, 900, 1800, 3600]);
  assert.ok(st.devices.some((d) => d.id === ID));
  assert.ok(!st.devices.some((d) => d.id === 'fake-sim:pdtest-ios'), 'devices that can never sleep are not listed');
  await call('POST', { timeoutSec: 900 });
});

// ── the decision ────────────────────────────────────────────────────────────
test('idleDue: due at the timeout, never with a keep-awake signal or when set to never', () => {
  const base = { now: 1000_000, lastUseAt: 1000_000 - 900_000, awake: [] as string[] };
  assert.deepEqual(S.idleDue({ ...base, timeoutSec: 900 }), { due: true, idleSec: 900, sleepsInSec: 0 });
  assert.equal(S.idleDue({ ...base, timeoutSec: 901 }).due, false);
  assert.equal(S.idleDue({ ...base, timeoutSec: 901 }).sleepsInSec, 1);
  assert.equal(S.idleDue({ ...base, timeoutSec: null }).due, false);
  assert.equal(S.idleDue({ ...base, timeoutSec: 900, awake: ['lease'] }).due, false);
});

test('use vs observe: what the app and `phonedock devices` do by themselves never counts as use', () => {
  const k = (m: string, r: string, h?: Record<string, string>) => S.classifyRequest(m, r, h);
  // inventory, polling, live views, inspector refreshes
  assert.equal(k('GET', '/v1/devices'), 'none');
  assert.equal(k('GET', '/v1/events'), 'none');
  for (const r of ['/v1/devices/:id', '/v1/devices/:id/video', '/v1/devices/:id/frame', '/v1/devices/:id/stream', '/v1/devices/:id/actions',
    '/v1/devices/:id/recording', '/v1/devices/:id/snapshots', '/v1/devices/:id/info']) assert.equal(k('GET', r), 'observe', r);
  // reads agents use are use, unless the client marks them as observing (the app's background refreshes do)
  for (const r of ['/v1/devices/:id/crashes', '/v1/devices/:id/apps', '/v1/devices/:id/ui', '/v1/devices/:id/logs', '/v1/devices/:id/settings', '/v1/devices/:id/foreground']) {
    assert.equal(k('GET', r), 'use', r);
    assert.equal(k('GET', r, { 'x-phonedock-observe': '1' }), 'observe', r);
  }
  assert.equal(k('GET', '/v1/devices/:id/screenshot'), 'use');
  assert.equal(k('POST', '/v1/devices/:id/input'), 'use');
  assert.equal(k('POST', '/v1/devices/:id/shell'), 'use');
  assert.equal(k('POST', '/v1/devices/:id/lease'), 'use');
  for (const r of ['/v1/devices/:id/boot', '/v1/devices/:id/shutdown', '/v1/devices/:id/restart']) assert.equal(k('POST', r), 'control');
  assert.equal(k('DELETE', '/v1/devices/:id'), 'control');
  assert.equal(k('DELETE', '/v1/devices/:id/lease'), 'control');
  assert.equal(k('GET', '/v1/devices/:id/environment'), 'observe', 'a static read');
  assert.equal(k('POST', '/v1/devices/:id/flow'), 'use', 'saving a flow reads the live screen');
  assert.equal(k('POST', '/v1/devices/:id/shell', { 'x-phonedock-observe': '1' }), 'use', 'the header counts on GETs only');
});

// ── sleeping ────────────────────────────────────────────────────────────────
test('an idle phone sleeps once the timeout passes: saved, then stopped, and it says so', async () => {
  advance(59); await S.sweep();
  assert.equal(calls.join(), '', 'not before the timeout');
  advance(1); await S.sweep();
  assert.deepEqual(calls, ['prepare:pdtest-a', 'stop:pdtest-a']);
  const d = await device();
  assert.equal(d.state, 'stopped');
  assert.equal(d.sleep?.reason, 'idle');
  assert.ok(S.readMarker(ID), 'the marker is on disk');
  const log = core.readActions(ID, 5) as { action: { action: string; summary?: string } }[];
  assert.match(log.at(-1)!.action.summary ?? '', /went to sleep after 1 min without use/);
});

test('observe requests never reset the idle clock; a use does', async () => {
  advance(50);
  assert.equal(await S.enterRequest(ctx(ID).c, 'GET', '/v1/devices/:id/video'), undefined);
  assert.equal(await S.enterRequest(ctx(ID, { 'x-phonedock-observe': '1' }).c, 'GET', '/v1/devices/:id/crashes'), undefined);
  advance(10); await S.sweep();
  assert.ok(calls.includes('stop:pdtest-a'), 'polling did not keep it awake');
  states.set('pdtest-a', 'running'); S.clearMarker(ID); calls = []; core.invalidateDevices();
  S.resetIdleSleepForTests();
  advance(50);
  (await S.enterRequest(ctx(ID).c, 'GET', '/v1/devices/:id/screenshot'))!();
  advance(30); await S.sweep();
  assert.equal(calls.join(), '', 'a screenshot 30 s ago is use');
  advance(30); await S.sweep();
  assert.ok(calls.includes('stop:pdtest-a'));
});

test('every keep-awake signal keeps it awake past the timeout, and the clock starts when it ends', async () => {
  const cases: [string, () => () => void][] = [
    ['lease', () => { core.acquireLease(ID, 'cli:agent'); return () => core.releaseLease(ID, 'cli:agent'); }],
    ['handoff', () => { const h = core.createHandoff(ID, 'Sign in', 'cli:test'); return () => core.resolveHandoff(h.id, 'done', 'app:human'); }],
    ['recording', () => { core.recordings.set(ID, { deviceId: ID, path: '/tmp/x.mp4', startedAt: new Date().toISOString(), maxSeconds: 60, owner: 'cli:test' }); return () => core.recordings.delete(ID); }],
    ['request in flight', () => { let leave: (() => void) | undefined; void S.enterRequest(ctx(ID).c, 'POST', '/v1/devices/:id/shell').then((l) => { leave = l; }); return () => leave?.(); }],
    ['job', () => { const d = deferred(); core.startJob('replay', () => d.promise, ID); return () => d.resolve(); }],
    ['window', () => { hooks.window = true; return () => { hooks.window = false; }; }],
    ['visible live view', () => { const v = core.sharedVideo(ID, 720); v.viewers++; return () => { v.viewers--; v.lastAccess = 0; }; }],
    ['polled frames', () => { const s = core.sharedStream(ID, 720); s.viewers++; return () => { s.viewers--; s.lastAccess = 0; }; }],
  ];
  for (const [name, start] of cases) {
    calls = []; S.resetIdleSleepForTests();
    const end = start(); await tick();
    advance(120); await S.sweep();
    assert.equal(calls.join(), '', `${name} keeps it awake`);
    end(); await tick(); await tick();
    advance(59); await S.sweep();
    assert.equal(calls.join(), '', `${name}: the clock starts when it ends`);
    advance(2); await S.sweep();
    assert.ok(calls.includes('stop:pdtest-a'), `${name}: then it sleeps`);
    states.set('pdtest-a', 'running'); S.clearMarker(ID); core.stopStreamsFor(ID); core.invalidateDevices(); await core.listDevices(true);
  }
});

test('a live view (video or polled frames) of a phone whose screen is off does not keep it awake', async () => {
  const v = core.sharedVideo(ID, 720); v.viewers++;
  for (const cb of videoListeners) cb({ type: 'state', state: 'asleep' });
  const s = core.sharedStream(ID, 720); s.viewers++; framesAsleep = true;
  try { advance(61); await S.sweep(); assert.ok(calls.includes('stop:pdtest-a')); }
  finally { framesAsleep = false; v.viewers--; s.viewers--; core.stopStreamsFor(ID); }
});

test('scope: emulators PhoneDock didn’t create, and backends that can’t sleep, never sleep', async () => {
  managed.set('pdtest-a', false);   // an Android Studio AVD…
  core.upsertRecord({ id: ID, backend: 'fake-emu', nativeId: 'pdtest-a', name: 'renamed', createdAt: new Date().toISOString() });   // …even one with a record (renamed in PhoneDock)
  core.invalidateDevices();
  assert.equal((await device()).managed, true, 'a record makes it read managed');
  advance(3600); await S.sweep();
  assert.equal(calls.join(), '');
  assert.match(S.sleepIneligible(await device()) ?? '', /didn’t create it/);
  assert.match(S.sleepIneligible((await core.listDevices(true)).find((d) => d.id === 'fake-sim:pdtest-ios')!) ?? '', /can’t sleep/);
  core.removeRecord(ID);
});

test('a save that fails leaves the phone running, says why, and is not retried until the phone is used', async () => {
  hooks.saveError = new PhoneDockError('Couldn’t save the snapshot', 'snapshot_vulkan', 409, ['This emulator can’t save a snapshot after an app used Vulkan graphics (Chrome does).']);
  advance(61); await S.sweep();
  assert.deepEqual(calls, ['prepare:pdtest-a']);
  const d = await device();
  assert.equal(d.state, 'running');
  assert.equal(d.sleepFailure?.code, 'snapshot_vulkan');
  assert.match(d.sleepFailure?.message ?? '', /Vulkan/);
  assert.equal(S.readMarker(ID), undefined);
  advance(3600); await S.sweep(); await S.sweep();
  assert.deepEqual(calls, ['prepare:pdtest-a'], 'held until it is used');
  delete hooks.saveError;
  (await S.enterRequest(ctx(ID).c, 'POST', '/v1/devices/:id/input'))!();
  assert.equal((await device()).sleepFailure, null, 'a use clears it');
  advance(61); await S.sweep();
  assert.deepEqual(calls, ['prepare:pdtest-a', 'prepare:pdtest-a', 'stop:pdtest-a']);
});

// ── waking ──────────────────────────────────────────────────────────────────
async function putToSleep() { advance(61); await S.sweep(); assert.equal((await device()).state, 'stopped'); calls = []; }

test('a request that needs the phone wakes it first and says so; observe requests leave it asleep', async () => {
  await putToSleep();
  assert.equal(await S.enterRequest(ctx(ID).c, 'GET', '/v1/devices/:id/video'), undefined);
  assert.equal(await S.enterRequest(ctx(ID, { 'x-phonedock-observe': '1' }).c, 'GET', '/v1/devices/:id/ui'), undefined);
  assert.equal(await S.enterRequest(ctx(ID).c, 'GET', '/v1/devices/:id'), undefined);
  assert.equal(calls.join(), '', 'still asleep');
  const { c, set } = ctx(ID);
  const leave = await S.enterRequest(c, 'GET', '/v1/devices/:id/screenshot');
  leave!();
  assert.deepEqual(calls, ['wake:pdtest-a']);
  assert.match(set['X-PhoneDock-Woke'] ?? '', /^\d+; name=pdtest-a$/, 'resumed: no "fresh"');
  const d = await device();
  assert.equal(d.state, 'running');
  assert.equal(d.sleep, null);
  assert.equal(S.readMarker(ID), undefined);
});

test('several requests hitting a sleeping phone share one wake', async () => {
  await putToSleep();
  const gate = deferred(); hooks.wake = () => gate.promise;
  const reqs = [1, 2, 3].map(() => S.enterRequest(ctx(ID).c, 'POST', '/v1/devices/:id/input'));
  await tick();
  gate.resolve();
  for (const l of await Promise.all(reqs)) l!();
  assert.deepEqual(calls, ['wake:pdtest-a']);
});

test('a request (or a lease) that comes while the sleep is being decided calls it off; the request waits for that', async () => {
  for (const by of ['request', 'lease']) {
    calls = []; S.resetIdleSleepForTests(); core.clearLeases();
    const save = deferred(); hooks.save = () => save.promise;
    advance(61);
    const sweeping = S.sweep();
    await until(() => calls.includes('prepare:pdtest-a'), 'prepare:pdtest-a');
    let entered = false;
    const req = by === 'lease' ? (core.acquireLease(ID, 'cli:agent'), Promise.resolve(() => {}))
      : S.enterRequest(ctx(ID).c, 'POST', '/v1/devices/:id/input').then((l) => { entered = true; return l; });
    await tick();
    assert.equal(entered, false, 'it waits while the sleep is being decided');
    save.resolve();
    (await req)!(); await sweeping;
    assert.deepEqual(calls, ['prepare:pdtest-a'], by);
    assert.equal(S.readMarker(ID), undefined);
    assert.equal((await device()).state, 'running');
  }
});

test('a request that arrives while it stops waits for the stop, then wakes it', async () => {
  const stop = deferred(); hooks.stop = () => stop.promise;
  advance(61);
  const sweeping = S.sweep();
  await until(() => calls.includes('stop:pdtest-a'), 'stop:pdtest-a');
  const { c, set } = ctx(ID);
  const req = S.enterRequest(c, 'POST', '/v1/devices/:id/input');
  await tick();
  stop.resolve(); await sweeping;
  (await req)!();
  assert.deepEqual(calls, ['prepare:pdtest-a', 'stop:pdtest-a', 'wake:pdtest-a']);
  assert.ok(set['X-PhoneDock-Woke']);
});

test('a client that hangs up while the phone wakes gets nothing done on its behalf', async () => {
  await putToSleep();
  const gate = deferred(); hooks.wake = () => gate.promise;
  const { c } = ctx(ID);
  const req = S.enterRequest(c, 'POST', '/v1/devices/:id/input');
  (c.res as { destroyed: boolean }).destroyed = true;
  gate.resolve();
  await assert.rejects(req, (e: PhoneDockError) => e.code === 'aborted' && e.delivery === 'not_sent');
});

const hit = async (method: string, path: string, id: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
  const m = router.match(method, path.replace(':id', encodeURIComponent(id)));
  assert.ok(m && m !== 'method', `${method} ${path}`);
  const res = { headersSent: false, destroyed: false, setHeader() {} };
  return m.h({ params: m.params, owner: 'cli:test', req: { method, headers }, res, url: new URL(`http://127.0.0.1${path}`), body: async () => body, q: () => undefined } as unknown as Ctx);
};
const jobDone = async (raw: unknown) => {
  const { job } = JSON.parse(String((raw as { body: unknown }).body)) as { job: { id: string } };
  for (let i = 0; i < 200 && core.getJob(job.id).state === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
  return core.getJob(job.id);
};
/** A sleep marker as another daemon on this state dir writes it (just before it stops the phone). */
async function marker(sinceMs = Date.now()) {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const dir = join(process.env.PHONEDOCK_HOME!, 'devices', core.safeId(ID));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sleep.json'), JSON.stringify({ v: 1, since: new Date(sinceMs).toISOString(), reason: 'idle', name: 'pdtest-a', idleSec: 900, state: { at: new Date(sinceMs).toISOString(), bootId: 'boot-1' } }));
}
/** An input request with a request receipt, as the routes see it. */
const inputCtx = (requestId: string, body: unknown = { kind: 'tap', x: 1, y: 2 }) => ({
  params: { id: ID }, owner: 'cli:test', url: new URL('http://127.0.0.1/v1/devices/x/input'), body: async () => body,
  req: { method: 'POST', headers: { 'x-phonedock-request-id': requestId } }, res: { headersSent: false, destroyed: false, setHeader() {} },
}) as unknown as Ctx;
const enterInput = (c: Ctx, route = '/v1/devices/:id/input') => (S.enterRequest as (...a: unknown[]) => Promise<(() => void) | undefined>)(c, 'POST', route, true);

test('starting a sleeping phone wakes it where it left off', async () => {
  await putToSleep();
  const j = await jobDone(await hit('POST', '/v1/devices/:id/boot', ID));
  assert.equal(j.state, 'done');
  assert.deepEqual(calls, ['wake:pdtest-a']);
  assert.ok(j.progress.some((l) => /woke in .*where it left off/.test(l)));
});

test('a phone the person stopped stays stopped: shutting down a sleeping phone forgets its sleep', async () => {
  await putToSleep();
  await hit('POST', '/v1/devices/:id/shutdown', ID);
  assert.equal(S.readMarker(ID), undefined);
  assert.equal((await device()).sleep, null);
  assert.equal(await S.ensureAwake(ID, 'cli:test'), undefined, 'nothing wakes it');
  assert.ok(!calls.includes('wake:pdtest-a'));
});

test('a daemon restart keeps the sleep, and idle clocks start fresh', async () => {
  await putToSleep();
  S.resetIdleSleepForTests();   // what a new daemon process starts with
  assert.ok(S.readMarker(ID));
  assert.equal((await device()).sleep?.reason, 'idle');
  (await S.enterRequest(ctx(ID).c, 'POST', '/v1/devices/:id/input'))!();
  assert.deepEqual(calls, ['wake:pdtest-a']);
  calls = [];
  advance(100_000);   // long idle before the restart…
  S.resetIdleSleepForTests();
  advance(30); await S.sweep();
  assert.equal(calls.join(), '', '…doesn’t count: the clock starts at the restart');
});

test('a phone another daemon put to sleep is not reported as crashed', async () => {
  const { ServerResponse } = await import('node:http');
  const fakeClient = { write() { return true; } } as unknown as InstanceType<typeof ServerResponse>;
  core.sseClients.add(fakeClient);
  try {
    await core.pollDevices(true);   // seen running
    await marker();   // another daemon on this state dir stopped it: only its marker on disk tells this one why
    states.set('pdtest-a', 'stopped'); core.invalidateDevices();
    await new Promise((r) => setTimeout(r, 100));
    await core.pollDevices(true);
    const log = core.readActions(ID, 10) as { action: { action: string } }[];
    assert.ok(!log.some((e) => e.action.action === 'device.crashed'), JSON.stringify(log.map((e) => e.action.action)));
  } finally { core.sseClients.delete(fakeClient); }
});

test('the Snapshots list hides only the emulator’s own quick-boot state; a person’s "phonedock_sleep" is listed (#4)', async () => {
  const names = ((await hit('GET', '/v1/devices/:id/snapshots', ID)) as { name: string }[]).map((s) => s.name);
  assert.deepEqual(names, ['phonedock_sleep', 'mine']);
});

test('restart during an automatic wake really restarts the phone (#8)', async () => {
  await putToSleep();
  const w = deferred(); hooks.wake = () => w.promise;
  const waking = S.enterRequest(ctx(ID).c, 'POST', '/v1/devices/:id/input');
  await tick();
  const restart = hit('POST', '/v1/devices/:id/restart', ID);
  await tick();
  w.resolve(); (await waking)?.();
  const job = await jobDone(await restart);
  assert.equal(job.state, 'done', JSON.stringify(job.error));
  assert.deepEqual(calls, ['wake:pdtest-a', 'shutdown:pdtest-a', 'boot:pdtest-a']);
});

test('no wake starts while the phone is being deleted (#8)', async () => {
  await putToSleep();
  const d = deferred(); hooks.del = () => d.promise;
  const del = hit('DELETE', '/v1/devices/:id', ID);
  for (let i = 0; i < 5; i++) await tick();
  const req = S.enterRequest(ctx(ID).c, 'POST', '/v1/devices/:id/input').then((l) => l?.(), () => undefined);
  for (let i = 0; i < 5; i++) await tick();
  d.resolve(); await del; await req;
  assert.ok(!calls.includes('wake:pdtest-a'), calls.join());
});

test('another daemon’s change to the setting is seen at once, Never included (#10)', async () => {
  const { utimesSync, writeFileSync } = await import('node:fs');
  delete process.env.PHONEDOCK_IDLE_SLEEP;
  S.setIdleSleep(600);
  await S.sweep();
  const peer = (timeoutSec: number | null, bump: number) => {
    const f = join(process.env.PHONEDOCK_HOME!, 'idle-sleep.json');
    writeFileSync(f, JSON.stringify({ v: 1, timeoutSec, updatedAt: new Date().toISOString() }));
    const t = Date.now() / 1000 + bump; utimesSync(f, t, t);
  };
  peer(null, 5);
  advance(700); await S.sweep();
  assert.ok(!calls.includes('prepare:pdtest-a'), 'Never, chosen through the other daemon');
  peer(600, 10);
  advance(700); await S.sweep();
  assert.ok(calls.includes('prepare:pdtest-a'), 'and back to 10 minutes');
  assert.ok(S.sweepEveryMs(null) > 0, 'it keeps watching the setting while it is Never');
  S.setIdleSleep(900);
});

// ── second review (PR #13): each of these failed on 59685d4 ────────────────────────
test('a stop with no proof it happened is never "memory freed", even when the device list reads stopped', async () => {
  hooks.stopError = new PhoneDockError('The phone didn’t stop', 'sleep_failed', 500);   // and the (stale) list says stopped
  const count = (a: string) => (core.readActions(ID, 1000) as { action: { action: string } }[]).filter((e) => e.action.action === a).length;
  const [slept, failed] = [count('device.sleep'), count('device.sleep_failed')];
  advance(61); await S.sweep();
  assert.equal(count('device.sleep'), slept, 'no "went to sleep (memory freed)"');
  assert.equal(count('device.sleep_failed'), failed + 1);
});

test('"Never", chosen while the phone’s own idle clock is read, wins: nothing is stopped', async () => {
  delete process.env.PHONEDOCK_IDLE_SLEEP;
  S.setIdleSleep(600);
  hooks.guest = async () => { if (calls.includes('prepare:pdtest-a')) S.setIdleSleep(null); return undefined; };   // another daemon, or the person
  try {
    advance(601); await S.sweep();
    assert.ok(!calls.includes('stop:pdtest-a'), calls.join());
    assert.equal(S.readMarker(ID), undefined);
  } finally { S.setIdleSleep(900); }
});

test('a wake that started fresh: the header says so, a tap is handed back unsent, an app launch goes ahead', async () => {
  await putToSleep();
  hooks.wakeReport = { resumed: false, via: 'cold', note: 'Its saved state didn’t load.' };
  const { c, set } = ctx(ID);
  const leave = await enterInput(c);
  await assert.rejects(Promise.resolve(c.beforeRun?.()).then(() => { throw new Error('the tap went through'); }),
    (e: PhoneDockError) => e.code === 'woke_fresh' && e.delivery === 'not_sent');
  leave?.();
  assert.match(set['X-PhoneDock-Woke'] ?? '', /; fresh=1$/);
  await putToSleep();
  const l = ctx(ID);
  const leave2 = await enterInput(l.c, '/v1/devices/:id/apps/:appId/launch');
  await l.c.beforeRun?.();
  leave2?.();
  assert.deepEqual(calls, ['wake:pdtest-a'], 'the launch woke it and went ahead');
});

test('pool acquire gives back the lease it took when the phone fails to wake', async () => {
  await putToSleep();
  hooks.wake = async () => { throw new PhoneDockError('The device failed to start', 'boot_failed', 500); };
  await assert.rejects(Promise.resolve(hit('POST', '/v1/pool/acquire', ID, { deviceId: ID })));
  assert.equal(core.getLease(ID), null, 'nobody holds it');
});

test('each writer of the setting has its own temp file', async () => {
  const { mkdirSync, rmSync } = await import('node:fs');
  const shared = join(process.env.PHONEDOCK_HOME!, 'idle-sleep.json.tmp');
  mkdirSync(shared, { recursive: true });   // the one name every writer used to share is taken
  try { assert.doesNotThrow(() => S.setIdleSleep(1800)); }
  finally { rmSync(shared, { recursive: true, force: true }); S.setIdleSleep(900); }
});

test('every input route is marked as running its wake inside its receipt', async () => {
  const { inputRoute } = await import('./delivery.ts');
  assert.equal((inputRoute(async () => ({ ok: true })) as { receipt?: boolean }).receipt, true);
  for (const path of ['/v1/devices/x/input', '/v1/devices/x/swipe', '/v1/devices/x/fill', '/v1/devices/x/apps/y/launch']) {
    const m = router.match('POST', path);
    assert.ok(m && m !== 'method' && (m.h as { receipt?: boolean }).receipt === true, path);
  }
});

test('a sleep marker on a phone that runs and that no sleep here is stopping (someone else started it) is stale: never shown asleep; the sweep, a request, a shutdown or a restart settle it', async () => {
  await marker();   // started outside PhoneDock or by another service, or its stop never happened (this daemon restarted)
  core.invalidateDevices();
  assert.equal((await device()).sleep, null);
  await S.sweep();
  assert.equal(S.readMarker(ID), undefined, 'the sweep clears it');
  await marker();
  (await S.enterRequest(ctx(ID).c, 'POST', '/v1/devices/:id/shell'))?.();
  assert.deepEqual(calls, ['wake:pdtest-a'], 'a request goes through the wake, which finds it running and says how it came back');
  assert.equal(S.readMarker(ID), undefined);
  calls = [];
  await marker();
  await hit('POST', '/v1/devices/:id/shutdown', ID);
  assert.ok(calls.includes('shutdown:pdtest-a'), 'a shutdown really stops it');
  assert.equal(S.readMarker(ID), undefined);
  states.set('pdtest-a', 'running'); calls = []; await marker(); core.invalidateDevices();
  assert.equal((await jobDone(await hit('POST', '/v1/devices/:id/restart', ID))).state, 'done');
  assert.deepEqual(calls, ['shutdown:pdtest-a', 'boot:pdtest-a'], 'and a restart really restarts it');
});

test('receipts: a resent input is answered from its receipt with no wake; an expired one, or a reused ID on a route without receipts, wakes the phone first', async () => {
  const { withRequestReceipt } = await import('./requests.ts');
  const { readdirSync, readFileSync, writeFileSync } = await import('node:fs');
  for (const id of ['pdtest-tap-1', 'pdtest-old-1', 'pdtest-shot-1']) await withRequestReceipt(inputCtx(id), async () => ({ ok: true, delivery: 'sent' }));
  const dir = join(process.env.PHONEDOCK_HOME!, 'requests');
  for (const n of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const p = join(dir, n); const r = JSON.parse(readFileSync(p, 'utf8')) as { requestId: string };
    if (r.requestId === 'pdtest-old-1') writeFileSync(p, JSON.stringify({ ...r, startedAt: new Date(Date.now() - 25 * 3600_000).toISOString() }));
  }
  await putToSleep();
  hooks.wake = async () => { throw new PhoneDockError('The device failed to start', 'boot_failed', 500); };
  const resent = inputCtx('pdtest-tap-1');
  const leave = await enterInput(resent);
  const again = await withRequestReceipt(resent, async () => { throw new Error('must not run again'); }) as { delivery: string };
  leave?.();
  assert.equal(again.delivery, 'sent');
  assert.equal(calls.length, 0, 'no wake for a request that is only replayed');
  delete hooks.wake;
  const expired = inputCtx('pdtest-old-1'); let ran = false;
  const l2 = await enterInput(expired);
  await withRequestReceipt(expired, async () => { ran = true; return { ok: true, delivery: 'sent' }; });
  l2?.();
  assert.ok(ran && calls.includes('wake:pdtest-a'), 'an expired receipt: a new execution, after a wake');
  await putToSleep();
  const shot = ctx(ID, { 'x-phonedock-request-id': 'pdtest-shot-1' }); (shot.c as { owner: string }).owner = 'cli:test';
  (await S.enterRequest(shot.c, 'GET', '/v1/devices/:id/screenshot'))?.();
  assert.ok(calls.includes('wake:pdtest-a'), 'a route without receipts always wakes it');
});

test('a woken phone’s requests go once a fresh device list shows it running; if it never does, they fail unsent', async () => {
  await putToSleep();
  hooks.listDelayMs = 600;
  try {
    (await S.enterRequest(ctx(ID).c, 'POST', '/v1/devices/:id/input'))?.();
    const d = (await core.listDevices(false)).find((x) => x.id === ID)!;
    assert.equal(d.state, 'running');
    assert.ok(!(d.meta as { stale?: boolean } | undefined)?.stale, 'not a stale read');
  } finally { hooks.listDelayMs = 0; await new Promise((r) => setTimeout(r, 700)); }   // let the slow read finish
  await putToSleep();
  hooks.wakeLeavesStopped = true;
  const timing = (S as { wakeTiming?: { readyMs: number } }).wakeTiming;
  if (timing) timing.readyMs = 600;
  try {
    await assert.rejects(S.enterRequest(ctx(ID).c, 'GET', '/v1/devices/:id/screenshot'), (e: PhoneDockError) => e.code === 'not_ready' && e.delivery === 'not_sent');
  } finally { if (timing) timing.readyMs = 30_000; }
});

// ── round 4: one sleeper, the last look before the stop, readiness, identity ────────
test('one sleeper: the app’s service (47420), or one a test opts in with PHONEDOCK_IDLE_SLEEP; any other never sleeps or wakes a phone', async () => {
  assert.equal(S.isSleeper(47420, ''), true);
  assert.equal(S.isSleeper(47481, ''), false);
  assert.equal(S.isSleeper(47481, 'off'), false);
  assert.equal(S.isSleeper(47481, '1m'), true);
  await putToSleep();
  S.setIdleSleepRoleForTests({ sleeper: false });
  try {
    core.invalidateDevices();
    assert.equal((await device()).sleep, null, 'there a sleeping phone is a stopped one');
    assert.equal(await S.enterRequest(ctx(ID).c, 'POST', '/v1/devices/:id/input'), undefined);
    assert.equal(calls.length, 0, 'no wake');
    assert.equal((await jobDone(await hit('POST', '/v1/devices/:id/boot', ID))).state, 'done');
    assert.deepEqual(calls, ['boot:pdtest-a'], 'its boot is the ordinary one (the backend keeps that safe)');
    calls = []; advance(3600); await S.sweep();
    assert.equal(calls.length, 0, 'and it never puts a phone to sleep');
  } finally { S.setIdleSleepRoleForTests({ sleeper: true }); }
});

test('the default is one constant, 15 minutes, and Never works as a default too', async () => {
  delete process.env.PHONEDOCK_IDLE_SLEEP;
  rmSync(join(process.env.PHONEDOCK_HOME!, 'idle-sleep.json'), { force: true });
  assert.equal(S.DEFAULT_IDLE_SLEEP_SEC, 900);
  try {
    for (const def of [900, null]) {
      S.setIdleSleepRoleForTests({ defaultSec: def });
      assert.deepEqual(S.idleSleepSetting(), { timeoutSec: def, source: 'default' });
      states.set('pdtest-a', 'running'); S.clearMarker(ID); core.invalidateDevices(); calls = []; S.resetIdleSleepForTests();
      advance(901); await S.sweep();
      assert.equal(calls.includes('stop:pdtest-a'), def !== null, `default ${def}`);
    }
  } finally { S.setIdleSleepRoleForTests({ defaultSec: S.DEFAULT_IDLE_SLEEP_SEC }); S.setIdleSleep(900); }
});

test('the last look comes after the guest’s sync, just before the stop: a request, a lease or Never that came meanwhile calls it off', async () => {
  delete process.env.PHONEDOCK_IDLE_SLEEP;
  const cases: [string, () => void][] = [
    ['request', () => { void S.enterRequest(ctx(ID).c, 'POST', '/v1/devices/:id/input').then((l) => l?.()); }],
    ['lease', () => { core.acquireLease(ID, 'cli:agent'); }],
    ['Never', () => { S.setIdleSleep(null); }],
  ];
  try {
    for (const [name, act] of cases) {
      S.setIdleSleep(600); calls = []; S.resetIdleSleepForTests(); core.clearLeases();
      hooks.sync = async () => { act(); await tick(); };
      advance(601); await S.sweep();
      assert.ok(!calls.includes('stop:pdtest-a'), `${name}: ${calls.join()}`);
      assert.equal(S.readMarker(ID), undefined, name);
      assert.equal((await device()).state, 'running', name);
    }
  } finally { S.setIdleSleep(900); core.clearLeases(); }
});

test('pool acquire waits for a sleep under way (also when it picks the phone itself), then wakes it', async () => {
  const stop = deferred(); hooks.stop = () => stop.promise;
  advance(61); const sweeping = S.sweep();
  await until(() => calls.includes('stop:pdtest-a'), 'stop:pdtest-a');
  const acq = hit('POST', '/v1/pool/acquire', ID, { owner: 'cli:agent', platform: 'android' });
  await tick(); stop.resolve(); await sweeping;
  const r = await acq as { device: Device };
  assert.equal(r.device.id, ID);
  assert.equal(r.device.state, 'running');
  assert.deepEqual(calls, ['prepare:pdtest-a', 'stop:pdtest-a', 'wake:pdtest-a']);
  core.clearLeases();
});

test('a replay that wakes a phone which starts fresh is handed back before its job starts', async () => {
  await putToSleep();
  hooks.wakeReport = { resumed: false, via: 'cold', note: 'Its disk or saved state changed while it slept.' };
  await assert.rejects(S.enterRequest(ctx(ID).c, 'POST', '/v1/devices/:id/replay'), (e: PhoneDockError) => e.code === 'woke_fresh' && e.delivery === 'not_sent');
  assert.deepEqual(calls, ['wake:pdtest-a']);
});

test('a wake that isn’t ready in time leaves the phone asleep: the next request wakes it again', async () => {
  await putToSleep();
  S.wakeTiming.readyMs = 300; hooks.wakeLeavesStopped = true;
  try {
    await assert.rejects(S.enterRequest(ctx(ID).c, 'POST', '/v1/devices/:id/input'), (e: PhoneDockError) => e.code === 'not_ready' && e.delivery === 'not_sent');
    assert.ok(S.readMarker(ID), 'still asleep');
    hooks.wakeLeavesStopped = false;
    (await S.enterRequest(ctx(ID).c, 'POST', '/v1/devices/:id/input'))?.();
    assert.deepEqual(calls, ['wake:pdtest-a', 'wake:pdtest-a']);
    assert.equal(S.readMarker(ID), undefined);
  } finally { S.wakeTiming.readyMs = 30_000; }
});

test('a sleeping id whose own AVD is gone: lifecycle and snapshot calls are not_found and reach nothing', async () => {
  await putToSleep(); hooks.avdGone = true;
  for (const [m, p] of [['DELETE', '/v1/devices/:id/snapshots/baseline'], ['POST', '/v1/devices/:id/snapshots/baseline/restore'], ['GET', '/v1/devices/:id/snapshots'],
    ['POST', '/v1/devices/:id/shutdown'], ['POST', '/v1/devices/:id/restart'], ['POST', '/v1/devices/:id/boot'], ['DELETE', '/v1/devices/:id']]) {
    await assert.rejects(hit(m, p, ID), (e: PhoneDockError) => e.code === 'not_found', `${m} ${p}`);
  }
  assert.equal(calls.length, 0, calls.join());
});

test('starting a sleeping phone with a window wakes it with a window (the caller’s boot options)', async () => {
  await putToSleep();
  assert.equal((await jobDone(await hit('POST', '/v1/devices/:id/boot', ID, { headless: false }))).state, 'done');
  assert.equal(wakeOpts.at(-1)?.headless, false);
});

test('a wake that booted but wasn’t ready in time keeps how it came back: after a fresh start the next tap is still handed back', async () => {
  await putToSleep();
  S.wakeTiming.readyMs = 300; hooks.wakeLeavesStopped = true;
  hooks.wakeReport = { resumed: false, via: 'cold', note: 'Its disk or saved state changed while it slept.' };
  try {
    await assert.rejects(S.enterRequest(ctx(ID).c, 'POST', '/v1/devices/:id/shell'), (e: PhoneDockError) => e.code === 'not_ready');
    states.set('pdtest-a', 'running'); core.invalidateDevices();   // it had booted; the device list caught up late
    advance(5); await S.sweep();
    assert.ok(S.readMarker(ID), 'the sweep leaves that wake to finish');
    const { c, set } = ctx(ID);
    const leave = await enterInput(c);
    await assert.rejects(Promise.resolve(c.beforeRun?.()).then(() => { throw new Error('the tap went through'); }), (e: PhoneDockError) => e.code === 'woke_fresh');
    leave?.();
    assert.match(set['X-PhoneDock-Woke'] ?? '', /; fresh=1$/);
    assert.deepEqual(calls, ['wake:pdtest-a'], 'one wake');
    assert.equal(S.readMarker(ID), undefined);
  } finally { S.wakeTiming.readyMs = 30_000; }
});

test('a wake kept for a request that never comes is finished by the sweep two minutes on: logged, and the phone can sleep again', async () => {
  await putToSleep();
  S.wakeTiming.readyMs = 300; hooks.wakeLeavesStopped = true;
  hooks.wakeReport = { resumed: false, via: 'cold', note: 'Its disk or saved state changed while it slept.' };
  try {
    await assert.rejects(S.enterRequest(ctx(ID).c, 'POST', '/v1/devices/:id/shell'), (e: PhoneDockError) => e.code === 'not_ready');
    states.set('pdtest-a', 'running'); core.invalidateDevices();
    advance(60); await S.sweep();
    assert.ok(S.readMarker(ID), 'still kept for a retry');
    advance(61); await S.sweep();
    assert.equal(S.readMarker(ID), undefined, 'finished');
    const log = core.readActions(ID, 5) as { action: { action: string; summary?: string } }[];
    assert.match(log.find((e) => e.action.action === 'device.wake')?.action.summary ?? '', /started fresh: Its disk or saved state changed/);
    const { c } = ctx(ID);
    const leave = await enterInput(c);
    await c.beforeRun?.();                                    // a tap now goes through: the phone is just awake
    leave?.();
    assert.deepEqual(calls, ['wake:pdtest-a'], 'one wake');
  } finally { S.wakeTiming.readyMs = 30_000; }
});

test('a sleeping id whose AVD was deleted outside PhoneDock is forgotten by the sweep: the id is what it names now', async () => {
  await putToSleep(); hooks.avdGone = true;
  advance(5); await S.sweep();
  assert.equal(S.readMarker(ID), undefined);
  hooks.avdGone = false;
  assert.equal((await jobDone(await hit('POST', '/v1/devices/:id/boot', ID))).state, 'done');
  assert.deepEqual(calls, ['boot:pdtest-a'], 'an ordinary boot, no wake');
});

// ── round 5: the final review's fixes ──────────────────────────────────────
test('a live view that opens while the phone’s own idle clock is read keeps it awake: streams end only once the stop is decided', async () => {
  let s: ReturnType<typeof core.sharedStream> | undefined;
  hooks.guest = async () => { s = core.sharedStream(ID, 720); s.viewers++; return undefined; };
  try {
    advance(61); await S.sweep();
    assert.ok(!calls.includes('stop:pdtest-a'), 'not stopped while someone watches');
    assert.equal(S.readMarker(ID), undefined);
    assert.ok(core.watched(ID), 'the viewer still has its stream');
  } finally { if (s) s.viewers--; core.stopStreamsFor(ID); }
});

test('a shell command that wakes a phone which starts fresh is handed back unsent: it may be written for the screen it had', async () => {
  await putToSleep();
  hooks.wakeReport = { resumed: false, via: 'cold', note: 'Its saved state didn’t load.' };
  await assert.rejects(S.enterRequest(ctx(ID).c, 'POST', '/v1/devices/:id/shell'), (e: PhoneDockError) => e.code === 'woke_fresh' && e.delivery === 'not_sent' && /run the command again/.test(e.hints?.[0] ?? ''));
  assert.deepEqual(calls, ['wake:pdtest-a']);
});

test('a tap that met the sleep on arrival, but reaches its gate after another request woke the phone fresh, is still handed back', async () => {
  await putToSleep();
  hooks.wakeReport = { resumed: false, via: 'cold', note: 'Its disk or saved state changed while it slept.' };
  const tap = ctx(ID);
  const leave = await enterInput(tap.c);                  // arrived; its receipt is still reading the body
  (await S.enterRequest(ctx(ID).c, 'GET', '/v1/devices/:id/screenshot'))?.();   // meanwhile a screenshot wakes it
  assert.equal(S.readMarker(ID), undefined);
  await assert.rejects(Promise.resolve(tap.c.beforeRun?.()).then(() => { throw new Error('the tap went through'); }), (e: PhoneDockError) => e.code === 'woke_fresh');
  leave?.();
  assert.match(tap.set['X-PhoneDock-Woke'] ?? '', /; fresh=1$/);
  const later = ctx(ID);                                  // one that arrives after the wake goes ahead
  const l2 = await enterInput(later.c); await later.c.beforeRun?.(); l2?.();
  assert.deepEqual(calls, ['wake:pdtest-a'], 'one wake');
});

test('a wake is ready only on a current scan: a cached "running" row while every scan fails is no proof', async () => {
  await putToSleep();
  S.wakeTiming.readyMs = 400;
  hooks.wake = async () => { states.set('pdtest-a', 'running'); core.invalidateDevices(); await core.listDevices(true); hooks.listFails = true; };
  try {
    await assert.rejects(S.enterRequest(ctx(ID).c, 'GET', '/v1/devices/:id/screenshot'), (e: PhoneDockError) => e.code === 'not_ready');
    assert.ok(S.readMarker(ID), 'still asleep for the next request');
  } finally { S.wakeTiming.readyMs = 30_000; hooks.listFails = false; }
});

test('a boot or restart that fails leaves a sleeping phone asleep (also on a service that doesn’t sleep phones); it is forgotten once booted', async () => {
  await putToSleep();
  S.setIdleSleepRoleForTests({ sleeper: false });
  hooks.bootError = new PhoneDockError('No free console port', 'boot_failed', 500);
  try {
    assert.equal((await jobDone(await hit('POST', '/v1/devices/:id/boot', ID))).state, 'failed');
    assert.ok(S.readMarker(ID), 'a failed boot: still asleep');
    assert.equal((await jobDone(await hit('POST', '/v1/devices/:id/restart', ID))).state, 'failed');
    assert.ok(S.readMarker(ID), 'a failed restart: still asleep');
    delete hooks.bootError;
    assert.equal((await jobDone(await hit('POST', '/v1/devices/:id/boot', ID))).state, 'done');
    assert.equal(S.readMarker(ID), undefined, 'booted: not asleep any more');
  } finally { S.setIdleSleepRoleForTests({ sleeper: true }); }
});

test('opening the window of a sleeping phone wakes it with its own window, as a stopped one boots with it: no scrcpy needed', async () => {
  await putToSleep();
  assert.equal(S.classifyRequest('POST', '/v1/devices/:id/window'), 'control');
  const done = await S.enterRequest(ctx(ID).c, 'POST', '/v1/devices/:id/window');
  assert.deepEqual(await hit('POST', '/v1/devices/:id/window', ID), { ok: true });
  done?.();
  assert.equal(wakeOpts.at(-1)?.headless, false);
  assert.deepEqual(calls, ['wake:pdtest-a'], 'woken with its window; no separate one');
});

test('pool acquire of a sleeping id whose own AVD is gone is not_found and boots nothing, also on a service that doesn’t sleep phones', async () => {
  await putToSleep(); hooks.avdGone = true;
  S.setIdleSleepRoleForTests({ sleeper: false });
  try {
    await assert.rejects(hit('POST', '/v1/pool/acquire', ID, { deviceId: ID, owner: 'cli:pool' }), (e: PhoneDockError) => e.code === 'not_found');
    assert.deepEqual(calls, [], 'nothing booted');
    assert.equal(core.getLease(ID), null, 'no lease taken');
    await assert.rejects(hit('POST', '/v1/pool/acquire', ID, { backend: 'fake-emu', owner: 'cli:pool' }), (e: PhoneDockError) => e.code === 'no_device', 'the implicit pick skips it');
    assert.deepEqual(calls, []);
  } finally { S.setIdleSleepRoleForTests({ sleeper: true }); }
});
