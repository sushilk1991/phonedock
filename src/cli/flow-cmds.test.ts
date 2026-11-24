import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Device, PhoneDockClient } from '../sdk/client.ts';
import { testDevice } from './flow-cmds.ts';

test('phonedock test: with nothing running, the only sleeping phone is the one to test on (it wakes when used) (#11)', async () => {
  const sleeping = { id: 'android-emulator:pdtest-s', name: 'pdtest-s', platform: 'android', state: 'stopped', sleep: { since: '2026-11-24T10:00:00.000Z', reason: 'idle' } } as Device;
  const off = { ...sleeping, id: 'android-emulator:pdtest-off', name: 'pdtest-off', sleep: null } as Device;
  const c = { devices: async (q?: { state?: string }) => (q?.state === 'running' ? [] : [sleeping, off]) } as unknown as PhoneDockClient;
  assert.equal((await testDevice(c, undefined, undefined)).id, sleeping.id);
  const two = { devices: async (q?: { state?: string }) => (q?.state === 'running' ? [] : [sleeping, { ...sleeping, id: 'x:y', name: 'pdtest-t' }]) } as unknown as PhoneDockClient;
  await assert.rejects(testDevice(two, undefined, undefined), /pdtest-s.*pdtest-t|--device/);
});
