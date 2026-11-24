// A PHONEDOCK_DEVICE_FILTER service shares the Mac with real phones it must never touch: it doesn't even list the
// physical backends (listing probes phones' lock state and WebDriverAgent, and starts downloads for them). Review #7.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Backend } from '../core/types.ts';

process.env.PHONEDOCK_HOME = mkdtempSync(join(tmpdir(), 'pd-filter-physical-'));
process.env.PHONEDOCK_DEVICE_FILTER = 'pdtest-';
const core = await import('./core.ts');

test('#7: a filtered service never calls listDevices on a physical backend', async () => {
  const calls: string[] = [];
  const mk = (id: string, kind: string, name: string) => ({
    id, displayName: id, platform: 'ios', kind, capabilities: [], available: async () => ({ ok: true }),
    listDevices: async () => { calls.push(id); return [{ id: `${id}:${name}`, backend: id, nativeId: name, name, platform: 'ios', kind, state: 'running', managed: false, capabilities: [] }]; },
  }) as unknown as Backend;
  core.backends.push(mk('ios-device', 'physical', 'Someone’s iPhone'), mk('android-device', 'physical', 'pdtest-phone'), mk('fake-sim', 'virtual', 'pdtest-sim'));
  const list = await core.listDevices(true);
  assert.deepEqual(calls, ['fake-sim']);
  assert.deepEqual(list.map((d) => d.name), ['pdtest-sim']);
});
