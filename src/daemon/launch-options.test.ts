// Daemon launch route + Corellium/Android unsupported guards + MCP launch_app tests for Feature A.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhoneDockError, type Backend, type LaunchOptions } from '../core/types.ts';
import { backend as corelliumBackend } from '../backends/corellium.ts';
import type { Ctx } from './http.ts';

const HOME = mkdtempSync(join(tmpdir(), 'pd-launch-opts-'));
process.env.PHONEDOCK_HOME = HOME;
delete process.env.PHONEDOCK_DEVICE_FILTER;

const core = await import('./core.ts');
const { guardedBackendCall } = await import('./execution.ts');
const { router } = await import('./routes.ts');
const { noteScreen, readObservations } = await import('./observe.ts');
await import('./routes-flow.ts');

const calls: { nid: string; appId: string; opts?: LaunchOptions }[] = [];
let fgMode: 'match' | 'home-then-match' = 'match';
let fgCalls = 0;
let failWith: Error | undefined;

const fakeIos = {
  id: 'fake-launch-ios', displayName: 'Fake iOS', platform: 'ios', kind: 'virtual', capabilities: ['launch'],
  available: async () => ({ ok: true }), listDevices: async () => [],
  screenshot: async () => Buffer.alloc(0), tap: async () => {}, swipe: async () => {}, type: async () => {}, key: async () => {},
  launchApp(nid: string, appId: string, opts?: LaunchOptions) {
    return guardedBackendCall('fake-launch-ios', 'launchApp', [nid, appId, opts], async () => {
      calls.push({ nid, appId, opts });
      if (failWith) throw failWith;
    });
  },
  async foregroundApp() {
    fgCalls++;
    if (fgMode === 'home-then-match' && fgCalls <= 5) return null;
    return { id: calls.at(-1)?.appId ?? '' };
  },
} as unknown as Backend;
core.backends.push(fakeIos);

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const m = router.match(method, path);
  assert.ok(m && m !== 'method', `${method} ${path} has a route`);
  const c = { params: m.params, owner: 'mcp:test:1', body: async () => body ?? {}, q: () => undefined } as unknown as Ctx;
  return m.h(c);
}

async function fails(p: Promise<unknown>): Promise<PhoneDockError> {
  try { await p; } catch (e) { assert.ok(e instanceof PhoneDockError, String(e)); return e; }
  assert.fail('expected an error');
}

test('POST /apps/:appId/launch: validates args/env, forwards to backend, never logs secret values', async () => {
  calls.length = 0; failWith = undefined; fgMode = 'match';
  const dev = 'fake-launch-ios:pdtest-sim';
  const secretToken = 'pd-secret-launch-token-98765';
  const secretEnv = 'pd-secret-api-key-54321';

  const res = await call('POST', `/v1/devices/${encodeURIComponent(dev)}/apps/com.example.app/launch`, {
    args: { token: secretToken, flag: true, count: 7 },
    env: { API_KEY: secretEnv },
  });
  assert.equal(res.ok, true);
  assert.equal(res.delivery, 'sent');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].opts, { args: { token: secretToken, flag: true, count: 7 }, env: { API_KEY: secretEnv } });

  // Response must not echo values
  assert.ok(!JSON.stringify(res).includes(secretToken));
  assert.ok(!JSON.stringify(res).includes(secretEnv));

  // Action log must record only keys/metadata, never values
  const logFile = join(HOME, 'devices', core.safeId(dev), 'actions.jsonl');
  const rawLog = readFileSync(logFile, 'utf8');
  assert.ok(!rawLog.includes(secretToken), 'actions.jsonl leaked arg secret');
  assert.ok(!rawLog.includes(secretEnv), 'actions.jsonl leaked env secret');
  const entry = JSON.parse(rawLog.trim().split('\n').at(-1)!);
  assert.deepEqual(entry.action, { action: 'launch', appId: 'com.example.app', hasArgs: true, argKeys: ['token', 'flag', 'count'], envKeys: ['API_KEY'] });
});

test('POST /apps/:appId/launch: redacts secret values from backend error messages and details', async () => {
  calls.length = 0; fgMode = 'match';
  const dev = 'fake-launch-ios:pdtest-err';
  const secret = 'ultra-secret-password-xyz';
  failWith = new PhoneDockError(`Failed launching with ${secret}`, 'launch_failed', 500, [`Check ${secret}`], `cmd --env ${secret}`);
  try {
    const e = await fails(call('POST', `/v1/devices/${encodeURIComponent(dev)}/apps/com.example.app/launch`, {
      env: { PASSWORD: secret },
    }));
    assert.ok(!e.message.includes(secret), `message leaked: ${e.message}`);
    assert.ok(!(e.detail ?? '').includes(secret), `detail leaked: ${e.detail}`);
    assert.ok(!(e.hints ?? []).join('\n').includes(secret), `hints leaked: ${e.hints}`);
  } finally {
    failWith = undefined;
  }
});

test('POST /apps/:appId/launch: rejects invalid args/env with 400 bad_request and delivery=not_sent', async () => {
  calls.length = 0;
  const dev = 'fake-launch-ios:pdtest-bad';
  for (const body of [
    { args: { huge: 9007199254740992 } },
    { args: 'not-valid' },
    { env: { 'bad-key': '1' } },
    { env: { OK: 123 } },
    JSON.parse('{"args":{"__proto__":"value"}}'),
    JSON.parse('{"env":{"__proto__":"value"}}'),
  ]) {
    const e = await fails(call('POST', `/v1/devices/${encodeURIComponent(dev)}/apps/com.example.app/launch`, body));
    assert.equal(e.status, 400);
    assert.equal(e.code, 'bad_request');
    assert.equal(e.delivery, 'not_sent');
  }
  assert.equal(calls.length, 0);
});

test('POST /apps/:appId/launch: iOS confirmInFront retry forwards the same launchOpts', async () => {
  calls.length = 0; fgCalls = 0; fgMode = 'home-then-match';
  const dev = 'fake-launch-ios:pdtest-retry';
  const opts = { args: ['-UITesting'], env: { MODE: 'ci' } };
  const res = await call('POST', `/v1/devices/${encodeURIComponent(dev)}/apps/com.example.app/launch`, opts);
  assert.equal(res.ok, true);
  assert.equal(res.relaunched, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].opts, opts);
  assert.deepEqual(calls[1].opts, opts);
});

test('corellium backend: explicitly rejects launch args and env with 501 not_supported', async () => {
  for (const opts of [{ args: ['-flag'] }, { args: { a: '1' } }, { env: { FOO: 'bar' } }] as LaunchOptions[]) {
    const e = await fails(corelliumBackend.launchApp!('inst-1', 'com.example.app', opts));
    assert.equal(e.status, 501);
    assert.equal(e.code, 'not_supported');
    assert.equal(e.delivery, 'not_sent');
  }
});

test('per-device launch secrets: scrub later observations & flow save, clear on shutdown, and enforce bounded cap', async () => {
  calls.length = 0; failWith = undefined; fgMode = 'match';
  const dev = 'fake-launch-ios:pdtest-obs-secret';
  const secret = 'alpha-secret';

  // Ensure listDevices can return this fake device for POST /v1/devices/:id/flow
  const origList = fakeIos.listDevices;
  fakeIos.listDevices = async () => [{
    id: dev, backend: 'fake-launch-ios', nativeId: 'pdtest-obs-secret', name: 'pdtest-obs-secret',
    platform: 'ios', kind: 'virtual', state: 'running', managed: true, capabilities: ['launch'],
  }];
  try {
    const res = await call('POST', `/v1/devices/${encodeURIComponent(dev)}/apps/com.example.app/launch`, {
      args: { token: secret },
    });
    assert.equal(res.ok, true);
    assert.ok(core.deviceLaunchSecrets(dev).includes(secret));

    // Later, outside the launch request scope, the app displays the secret on screen
    noteScreen(dev, {
      source: 'accessibility',
      capturedAt: new Date().toISOString(),
      screen: { width: 390, height: 844 },
      root: [
        { ref: 'e1', type: 'StaticText', text: secret, bounds: { x: 10, y: 120, width: 200, height: 30 } },
        { ref: 'e2', type: 'StaticText', text: `Token: ${secret}`, bounds: { x: 10, y: 160, width: 200, height: 30 } },
        { ref: 'e3', type: 'StaticText', text: 'Welcome Home', bounds: { x: 10, y: 200, width: 200, height: 30 } },
      ],
    });

    const obs = readObservations(dev);
    assert.ok(obs.length > 0, 'expected screen observation');
    assert.ok(!JSON.stringify(obs).includes(secret), `observations.jsonl leaked secret: ${JSON.stringify(obs)}`);

    // flow save must never emit the secret or a redacted placeholder as assert_visible
    const saved = await call('POST', `/v1/devices/${encodeURIComponent(dev)}/flow`, { since: '5m' });
    assert.ok(!saved.text.includes(secret), `saved flow leaked secret:\n${saved.text}`);
    assert.ok(!saved.text.includes('•••'), `saved flow asserted redacted placeholder:\n${saved.text}`);
    assert.match(saved.text, /assert_visible:\s*Welcome Home/);

    // Device shutdown clears its in-memory launch secrets
    core.dropLeaseOnStop(dev);
    assert.deepEqual(core.deviceLaunchSecrets(dev), []);

    // Bounded cap: FIFO eviction keeps newest MAX_DEVICE_LAUNCH_SECRETS (1024) entries
    const cap = core.MAX_DEVICE_LAUNCH_SECRETS;
    assert.equal(cap, 1024);
    for (let i = 0; i < cap + 5; i++) core.rememberLaunchSecrets(dev, [`sec-${String(i).padStart(4, '0')}`]);
    const kept = core.deviceLaunchSecrets(dev);
    assert.equal(kept.length, cap);
    assert.ok(!kept.includes('sec-0000'));
    assert.ok(!kept.includes('sec-0004'));
    assert.ok(kept.includes('sec-0005'));
    assert.ok(kept.includes(`sec-${String(cap + 4).padStart(4, '0')}`));
    core.clearLaunchSecrets(dev);

    // Secrets are registered BEFORE backend launch so a post-delivery failure still protects later observations
    const failDev = 'fake-launch-ios:pdtest-fail-after-send';
    const failSecret = 'post-delivery-secret-7744';
    failWith = new PhoneDockError('Timed out after starting app', 'launch_failed', 500);
    try {
      await fails(call('POST', `/v1/devices/${encodeURIComponent(failDev)}/apps/com.example.app/launch`, {
        args: { token: failSecret },
      }));
      assert.ok(core.deviceLaunchSecrets(failDev).includes(failSecret));
      noteScreen(failDev, {
        source: 'accessibility',
        capturedAt: new Date().toISOString(),
        screen: { width: 390, height: 844 },
        root: [{ ref: 'e1', type: 'StaticText', text: `Shown: ${failSecret}`, bounds: { x: 10, y: 120, width: 200, height: 30 } }],
      });
      assert.ok(!JSON.stringify(readObservations(failDev)).includes(failSecret), 'failed launch secret leaked into observations');
    } finally {
      failWith = undefined;
      core.clearLaunchSecrets(failDev);
    }

    // Disappearing from inventory clears a device's launch secrets
    const goneDev = 'fake-launch-ios:pdtest-gone';
    let present = true;
    fakeIos.listDevices = async () => present ? [{
      id: goneDev, backend: 'fake-launch-ios', nativeId: 'pdtest-gone', name: 'pdtest-gone',
      platform: 'ios', kind: 'virtual', state: 'running', managed: true, capabilities: ['launch'],
    }] : [];
    await core.pollDevices(true);
    core.rememberLaunchSecrets(goneDev, ['disappeared-secret']);
    assert.deepEqual(core.deviceLaunchSecrets(goneDev), ['disappeared-secret']);
    present = false;
    await core.pollDevices(true);
    assert.deepEqual(core.deviceLaunchSecrets(goneDev), []);

    // Tracked device count is capped (LRU eviction)
    const devCap = core.MAX_LAUNCH_SECRET_DEVICES;
    for (let i = 0; i < devCap + 5; i++) core.rememberLaunchSecrets(`fake-launch-ios:cap-${i}`, [`dsec-${i}`]);
    assert.deepEqual(core.deviceLaunchSecrets('fake-launch-ios:cap-0'), []);
    assert.deepEqual(core.deviceLaunchSecrets('fake-launch-ios:cap-4'), []);
    assert.deepEqual(core.deviceLaunchSecrets('fake-launch-ios:cap-5'), ['dsec-5']);
    assert.deepEqual(core.deviceLaunchSecrets(`fake-launch-ios:cap-${devCap + 4}`), [`dsec-${devCap + 4}`]);
    for (let i = 0; i < devCap + 5; i++) core.clearLaunchSecrets(`fake-launch-ios:cap-${i}`);
  } finally {
    fakeIos.listDevices = origList;
  }
});
