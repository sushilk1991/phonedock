import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhoneDockError, type Backend, type SettingsInput } from '../core/types.ts';
import type { Ctx } from './http.ts';

process.env.PHONEDOCK_HOME = mkdtempSync(join(tmpdir(), 'pd-settings-'));
delete process.env.PHONEDOCK_DEVICE_FILTER;   // core.ts reads it on import; agents here often run with it set
const core = await import('./core.ts');
const { router } = await import('./routes.ts');
await import('./routes-extra.ts');
let size = 1;
let sets = 0;
const fake = {
  id: 'fake-settings', displayName: 'Fake', platform: 'ios', kind: 'virtual', capabilities: ['settings'],
  getSettings: async () => ({ settings: { textSize: size }, supported: ['textSize'] }),
  setSettings: async (_id: string, patch: SettingsInput) => { sets++; size = Number(patch.textSize); },
  resetSettings: async () => { size = 1; },
} as unknown as Backend;
core.backends.push(fake);
const id = 'fake-settings:pdtest-route';
async function call(method: string, suffix = '', body: unknown = {}, owner = 'cli:test') {
  const route = router.match(method, `/v1/devices/${encodeURIComponent(id)}/settings${suffix}`);
  assert.ok(route && route !== 'method');
  return route.h({ params: route.params, owner, body: async () => body, q: () => undefined } as unknown as Ctx);
}
test('settings routes validate before mutation, report changes and enforce leases', async () => {
  const result = await call('POST', '', { textSize: 2 }) as { previous: { textSize: number }; changed: string[] };
  assert.equal(result.previous.textSize, 1); assert.deepEqual(result.changed, ['textSize']);
  await assert.rejects(call('POST', '', { textSize: 1, boldText: true }), (e: PhoneDockError) => e.code === 'not_supported');
  await assert.rejects(call('POST', '', { textSize: 0 }), (e: PhoneDockError) => e.code === 'bad_request');
  assert.equal(size, 2); assert.equal(sets, 1);
  core.acquireLease(id, 'cli:owner');
  try {
    await assert.rejects(call('POST', '/reset'), (e: PhoneDockError) => e.code === 'lease_conflict');
    await call('GET');
    await call('POST', '/reset', {}, 'cli:owner'); assert.equal(size, 1);
  } finally { core.clearLeases(); }
});
