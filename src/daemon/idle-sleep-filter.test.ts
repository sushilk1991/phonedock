import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Backend, Device, DeviceState } from '../core/types.ts';
import type { Ctx } from './http.ts';

// A test or worker daemon (PHONEDOCK_DEVICE_FILTER) shares the Mac, and the state dir, with the app's own daemon. It
// can't see the use other phones get through that daemon, so it must never put them to sleep, nor wake them.
process.env.PHONEDOCK_HOME = mkdtempSync(join(tmpdir(), 'pd-idle-filter-'));
process.env.PHONEDOCK_DEVICE_FILTER = 'pdtest-';
process.env.PHONEDOCK_IDLE_SLEEP = '60s';
const core = await import('./core.ts');
const S = await import('./idle-sleep.ts');
const { router } = await import('./routes.ts');

const states = new Map<string, DeviceState>([['pdtest-a', 'running'], ['someones-phone', 'running']]);
const calls: string[] = [];
const names = new Map<string, string>();   // display names that differ from the AVD name
core.backends.push({
  id: 'fake-emu', displayName: 'Fake emulator', platform: 'android', kind: 'virtual', capabilities: ['boot'],
  async available() { return { ok: true }; },
  async listDevices(): Promise<Device[]> {
    return [...states].map(([nid, state]) => ({ id: `fake-emu:${nid}`, backend: 'fake-emu', nativeId: nid, name: names.get(nid) ?? nid, platform: 'android', kind: 'virtual', state, managed: true, connection: 'local', capabilities: ['boot'] }));
  },
  async screenshot() { return Buffer.alloc(0); }, async tap() {}, async swipe() {}, async type() {}, async key() {},
  async boot(nid: string) { calls.push(`boot:${nid}`); states.set(nid, 'running'); },
  async prepareSleep(nid: string) { calls.push(`prepare:${nid}`); return { at: new Date().toISOString() }; },
  async stopForSleep(nid: string, st: unknown) { calls.push(`stop:${nid}`); states.set(nid, 'stopped'); return st; },
  async wakeFromSleep(nid: string) { calls.push(`wake:${nid}`); states.set(nid, 'running'); return { resumed: true, via: 'quickboot' as const }; },
} as unknown as Backend);

let clock = 2_000_000_000_000;
S.setIdleClockForTests(() => clock);
S.resetIdleSleepForTests();

test('a filtered daemon only sleeps its own devices and never wakes the others', async () => {
  clock += 3_600_000;
  await S.sweep();
  core.invalidateDevices();
  await S.sweep();   // right after a sleep the inventory may still say running: not slept twice
  assert.deepEqual(calls, ['prepare:pdtest-a', 'stop:pdtest-a']);
  // Someone else's phone that some other daemon put to sleep: requests here don't wake it.
  states.set('someones-phone', 'stopped');
  await sleepMarker('someones-phone');
  const c = { params: { id: 'fake-emu:someones-phone' }, req: { headers: {} }, res: { headersSent: false, setHeader() {} } } as unknown as Ctx;
  assert.equal(await S.enterRequest(c, 'POST', '/v1/devices/:id/input'), undefined);
  assert.deepEqual(calls, ['prepare:pdtest-a', 'stop:pdtest-a']);
});

async function sleepMarker(nid: string) {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const dir = join(process.env.PHONEDOCK_HOME!, 'devices', core.safeId(`fake-emu:${nid}`));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sleep.json'), JSON.stringify({ v: 1, since: new Date().toISOString(), reason: 'idle', name: nid, idleSec: 900, state: { at: new Date().toISOString() } }));
}

test('starting a sleeping phone that has just left the filter is not_found: never a normal boot', async () => {
  states.set('pdtest-e', 'stopped');
  core.invalidateDevices(); await core.listDevices(true);
  await sleepMarker('pdtest-e');
  names.set('pdtest-e', 'personal-e');   // renamed out of the filter; this daemon hasn't rescanned yet
  const m = router.match('POST', '/v1/devices/fake-emu%3Apdtest-e/boot');
  assert.ok(m && m !== 'method');
  const raw = await m.h({ params: m.params, owner: 'cli:test', body: async () => ({}), q: () => undefined, req: { headers: {} }, res: {} } as unknown as Ctx);
  const { job } = JSON.parse(String((raw as { body: string }).body)) as { job: { id: string } };
  for (let i = 0; i < 200 && core.getJob(job.id).state === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
  const j = core.getJob(job.id) as { state: string; error?: { code?: string } };
  assert.ok(!calls.includes('boot:pdtest-e') && !calls.includes('wake:pdtest-e'), calls.join());
  assert.equal(j.state, 'failed');
  assert.equal(j.error?.code, 'not_found');
});

test('membership follows each complete scan: renamed out (here, or by another daemon in state.json) or gone, a device is not this daemon’s, and a request here doesn’t wake it', async () => {
  const { writeFileSync } = await import('node:fs');
  const nids = ['pdtest-b', 'pdtest-c', 'pdtest-d'];
  for (const n of nids) states.set(n, 'stopped');
  core.invalidateDevices(); await core.listDevices(true);
  for (const n of nids) assert.ok(core.isDeviceAllowed(`fake-emu:${n}`), n);
  await sleepMarker('pdtest-b');
  names.set('pdtest-b', 'personal phone');
  states.delete('pdtest-c');
  writeFileSync(join(process.env.PHONEDOCK_HOME!, 'state.json'), JSON.stringify({ devices: [{ id: 'fake-emu:pdtest-d', backend: 'fake-emu', nativeId: 'pdtest-d', name: 'personal d', createdAt: new Date().toISOString() }] }));
  core.invalidateDevices(); await core.listDevices(true);
  for (const n of nids) assert.equal(core.isDeviceAllowed(`fake-emu:${n}`), false, n);
  const c = { params: { id: 'fake-emu:pdtest-b' }, req: { headers: {} }, res: { headersSent: false, setHeader() {} } } as unknown as Ctx;
  await S.enterRequest(c, 'POST', '/v1/devices/:id/input').then((l) => l?.(), () => undefined);
  assert.ok(!calls.includes('wake:pdtest-b'), calls.join());
});
