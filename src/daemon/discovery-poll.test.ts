import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import type { Backend, Device } from '../core/types.ts';

test('publishing refreshed inventory does not force a second backend scan; explicit polls still discover changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdtest-perf-discovery-'));
  process.env.PHONEDOCK_HOME = dir; process.env.PHONEDOCK_PORT = '47433'; process.env.PHONEDOCK_DEVICE_FILTER = 'pdtest-';
  const { backends, pollDevices, sseClients, closeOwnership } = await import('./core.ts');
  let calls = 0;
  let device: Device = { id: 'pdtest-provider:one', nativeId: 'one', backend: 'pdtest-provider', name: 'pdtest-perf-one', platform: 'ios', kind: 'virtual', state: 'running', managed: false, capabilities: [] };
  const events: string[] = [];
  let onEvent: ((data: string) => void) | undefined;
  const viewer = { write(data: string) { events.push(data); onEvent?.(data); return true; } } as unknown as ServerResponse;
  const backend = { id: 'pdtest-provider', listDevices: async () => { calls++; return [{ ...device }]; } } as Backend;
  let lateCalls = 0;
  let finishLate!: (devices: Device[]) => void;
  const lateResult = new Promise<Device[]>((resolve) => { finishLate = resolve; });
  const lateBackend = { id: 'pdtest-late', listDevices: () => { lateCalls++; return lateResult; } } as Backend;
  backends.push(backend); sseClients.add(viewer);
  try {
    await pollDevices();
    await new Promise((r) => setTimeout(r, 150)); // allow the completion-triggered publication to run
    assert.equal(calls, 1, 'a completed scan must be published without immediately repeating it');
    assert.ok(events.some((e) => e.includes('pdtest-perf-one')));
    device = { ...device, name: 'pdtest-perf-renamed' };
    await pollDevices(); // the regular / explicit poll must still ask the backend, even inside the cache TTL
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(calls, 2);
    assert.ok(events.some((e) => e.includes('pdtest-perf-renamed')));
    backends.push(lateBackend);
    await pollDevices(); // initial bounded wait returns before this provider finishes
    assert.ok(!events.some((e) => e.includes('pdtest-perf-late')));
    const published = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('late inventory was not published')), 1000);
      onEvent = (data) => { if (data.includes('pdtest-perf-late')) { clearTimeout(timer); resolve(); } };
    });
    finishLate([{ ...device, id: 'pdtest-late:one', backend: 'pdtest-late', name: 'pdtest-perf-late' }]);
    await published;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(lateCalls, 1, 'a late completion is emitted without repeating its provider read');
  } finally {
    sseClients.delete(viewer);
    for (const b of [backend, lateBackend]) { const i = backends.indexOf(b); if (i >= 0) backends.splice(i, 1); }
    closeOwnership();
    rmSync(dir, { recursive: true, force: true });
  }
});
