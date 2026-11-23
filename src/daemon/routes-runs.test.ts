// Daemon HTTP route tests for /v1/runs and /v1/devices/:id/apps/:appId.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhoneDockError, type RunRecord } from '../core/types.ts';
import type { Ctx } from './http.ts';

const tmpHome = mkdtempSync(join(tmpdir(), 'pd-routes-runs-'));
process.env.PHONEDOCK_HOME = tmpHome;

const core = await import('./core.ts');
const { router } = await import('./routes.ts');
await import('./routes-runs.ts');
const { Raw } = await import('./http.ts');

async function callRoute(method: string, path: string, opts: { body?: unknown; query?: Record<string, string>; owner?: string } = {}) {
  const m = router.match(method, path);
  assert.ok(m && m !== 'method', `route ${method} ${path} should match`);
  const c = {
    params: m.params,
    owner: opts.owner ?? 'test:owner',
    body: async () => opts.body ?? {},
    q: (k: string) => opts.query?.[k],
  } as unknown as Ctx;
  return await m.h(c);
}

function makeRecord(id: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schemaVersion: 1,
    id,
    status: 'pass',
    startedAt: '2026-11-23T12:00:00.000Z',
    endedAt: '2026-11-23T12:00:02.000Z',
    durationMs: 2000,
    attempts: 1,
    owner: 'cli:test',
    flow: {
      name: 'Login flow',
      file: '/Users/alice/app/flows/login.yaml',
      fileDisplay: 'flows/login.yaml',
      sha256: 'c'.repeat(64),
      platform: 'ios',
    },
    source: { commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', branch: 'main', dirty: false },
    device: { id: 'ios-simulator:pdtest-1', name: 'pdtest-1', platform: 'ios', backend: 'ios-simulator', kind: 'virtual', osVersion: '26.5', model: 'iPhone 17 Pro' },
    app: { id: 'com.example.app', name: 'Example', version: '2.1.0', build: '42' },
    steps: [{ index: 1, description: 'launch com.example.app', status: 'pass', ms: 500 }],
    artifacts: { dir: '/Users/alice/.phonedock/test-runs/run1', report: '/Users/alice/.phonedock/test-runs/run1/report.html' },
    ...overrides,
  };
}

test('routes-runs: POST/GET/export /v1/runs, bounds enforcement, 409 conflict, SSE event, and no /flow/run route', async () => {
  // Confirm dropped route POST /v1/devices/:id/flow/run does NOT exist (review-design #6)
  assert.equal(router.match('POST', '/v1/devices/ios-simulator:pdtest-1/flow/run'), undefined);

  const rec = makeRecord('2026-11-23T12-00-00-000Z-a1b2');
  const created = await callRoute('POST', '/v1/runs', { body: rec });
  assert.ok(created instanceof Raw);
  assert.equal(created.status, 201);
  const summary = JSON.parse(String(created.body));
  assert.equal(summary.id, rec.id);
  assert.equal(summary.appVersion, '2.1.0');
  assert.equal(summary.appBuild, '42');

  // Duplicate ID -> 409 conflict
  await assert.rejects(
    callRoute('POST', '/v1/runs', { body: rec }),
    (e: unknown) => e instanceof PhoneDockError && e.status === 409 && e.code === 'conflict',
  );

  // Wrong schemaVersion -> 400
  await assert.rejects(
    callRoute('POST', '/v1/runs', { body: { ...makeRecord('2026-11-23T12-00-01-000Z-cccc'), schemaVersion: 2 } }),
    (e: unknown) => e instanceof PhoneDockError && e.status === 400,
  );

  // > 2 MB body -> 413 too_large
  await assert.rejects(
    callRoute('POST', '/v1/runs', {
      body: makeRecord('2026-11-23T12-00-02-000Z-dddd', { message: 'x'.repeat(2 * 1024 * 1024 + 64) }),
    }),
    (e: unknown) => e instanceof PhoneDockError && e.status === 413 && e.code === 'too_large',
  );

  // > 2000 steps -> 400 bad_request
  await assert.rejects(
    callRoute('POST', '/v1/runs', {
      body: makeRecord('2026-11-23T12-00-03-000Z-eeee', {
        steps: Array.from({ length: 2001 }, (_, i) => ({ index: i + 1, description: 's', status: 'pass' as const, ms: 1 })),
      }),
    }),
    (e: unknown) => e instanceof PhoneDockError && e.status === 400,
  );

  // GET /v1/runs + GET /v1/runs/:runId + GET /v1/runs/:runId/export
  const list = await callRoute('GET', '/v1/runs', { query: { device: 'pdtest-1', status: 'pass', limit: '10' } }) as unknown[];
  assert.equal(list.length, 1);

  const got = await callRoute('GET', `/v1/runs/${rec.id}`) as RunRecord;
  assert.equal(got.id, rec.id);
  assert.equal(got.flow.file, '/Users/alice/app/flows/login.yaml');

  const mdRes = await callRoute('GET', `/v1/runs/${rec.id}/export`, { query: { format: 'md' } });
  assert.ok(mdRes instanceof Raw);
  assert.match(String(mdRes.headers['Content-Type']), /text\/markdown/);
  const md = String(mdRes.body);
  assert.match(md, /flows\/login\.yaml/);
  assert.match(md, /2\.1\.0 \(42\)/);
  assert.doesNotMatch(md, /\/Users\/alice/);

  const jsonRes = await callRoute('GET', `/v1/runs/${rec.id}/export`, { query: { format: 'json' } });
  assert.ok(jsonRes instanceof Raw);
  assert.equal(JSON.parse(String(jsonRes.body)).id, rec.id);

  // Missing run -> 404
  await assert.rejects(
    callRoute('GET', '/v1/runs/does-not-exist'),
    (e: unknown) => e instanceof PhoneDockError && e.status === 404,
  );

  // Dot-prefixed ids -> 400 on POST and GET
  await assert.rejects(
    callRoute('POST', '/v1/runs', { body: makeRecord('.hidden-run') }),
    (e: unknown) => e instanceof PhoneDockError && e.status === 400,
  );
  await assert.rejects(
    callRoute('GET', '/v1/runs/.hidden-run'),
    (e: unknown) => e instanceof PhoneDockError && e.status === 400,
  );
  await assert.rejects(
    callRoute('GET', '/v1/runs/.hidden-run/export', { query: { format: 'md' } }),
    (e: unknown) => e instanceof PhoneDockError && e.status === 400,
  );

  // Non-UTC offset timestamps -> 400 on POST
  await assert.rejects(
    callRoute('POST', '/v1/runs', {
      body: makeRecord('2026-11-23T12-00-04-000Z-ffff', {
        startedAt: '2026-11-23T17:30:00+05:30',
        endedAt: '2026-11-23T17:30:02+05:30',
      }),
    }),
    (e: unknown) => e instanceof PhoneDockError && e.status === 400,
  );
});

test('GET /v1/devices/:id/apps/:appId returns AppInfo with build or 404 when not installed', async () => {
  const id = 'fake-appinfo:pdtest-1';
  const backend = {
    id: 'fake-appinfo',
    platform: 'android',
    async appInfo(_nid: string, appId: string) {
      if (appId === 'com.example.app') return { id: appId, name: 'Example', version: '1.2.3', build: '123', system: false };
      return null;
    },
  };
  core.backends.push(backend as never);
  try {
    const info = await callRoute('GET', `/v1/devices/${id}/apps/com.example.app`) as { id: string; version: string; build: string };
    assert.deepEqual(info, { id: 'com.example.app', name: 'Example', version: '1.2.3', build: '123', system: false });

    await assert.rejects(
      callRoute('GET', `/v1/devices/${id}/apps/com.missing.app`),
      (e: unknown) => e instanceof PhoneDockError && e.status === 404 && e.code === 'not_found',
    );
  } finally {
    core.backends.splice(core.backends.indexOf(backend as never), 1);
    rmSync(tmpHome, { recursive: true, force: true });
  }
});
