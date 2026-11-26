import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router, type Ctx } from './http.ts';
import { registerDiagnosticRoutes } from './routes-diagnostics.ts';
import type { Backend, Device } from '../core/types.ts';

test('diagnostic routes keep host diagnosis device-free and reject unsupported targets before CDP', async () => {
  const router = new Router(); let reads = 0; let inspect = 0; let leaseChecks = 0;
  const b = { id: 'ios-device', platform: 'ios' } as Backend;
  registerDiagnosticRoutes(router, {
    doctor: async () => ({ ok: true }) as never,
    device: (c) => { reads++; return { id: c.params.id, b, nid: 'pdtest-fake' }; },
    knownDevice: async () => ({ meta: {} } as Device),
    checkLease: () => { leaseChecks++; },
    inspect: async () => { inspect++; return {} as never; },
  });
  const host = router.match('GET', '/v1/doctor'); assert.ok(host && host !== 'method');
  assert.deepEqual(await host.h({ q: () => undefined } as unknown as Ctx), { ok: true }); assert.equal(reads, 0);
  const post = router.match('POST', '/v1/devices/ios-device%3Apdtest-fake/webview'); assert.ok(post && post !== 'method');
  await assert.rejects(Promise.resolve(post.h({ params: post.params, owner: 'test', body: async () => ({ appId: 'com.example.test', action: 'snapshot' }) } as Ctx)), (e: any) => e.code === 'not_supported');
  assert.equal(inspect, 0); assert.equal(leaseChecks, 1);
});

test('Android emulator route resolves its existing transport and enforces ownership', async () => {
  const router = new Router(); const calls: unknown[] = [];
  const b = { id: 'android-emulator', platform: 'android', runningSerial: async (id: string) => { calls.push(['serial', id]); return 'emulator-pdtest'; } } as unknown as Backend;
  registerDiagnosticRoutes(router, {
    doctor: async () => ({ ok: true }) as never,
    device: (c) => ({ id: c.params.id, b, nid: 'pdtest-avd' }), knownDevice: async () => ({} as Device),
    checkLease: (_id, owner) => { if (owner !== 'test') throw Object.assign(new Error('leased'), { code: 'lease_conflict' }); },
    inspect: async (serial, options) => { calls.push(['inspect', serial, options.appId]); return { action: 'snapshot' } as never; },
  });
  const post = router.match('POST', '/v1/devices/android-emulator%3Apdtest-avd/webview'); assert.ok(post && post !== 'method');
  const ctx = { params: post.params, owner: 'test', body: async () => ({ appId: 'com.example.test' }) } as Ctx;
  await post.h(ctx); assert.deepEqual(calls, [['serial', 'pdtest-avd'], ['inspect', 'emulator-pdtest', 'com.example.test']]);
  calls.length = 0;
  await assert.rejects(Promise.resolve(post.h({ ...ctx, owner: 'other' })), (e: any) => e.code === 'lease_conflict');
  assert.equal(calls.length, 0);
});

test('invalid route input is rejected before transport discovery', async () => {
  const router = new Router(); let calls = 0;
  const b = { id: 'android-emulator', runningSerial: async () => { calls++; return 'never'; } } as unknown as Backend;
  registerDiagnosticRoutes(router, { doctor: async () => ({} as never), device: (c) => ({ id: c.params.id, b, nid: 'pdtest' }),
    knownDevice: async () => ({} as Device), checkLease: () => {}, inspect: async () => ({} as never) });
  const post = router.match('POST', '/v1/devices/android-emulator%3Apdtest/webview'); assert.ok(post && post !== 'method');
  for (const body of [null, [], { appId: 'bad;cmd' }, { appId: 'com.example.test', captureMs: 6000 }, { appId: 'com.example.test', action: 'measure' }]) {
    await assert.rejects(Promise.resolve(post.h({ params: post.params, owner: 'test', body: async () => body } as Ctx)), (e: any) => e.code === 'bad_request');
  }
  assert.equal(calls, 0);
});

test('iOS simulator WebView route accepts optional appId and measure selector', async () => {
  const router = new Router(); const calls: unknown[] = [];
  const b = { id: 'ios-simulator', platform: 'ios' } as Backend;
  registerDiagnosticRoutes(router, {
    doctor: async () => ({ ok: true }) as never,
    device: (c) => ({ id: c.params.id, b, nid: '11111111-2222-3333-4444-555555555555' }),
    knownDevice: async () => ({ state: 'running', meta: {} } as Device),
    checkLease: () => {},
    inspect: async () => { throw new Error('should not call android inspect'); },
    inspectIosSim: async (udid, options) => { calls.push([udid, options.action, options.selector]); return { action: 'measure' } as never; },
  });
  const post = router.match('POST', '/v1/devices/ios-simulator%3A11111111-2222-3333-4444-555555555555/webview');
  assert.ok(post && post !== 'method');
  await post.h({ params: post.params, owner: 'test', body: async () => ({ action: 'measure', selector: 'h1' }) } as Ctx);
  assert.deepEqual(calls, [['11111111-2222-3333-4444-555555555555', 'measure', 'h1']]);
});
