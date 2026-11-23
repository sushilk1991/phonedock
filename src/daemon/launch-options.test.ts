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
