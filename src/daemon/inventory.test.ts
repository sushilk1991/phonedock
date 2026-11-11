import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BackendInventory } from './inventory.ts';
import type { Device } from '../core/types.ts';

const device = (backend: string, name = 'pdtest-phone'): Device => ({ id: `${backend}:${name}`, backend, nativeId: name, name, platform: 'ios', kind: 'virtual', state: 'running', managed: true, capabilities: [] });
const tick = () => new Promise<void>((r) => setImmediate(r));
function gate<T>() { let resolve!: (v: T) => void; let reject!: (e: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

test('a stuck cloud backend does not hold healthy inventory; a late result becomes visible', async () => {
  const slow = gate<Device[]>(); const updates: string[] = [];
  const inventory = new BackendInventory({ initialWaitMs: 15, timeoutMs: 1000, onUpdate: (id) => updates.push(id) });
  const backends = [{ id: 'local', listDevices: async () => [device('local')] }, { id: 'cloud', listDevices: () => slow.promise }];
  const began = performance.now();
  const first = await inventory.list(backends);
  assert.ok(performance.now() - began < 300);
  assert.deepEqual(first.map((d) => d.backend), ['local']);
  assert.equal(inventory.status().cloud.refreshing, true);
  slow.resolve([device('cloud')]); await tick();
  assert.deepEqual((await inventory.list(backends)).map((d) => d.backend), ['local', 'cloud']);
  assert.ok(updates.includes('cloud'));
  inventory.close();
});

test('targeted discovery never starts unrelated backends and concurrent callers join one refresh', async () => {
  const ready = gate<Device[]>(); let local = 0, cloud = 0;
  const inventory = new BackendInventory({ initialWaitMs: 10 });
  const backends = [{ id: 'local', listDevices: () => { local++; return ready.promise; } }, { id: 'cloud', listDevices: async () => { cloud++; return []; } }];
  const a = inventory.list(backends, { backend: 'local' }); const b = inventory.list(backends, { backend: 'local', fresh: true });
  await tick(); assert.equal(local, 1); assert.equal(cloud, 0);
  ready.resolve([device('local')]); await Promise.all([a, b]);
  assert.equal(local, 1); inventory.close();
});

test('stale inventory is returned while refreshing; failure preserves last good devices and later recovery clears flags', async () => {
  let now = 1000; let call = 0; const refresh = gate<Device[]>();
  const inventory = new BackendInventory({ now: () => now, initialWaitMs: 10, maxAgeMs: 20, retryDelayMs: 1 });
  const backend = { id: 'local', listDevices: () => { call++; return call === 1 ? Promise.resolve([device('local')]) : refresh.promise; } };
  await inventory.list([backend]); now += 21;
  const stale = await inventory.list([backend]);
  assert.equal(stale[0].meta?.stale, true); assert.equal(stale[0].meta?.refreshing, true);
  refresh.reject(new Error('provider disconnected')); await tick();
  const failed = await inventory.list([backend]);
  assert.equal(failed[0].meta?.stale, true); assert.equal(failed[0].meta?.listError, 'provider disconnected');
  assert.equal(call, 2);
  now += 2;
  const replacement = { id: 'local', listDevices: async () => [device('local', 'pdtest-reconnected')] };
  const recovered = await inventory.list([replacement], { fresh: true });
  assert.equal(recovered[0].name, 'pdtest-reconnected');
  assert.equal(recovered[0].meta?.listError, undefined); assert.equal(recovered[0].meta?.stale, undefined);
  inventory.close();
});

test('enumeration timeout reports status but never starts a second unresolved backend call', async () => {
  let calls = 0; const stuck = gate<Device[]>();
  const inventory = new BackendInventory({ initialWaitMs: 5, timeoutMs: 10 });
  const backend = { id: 'stuck', listDevices: () => { calls++; return stuck.promise; } };
  await inventory.list([backend]); await new Promise((r) => setTimeout(r, 20));
  assert.match(inventory.status().stuck.error ?? '', /timed out/i);
  assert.equal(inventory.status().stuck.refreshing, true);
  await Promise.all([inventory.list([backend], { fresh: true }), inventory.list([backend], { fresh: true })]);
  assert.equal(calls, 1);
  stuck.resolve([device('stuck')]); await tick();
  assert.equal((await inventory.list([backend]))[0].meta?.stale, undefined);
  assert.equal(inventory.status().stuck.error, undefined); inventory.close();
});

test('unchanged refreshes do not emit invalidation loops and returned objects cannot alter the cache', async () => {
  let updates = 0; const source = device('local');
  const inventory = new BackendInventory({ initialWaitMs: 10, onUpdate: () => { updates++; } });
  const backend = { id: 'local', listDevices: async () => [source] };
  const first = await inventory.list([backend]);
  first[0].name = 'changed by client'; first[0].capabilities.push('tap');
  await inventory.list([backend], { fresh: true });
  const last = await inventory.list([backend]);
  assert.equal(last[0].name, source.name); assert.deepEqual(last[0].capabilities, []); assert.equal(updates, 1);
  inventory.close();
});

test('provider replacement and invalidation fence old results without overlapping an unresolved read', async () => {
  const old = gate<Device[]>(); let reads = 0;
  const inventory = new BackendInventory({ initialWaitMs: 5 });
  const first = { id: 'local', listDevices: () => { reads++; return old.promise; } };
  const replacement = { id: 'local', listDevices: async () => { reads++; return [device('local', 'pdtest-new')]; } };
  await inventory.list([first]);
  await inventory.list([replacement], { fresh: true });
  assert.equal(reads, 1);
  old.resolve([device('local', 'pdtest-old')]); await tick();
  assert.equal(inventory.status().local.devices, 0);
  assert.equal((await inventory.list([replacement], { fresh: true }))[0].name, 'pdtest-new');
  assert.equal(reads, 2);
  inventory.invalidate('local');
  assert.equal((await inventory.list([replacement], { fresh: true }))[0].name, 'pdtest-new');
  inventory.close();
});

test('malformed provider responses fail explicitly and can recover; consumer callbacks cannot poison inventory', async () => {
  let valid = false;
  const inventory = new BackendInventory({ initialWaitMs: 5, onUpdate() { throw new Error('consumer failed'); } });
  const backend = { id: 'bad', listDevices: async () => valid ? [device('bad')] : undefined as unknown as Device[] };
  assert.deepEqual(await inventory.list([backend]), []);
  assert.match(inventory.status().bad.error ?? '', /non-array/);
  valid = true;
  assert.equal((await inventory.list([backend], { fresh: true }))[0].backend, 'bad');
  assert.equal(inventory.status().bad.error, undefined); inventory.close();
});
