import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhoneDockError, type Backend, type Device, type DeviceState, type SleepState, type VideoPacket, type VideoStream } from '../core/types.ts';
import type { Ctx } from './http.ts';

process.env.PHONEDOCK_HOME = mkdtempSync(join(tmpdir(), 'pd-idle-'));
delete process.env.PHONEDOCK_DEVICE_FILTER;   // core.ts reads it on import (idle-sleep-filter.test.ts covers the filter)
delete process.env.PHONEDOCK_IDLE_SLEEP;
const core = await import('./core.ts');
const { router } = await import('./routes.ts');
await import('./routes-extra.ts');
await import('./routes-idle.ts');
const S = await import('./idle-sleep.ts');

// ── a fake sleep-capable backend ────────────────────────────────────────────
interface Deferred { promise: Promise<void>; resolve: () => void }
const deferred = (): Deferred => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
const states = new Map<string, DeviceState>();
const managed = new Map<string, boolean>();
let calls: string[] = [];
const hooks: { save?: () => Promise<void>; stop?: () => Promise<void>; wake?: () => Promise<void>; del?: () => Promise<void>; saveError?: PhoneDockError; window?: boolean; listDelayMs?: number } = {};
let videoListeners: ((p: VideoPacket) => void)[] = [];
let framesAsleep = false;
const fake = {
  id: 'fake-emu', displayName: 'Fake emulator', platform: 'android', kind: 'virtual', capabilities: ['boot', 'shutdown', 'video'],
  async available() { return { ok: true }; },
  async listDevices(): Promise<Device[]> {
    if (hooks.listDelayMs) await new Promise((r) => setTimeout(r, hooks.listDelayMs));   // adb takes a while
    return [...states].map(([nid, state]) => ({
      id: `fake-emu:${nid}`, backend: 'fake-emu', nativeId: nid, name: nid, platform: 'android', kind: 'virtual', state,
      managed: managed.get(nid) ?? true, connection: 'local', capabilities: ['boot', 'shutdown', 'video'],
    }));
  },
  async boot(nid: string) { calls.push(`boot:${nid}`); states.set(nid, 'running'); },
  async shutdown(nid: string) { calls.push(`shutdown:${nid}`); states.set(nid, 'stopped'); },
  async screenshot() { return Buffer.alloc(0); },
  async tap() {}, async swipe() {}, async type() {}, async key() {},
  async saveSleep(nid: string): Promise<SleepState> {
    calls.push(`save:${nid}`);
    await hooks.save?.();
    if (hooks.saveError) throw hooks.saveError;
    return { snapshot: 'phonedock_sleep', savedAt: new Date().toISOString(), bootId: 'boot-1', uptimeSec: 100 };
  },
  async stopAfterSleep(nid: string) { calls.push(`stop:${nid}`); await hooks.stop?.(); states.set(nid, 'stopped'); },
  async wakeFromSleep(nid: string) { calls.push(`wake:${nid}`); await hooks.wake?.(); states.set(nid, 'running'); return { resumed: true, via: 'quickboot' as const }; },
  async discardSleep(nid: string) { calls.push(`discard:${nid}`); },
  async delete(nid: string) { calls.push(`delete:${nid}`); await hooks.del?.(); states.delete(nid); },
  async listSnapshots() { return ['phonedock_sleep', 'default_boot', 'mine'].map((name) => ({ name, createdAt: new Date().toISOString() })); },
  async keepAwake() { return hooks.window ? 'its emulator window is open' : undefined; },
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

beforeEach(async () => {
  states.clear(); managed.clear(); calls = []; videoListeners = [];
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
  assert.equal(S.idleDurationWords(900), '15 minutes');
  assert.equal(S.idleDurationWords(3600), '1 hour');
  assert.equal(S.idleDurationWords(null), 'never');
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
  const call = async (method: string, body: unknown = {}) => {
    const m = router.match(method, '/v1/idle-sleep');
    assert.ok(m && m !== 'method');
    return m.h({ params: m.params, owner: 'cli:test', body: async () => body, q: () => undefined } as unknown as Ctx) as Promise<{ timeoutSec: number | null; choices: unknown[]; devices: { id: string }[] }>;
  };
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
});

// ── sleeping ────────────────────────────────────────────────────────────────
test('an idle phone sleeps once the timeout passes: saved, then stopped, and it says so', async () => {
  advance(59); await S.sweep();
  assert.equal(calls.join(), '', 'not before the timeout');
  advance(1); await S.sweep();
  assert.deepEqual(calls, ['save:pdtest-a', 'stop:pdtest-a']);
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
    ['visible live view', () => {
      const v = core.sharedVideo(ID, 720); v.viewers++;
      return () => { v.viewers--; v.lastAccess = 0; };
    }],
    ['polled frames', () => {
      const s = core.sharedStream(ID, 720); s.viewers++;
      return () => { s.viewers--; s.lastAccess = 0; };
    }],
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

test('a live view whose phone screen is off, or that nobody watches, does not keep it awake', async () => {
  const v = core.sharedVideo(ID, 720); v.viewers++;
  for (const cb of videoListeners) cb({ type: 'state', state: 'asleep' });
  advance(61); await S.sweep();
  assert.ok(calls.includes('stop:pdtest-a'));
  v.viewers--; core.stopStreamsFor(ID);
});

test('polled frames of a phone whose screen is off do not keep it awake', async () => {
  const s = core.sharedStream(ID, 720); s.viewers++;
  framesAsleep = true;
  try {
    advance(61); await S.sweep();
    assert.ok(calls.includes('stop:pdtest-a'));
  } finally { framesAsleep = false; s.viewers--; core.stopStreamsFor(ID); }
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
  assert.deepEqual(calls, ['save:pdtest-a']);
  const d = await device();
  assert.equal(d.state, 'running');
  assert.equal(d.sleepFailure?.code, 'snapshot_vulkan');
  assert.match(d.sleepFailure?.message ?? '', /Vulkan/);
  assert.equal(S.readMarker(ID), undefined);
  advance(3600); await S.sweep(); await S.sweep();
  assert.deepEqual(calls, ['save:pdtest-a'], 'held until it is used');
  delete hooks.saveError;
  (await S.enterRequest(ctx(ID).c, 'POST', '/v1/devices/:id/input'))!();
  assert.equal((await device()).sleepFailure, null, 'a use clears it');
  advance(61); await S.sweep();
  assert.deepEqual(calls, ['save:pdtest-a', 'save:pdtest-a', 'stop:pdtest-a']);
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
  assert.match(set['X-PhoneDock-Woke'] ?? '', /^\d+; name=pdtest-a$/);
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

test('a request that arrives during the save cancels the sleep and waits for the save to end', async () => {
  const save = deferred(); hooks.save = () => save.promise;
  advance(61);
  const sweeping = S.sweep();
  while (!calls.includes('save:pdtest-a')) await tick();
  let entered = false;
  const req = S.enterRequest(ctx(ID).c, 'POST', '/v1/devices/:id/input').then((l) => { entered = true; return l; });
  await tick();
  assert.equal(entered, false, 'it waits while the phone is paused for the save');
  save.resolve();
  (await req)!(); await sweeping;
  assert.deepEqual(calls, ['save:pdtest-a', 'discard:pdtest-a']);
  assert.equal((await device()).state, 'running');
});

test('a lease taken during the save cancels the sleep', async () => {
  const save = deferred(); hooks.save = () => save.promise;
  advance(61);
  const sweeping = S.sweep();
  while (!calls.includes('save:pdtest-a')) await tick();
  core.acquireLease(ID, 'cli:agent');
  save.resolve(); await sweeping;
  assert.deepEqual(calls, ['save:pdtest-a', 'discard:pdtest-a']);
});

test('a request that arrives while it stops waits for the stop, then wakes it', async () => {
  const stop = deferred(); hooks.stop = () => stop.promise;
  advance(61);
  const sweeping = S.sweep();
  while (!calls.includes('stop:pdtest-a')) await tick();
  const { c, set } = ctx(ID);
  const req = S.enterRequest(c, 'POST', '/v1/devices/:id/input');
  await tick();
  stop.resolve(); await sweeping;
  (await req)!();
  assert.deepEqual(calls, ['save:pdtest-a', 'stop:pdtest-a', 'wake:pdtest-a']);
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

async function route(method: string, suffix: string, body: unknown = {}) {
  const m = router.match(method, `/v1/devices/${encodeURIComponent(ID)}${suffix}`);
  assert.ok(m && m !== 'method');
  return m.h({ params: m.params, owner: 'cli:test', body: async () => body, q: () => undefined, req: { headers: {} }, res: {} } as unknown as Ctx);
}
async function finish(r: unknown) {
  const { job } = JSON.parse(String((r as { body: string }).body)) as { job: { id: string } };
  for (;;) { const j = core.getJob(job.id); if (j.state !== 'running') return j; await new Promise((x) => setTimeout(x, 5)); }
}

test('starting a sleeping phone wakes it where it left off', async () => {
  await putToSleep();
  const j = await finish(await route('POST', '/boot'));
  assert.equal(j.state, 'done');
  assert.deepEqual(calls, ['wake:pdtest-a']);
  assert.ok(j.progress.some((l) => /woke in .*where it left off/.test(l)));
});

test('a phone the person stopped stays stopped: shutting down a sleeping phone forgets its sleep', async () => {
  await putToSleep();
  await route('POST', '/shutdown');
  assert.equal(S.readMarker(ID), undefined);
  assert.deepEqual(calls, ['discard:pdtest-a'], 'its saved state is thrown away');
  assert.equal((await device()).sleep, null);
  assert.equal(await S.ensureAwake(ID, 'cli:test'), undefined, 'nothing wakes it');
  assert.deepEqual(calls, ['discard:pdtest-a']);
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
    // Another daemon on this state dir saved and stopped it: only its marker on disk tells this one why.
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const dir = join(process.env.PHONEDOCK_HOME!, 'devices', core.safeId(ID));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sleep.json'), JSON.stringify({ v: 1, since: new Date().toISOString(), reason: 'idle', name: 'pdtest-a', idleSec: 900, state: { snapshot: 's', savedAt: new Date().toISOString() } }));
    states.set('pdtest-a', 'stopped'); core.invalidateDevices();
    await new Promise((r) => setTimeout(r, 100));
    await core.pollDevices(true);
    const log = core.readActions(ID, 10) as { action: { action: string } }[];
    assert.ok(!log.some((e) => e.action.action === 'device.crashed'), JSON.stringify(log.map((e) => e.action.action)));
  } finally { core.sseClients.delete(fakeClient); }
});

test('a phone found running with a stale sleep marker (started outside PhoneDock) is not shown as sleeping', async () => {
  await putToSleep();
  await peerMarker('asleep', process.pid, Date.now() - 60_000);   // slept a minute ago: past the inventory's lag
  states.set('pdtest-a', 'running'); core.invalidateDevices();
  assert.equal((await device()).sleep, null);
  await S.sweep();
  assert.equal(S.readMarker(ID), undefined);
});

// ── review fixes (PR #13): each of these failed before its fix ─────────────────
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
async function peerMarker(phase: 'stopping' | 'asleep', pid: number, sinceMs = Date.now()) {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const dir = join(process.env.PHONEDOCK_HOME!, 'devices', core.safeId(ID));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sleep.json'), JSON.stringify({ v: 1, since: new Date(sinceMs).toISOString(), reason: 'idle', name: 'pdtest-a', idleSec: 900, phase, owner: { pid }, state: { snapshot: 'default_boot', savedAt: new Date(sinceMs).toISOString() } }));
}
async function deadPid(): Promise<number> {
  const { spawn } = await import('node:child_process');
  const c = spawn(process.execPath, ['-e', '0']);
  await new Promise((r) => c.on('exit', r));
  return c.pid!;
}

test('use vs observe: a static environment read is observe; saving a flow reads the live screen; the header counts on GETs only (#12)', () => {
  assert.equal(S.classifyRequest('GET', '/v1/devices/:id/environment'), 'observe');
  assert.equal(S.classifyRequest('POST', '/v1/devices/:id/flow'), 'use');
  assert.equal(S.classifyRequest('POST', '/v1/devices/:id/shell', { 'x-phonedock-observe': '1' }), 'use');
  assert.equal(S.classifyRequest('GET', '/v1/devices/:id/apps', { 'x-phonedock-observe': '1' }), 'observe');
});

test('the Snapshots list hides only the emulator’s own quick-boot state; a person’s "phonedock_sleep" is listed (#4)', async () => {
  const names = ((await hit('GET', '/v1/devices/:id/snapshots', ID)) as { name: string }[]).map((s) => s.name);
  assert.deepEqual(names, ['phonedock_sleep', 'mine']);
});

test('a resent request that already reached the phone is answered from its receipt, without waking it (#7)', async () => {
  const { withRequestReceipt } = await import('./requests.ts');
  const rc = () => ({
    params: { id: ID }, owner: 'cli:test', url: new URL('http://127.0.0.1/v1/devices/x/input'), body: async () => ({ kind: 'tap', x: 1, y: 2 }),
    req: { method: 'POST', headers: { 'x-phonedock-request-id': 'pdtest-tap-1' } }, res: { headersSent: false, destroyed: false, setHeader() {} },
  }) as unknown as Ctx;
  await withRequestReceipt(rc(), async () => ({ ok: true, delivery: 'delivered' }));
  await putToSleep();
  hooks.wake = async () => { throw new PhoneDockError('The device failed to start', 'boot_failed', 500); };
  const leave = await S.enterRequest(rc(), 'POST', '/v1/devices/:id/input');
  leave?.();
  assert.ok(!calls.includes('wake:pdtest-a'), 'no wake for a request that is only replayed');
  const again = await withRequestReceipt(rc(), async () => { throw new Error('must not run again'); }) as { delivery: string };
  assert.equal(again.delivery, 'delivered');
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

test('a request that woke the phone sees it running in the inventory right away (#9)', async () => {
  await putToSleep();
  hooks.listDelayMs = 600;
  try {
    (await S.enterRequest(ctx(ID).c, 'POST', '/v1/devices/:id/input'))?.();
    const d = (await core.listDevices(false)).find((x) => x.id === ID)!;
    assert.equal(d.state, 'running');
    assert.ok(!(d.meta as { stale?: boolean } | undefined)?.stale, 'not a stale read');
  } finally { hooks.listDelayMs = 0; await new Promise((r) => setTimeout(r, 700)); }   // let the slow read finish
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
  assert.ok(!calls.includes('save:pdtest-a'), 'Never, chosen through the other daemon');
  peer(600, 10);
  advance(700); await S.sweep();
  assert.ok(calls.includes('save:pdtest-a'), 'and back to 10 minutes');
  assert.ok(S.sweepEveryMs(null) > 0, 'it keeps watching the setting while it is Never');
  S.setIdleSleep(900);
});

test('a peer still stopping the phone: no marker is cleared under it, and a request waits for it (#3)', async () => {
  await peerMarker('stopping', 1, Date.now() - 60_000);   // pid 1 stands in for the other daemon: alive, not us
  states.set('pdtest-a', 'running'); core.invalidateDevices();
  await S.sweep();
  assert.ok(S.isSleeping(ID), 'the sweep left the peer’s marker alone');
  let done = false;
  const req = S.enterRequest(ctx(ID).c, 'POST', '/v1/devices/:id/input').then((l) => { done = true; l?.(); });
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(!done && !calls.includes('wake:pdtest-a'), 'it waits while the peer stops the phone');
  states.set('pdtest-a', 'stopped'); core.invalidateDevices();
  await peerMarker('asleep', 1);
  await req;
  assert.ok(calls.includes('wake:pdtest-a'), 'then wakes it');
});

test('a daemon that died while stopping the phone: the next one goes by the emulator itself (#3)', async () => {
  const pid = await deadPid();
  await peerMarker('stopping', pid, Date.now() - 60_000);
  states.set('pdtest-a', 'running'); core.invalidateDevices();
  await S.sweep();
  assert.ok(S.isSleeping(ID), 'still within the stop’s deadline: its exit may be on the way');
  await peerMarker('stopping', pid, Date.now() - 600_000);
  core.invalidateDevices(); await S.sweep();
  assert.ok(!S.isSleeping(ID), 'long past it and still running: it never stopped');
  await peerMarker('stopping', pid, Date.now() - 60_000);
  states.set('pdtest-a', 'stopped'); core.invalidateDevices();
  assert.deepEqual((await device()).sleep?.reason, 'idle', 'stopped: it is asleep');
});
