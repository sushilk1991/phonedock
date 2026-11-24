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

const states = new Map<string, DeviceState>([['pdtest-a', 'running'], ['someones-phone', 'running']]);
const calls: string[] = [];
core.backends.push({
  id: 'fake-emu', displayName: 'Fake emulator', platform: 'android', kind: 'virtual', capabilities: ['boot'],
  async available() { return { ok: true }; },
  async listDevices(): Promise<Device[]> {
    return [...states].map(([nid, state]) => ({ id: `fake-emu:${nid}`, backend: 'fake-emu', nativeId: nid, name: nid, platform: 'android', kind: 'virtual', state, managed: true, connection: 'local', capabilities: ['boot'] }));
  },
  async screenshot() { return Buffer.alloc(0); }, async tap() {}, async swipe() {}, async type() {}, async key() {},
  async saveSleep(nid: string) { calls.push(`save:${nid}`); return { snapshot: 's', savedAt: new Date().toISOString() }; },
  async stopAfterSleep(nid: string) { calls.push(`stop:${nid}`); states.set(nid, 'stopped'); },
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
  assert.deepEqual(calls, ['save:pdtest-a', 'stop:pdtest-a']);
  // Someone else's phone that some other daemon put to sleep: requests here don't wake it.
  states.set('someones-phone', 'stopped');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const dir = join(process.env.PHONEDOCK_HOME!, 'devices', core.safeId('fake-emu:someones-phone'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sleep.json'), JSON.stringify({ v: 1, since: new Date().toISOString(), reason: 'idle', name: 'someones-phone', idleSec: 900, state: { snapshot: 's', savedAt: new Date().toISOString() } }));
  const c = { params: { id: 'fake-emu:someones-phone' }, req: { headers: {} }, res: { headersSent: false, setHeader() {} } } as unknown as Ctx;
  assert.equal(await S.enterRequest(c, 'POST', '/v1/devices/:id/input'), undefined);
  assert.deepEqual(calls, ['save:pdtest-a', 'stop:pdtest-a']);
});
