import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhoneDockError, type RunRecord } from './types.ts';
import {
  formatRunMarkdown,
  listRunSummaries,
  MAX_RUN_STEPS,
  newRunId,
  publicFlowPath,
  readGitProvenance,
  readRunRecord,
  validateRunRecord,
  writeRunRecord,
} from './run-store.ts';

function sampleRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schemaVersion: 1,
    id: newRunId('2026-11-23T10:00:00.000Z'),
    status: 'pass',
    startedAt: '2026-11-23T10:00:00.000Z',
    endedAt: '2026-11-23T10:00:03.200Z',
    durationMs: 3200,
    attempts: 1,
    owner: 'cli:test',
    flow: {
      name: 'Smoke settings',
      file: '/Users/example/repo/flows/settings.yaml',
      fileDisplay: 'flows/settings.yaml',
      sha256: 'a'.repeat(64),
      platform: 'android',
    },
    source: {
      commit: '1234567890abcdef1234567890abcdef12345678',
      branch: 'main',
      dirty: false,
    },
    device: {
      id: 'android-emulator:pdtest-1',
      name: 'pdtest-1',
      platform: 'android',
      backend: 'android-emulator',
      kind: 'virtual',
      osVersion: '14',
      model: 'Pixel 9',
    },
    app: {
      id: 'com.android.settings',
      name: 'Settings',
      version: '14',
      build: '34',
    },
    steps: [
      { index: 1, description: 'launch com.android.settings', status: 'pass', ms: 1200 },
      { index: 2, description: 'assert visible "Network"', status: 'pass', ms: 400 },
    ],
    artifacts: {
      dir: '/Users/example/.phonedock/test-runs/2026-11-23/smoke-settings',
      report: '/Users/example/.phonedock/test-runs/2026-11-23/smoke-settings/report.html',
      files: ['/Users/example/.phonedock/test-runs/2026-11-23/smoke-settings/failure.png'],
    },
    ...overrides,
  };
}

test('validateRunRecord: enforces schemaVersion=1, id regex, <=2000 steps, field types, and blocks prototype keys', () => {
  const valid = validateRunRecord(sampleRun());
  assert.equal(valid.schemaVersion, 1);

  assert.throws(() => validateRunRecord({ ...sampleRun(), schemaVersion: 2 }), (e: unknown) => e instanceof PhoneDockError && e.status === 400);
  assert.throws(() => validateRunRecord({ ...sampleRun(), id: '../escape' }), (e: unknown) => e instanceof PhoneDockError && e.status === 400);
  assert.throws(() => validateRunRecord({ ...sampleRun(), id: '..' }), (e: unknown) => e instanceof PhoneDockError && e.status === 400);
  assert.throws(() => validateRunRecord({ ...sampleRun(), status: 'unknown' }), (e: unknown) => e instanceof PhoneDockError && e.status === 400);

  const tooManySteps = Array.from({ length: MAX_RUN_STEPS + 1 }, (_, i) => ({
    index: i + 1,
    description: `step ${i + 1}`,
    status: 'pass' as const,
    ms: 1,
  }));
  assert.throws(() => validateRunRecord({ ...sampleRun(), steps: tooManySteps }), (e: unknown) => e instanceof PhoneDockError && e.status === 400 && /2000/.test(e.detail ?? ''));

  const protoPayload = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(() => validateRunRecord({ ...sampleRun(), ...protoPayload }), (e: unknown) => e instanceof PhoneDockError && e.status === 400);
});

test('writeRunRecord: persists atomically, rejects duplicate id with 409 conflict, prunes oldest manifests without touching artifacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-runs-test-'));
  const extArtifacts = mkdtempSync(join(tmpdir(), 'pd-ext-art-'));
  const sentinel = join(extArtifacts, 'report.html');
  writeFileSync(sentinel, 'keep me');
  const prevMax = process.env.PHONEDOCK_MAX_RUNS;
  process.env.PHONEDOCK_MAX_RUNS = '3';
  try {
    const r1 = sampleRun({ id: '2026-11-23T10-00-01-000Z-aaaa', startedAt: '2026-11-23T10:00:01.000Z', artifacts: { dir: extArtifacts, report: sentinel } });
    writeRunRecord(r1, dir);

    // Duplicate ID must fail with 409 conflict and never overwrite
    assert.throws(
      () => writeRunRecord({ ...r1, status: 'fail' }, dir),
      (e: unknown) => e instanceof PhoneDockError && e.status === 409 && e.code === 'conflict',
    );
    assert.equal(readRunRecord(r1.id, dir)?.status, 'pass');

    // Write 3 more runs -> retention cap 3 prunes r1 manifest, leaving external artifacts untouched
    writeRunRecord(sampleRun({ id: '2026-11-23T10-00-02-000Z-bbbb', startedAt: '2026-11-23T10:00:02.000Z', status: 'fail' }), dir);
    writeRunRecord(sampleRun({ id: '2026-11-23T10-00-03-000Z-cccc', startedAt: '2026-11-23T10:00:03.000Z', device: { ...sampleRun().device, id: 'ios-simulator:pdtest-ios', name: 'pdtest-ios', platform: 'ios' } }), dir);
    writeRunRecord(sampleRun({ id: '2026-11-23T10-00-04-000Z-dddd', startedAt: '2026-11-23T10:00:04.000Z', app: { ...sampleRun().app, id: 'com.apple.Preferences' } }), dir);

    assert.equal(readRunRecord(r1.id, dir), null, 'oldest manifest should be pruned');
    assert.ok(existsSync(sentinel), 'external artifact directory must never be deleted during pruning');

    const all = listRunSummaries({}, dir);
    assert.equal(all.length, 3);
    assert.equal(all[0].id, '2026-11-23T10-00-04-000Z-dddd');
    assert.equal(listRunSummaries({ status: 'fail' }, dir).length, 1);
    assert.equal(listRunSummaries({ device: 'pdtest-ios' }, dir).length, 1);
    assert.equal(listRunSummaries({ appId: 'com.apple.Preferences' }, dir).length, 1);
  } finally {
    if (prevMax === undefined) delete process.env.PHONEDOCK_MAX_RUNS;
    else process.env.PHONEDOCK_MAX_RUNS = prevMax;
    rmSync(dir, { recursive: true, force: true });
    rmSync(extArtifacts, { recursive: true, force: true });
  }
});

test('publicFlowPath & formatRunMarkdown: repo-relative inside git, bare basename outside, zero absolute local paths', () => {
  assert.equal(publicFlowPath('/Users/alice/repo/flows/login.yaml', '/Users/alice/repo'), 'flows/login.yaml');
  assert.equal(publicFlowPath('/tmp/outside/login.yaml', '/Users/alice/repo'), 'login.yaml');
  assert.equal(publicFlowPath('/tmp/outside/login.yaml', undefined), 'login.yaml');
  assert.equal(publicFlowPath(undefined, '/Users/alice/repo'), 'unknown');

  const md = formatRunMarkdown(sampleRun({
    status: 'fail',
    message: 'The screen differs from /Users/alice/repo/baselines/home.png; saved /private/var/folders/x/diff.png',
    flow: {
      name: 'Smoke settings',
      file: '/Users/alice/repo/flows/settings.yaml',
      fileDisplay: '/Users/alice/repo/flows/settings.yaml', // even if caller passed absolute, export sanitizes to basename
      sha256: 'b'.repeat(64),
    },
    steps: [
      { index: 1, description: 'assert baseline', status: 'fail', ms: 500, message: 'Now: /Users/alice/.phonedock/out.png' },
    ],
  }));

  assert.doesNotMatch(md, /\/Users\//);
  assert.doesNotMatch(md, /\/private\/var\//);
  assert.match(md, /`settings\.yaml`/);
  assert.match(md, /`report\.html`/);
  assert.match(md, /`failure\.png`/);
  assert.match(md, /home\.png/);
  assert.match(md, /out\.png/);
});

test('readGitProvenance: returns unknown outside git and real commit inside git repo', async () => {
  const nonGit = mkdtempSync(join(tmpdir(), 'pd-nongit-'));
  try {
    const out = await readGitProvenance(nonGit);
    assert.equal(out.commit, 'unknown');
    assert.equal(out.branch, 'unknown');
    assert.equal(out.dirty, 'unknown');
    assert.equal(out.gitRoot, undefined);
  } finally {
    rmSync(nonGit, { recursive: true, force: true });
  }

  const here = await readGitProvenance(process.cwd());
  assert.match(here.commit, /^[0-9a-f]{40}$/);
  assert.notEqual(here.branch, 'unknown');
  assert.equal(typeof here.dirty, 'boolean');
  assert.ok(here.gitRoot);
});
