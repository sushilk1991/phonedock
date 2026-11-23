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
  pruneRuns,
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
  assert.throws(() => validateRunRecord({ ...sampleRun(), id: '.hidden' }), (e: unknown) => e instanceof PhoneDockError && e.status === 400);
  assert.throws(() => readRunRecord('.hidden'), (e: unknown) => e instanceof PhoneDockError && e.status === 400);
  assert.throws(() => validateRunRecord({ ...sampleRun(), startedAt: '2026-11-23T15:30:00+05:30' }), (e: unknown) => e instanceof PhoneDockError && e.status === 400);
  assert.throws(() => validateRunRecord({ ...sampleRun(), endedAt: '2026-11-23T15:30:05+05:30' }), (e: unknown) => e instanceof PhoneDockError && e.status === 400);
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

test('formatRunMarkdown: replaces non-standard absolute roots and ~/ paths with basenames while preserving URLs and relative paths', () => {
  const md = formatRunMarkdown(sampleRun({
    status: 'fail',
    message: 'Diff at /srv/private/project/baseline.png and ~/secrets/dir/shot.png; see https://example.com/docs/flows and flows/settings.yaml',
    flow: {
      name: 'Non-standard root check',
      file: '/srv/private/project/flows/login.yaml',
      fileDisplay: '~/private/flows/login.yaml',
      sha256: 'd'.repeat(64),
    },
    steps: [
      { index: 1, description: 'compare /data/ci/run-42/expected.png', status: 'fail', ms: 120, message: 'Now: /mnt/secret/out.png (file:///srv/private/raw.png)' },
    ],
  }));

  assert.doesNotMatch(md, /\/srv\//);
  assert.doesNotMatch(md, /\/data\//);
  assert.doesNotMatch(md, /\/mnt\//);
  assert.doesNotMatch(md, /~\//);
  assert.match(md, /baseline\.png/);
  assert.match(md, /shot\.png/);
  assert.match(md, /expected\.png/);
  assert.match(md, /out\.png/);
  assert.match(md, /raw\.png/);
  assert.match(md, /`login\.yaml`/);
  assert.match(md, /https:\/\/example\.com\/docs\/flows/);
  assert.match(md, /flows\/settings\.yaml/);

  const mdExtra = formatRunMarkdown(sampleRun({
    status: 'fail',
    message: 'Check file://localhost/srv/private/baseline.png, file:///single.png, and \\\\fileserver\\share\\project\\diff.png',
    flow: {
      name: 'URI and UNC check',
      file: '\\\\fileserver\\share\\flows\\unc.yaml',
      fileDisplay: 'file://localhost/srv/flows/uri.yaml',
      sha256: 'e'.repeat(64),
    },
    steps: [
      { index: 1, description: 'compare \\\\corp-nas\\qa\\expected.png', status: 'fail', ms: 50, message: 'URI: file:///srv/private/actual.png' },
    ],
  }));
  assert.doesNotMatch(mdExtra, /file:\/\//i);
  assert.doesNotMatch(mdExtra, /localhost/);
  assert.doesNotMatch(mdExtra, /fileserver/);
  assert.doesNotMatch(mdExtra, /corp-nas/);
  assert.doesNotMatch(mdExtra, /\\\\/);
  assert.match(mdExtra, /baseline\.png/);
  assert.match(mdExtra, /single\.png/);
  assert.match(mdExtra, /diff\.png/);
  assert.match(mdExtra, /expected\.png/);
  assert.match(mdExtra, /actual\.png/);
  assert.match(mdExtra, /`uri\.yaml`/);
});

test('listRunSummaries & pruneRuns: sort by Date.parse(startedAt) with id tiebreak and skip corrupt manifests', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-runs-sort-'));
  try {
    // Chronological order:
    //   1. offset-old: 15:00:00+05:30 == 09:30:00Z (oldest, though lexically "15:00" > "10:00"!)
    //   2. whole-sec:  10:00:00Z      == 10:00:00.000Z (lexically "Z" > "."!)
    //   3. frac-a/b:   10:00:00.500Z  (same timestamp -> id tiebreak puts frac-b before frac-a)
    const offsetOld = sampleRun({ id: 'run-offset-old', startedAt: '2026-11-23T15:00:00+05:30', endedAt: '2026-11-23T15:00:05+05:30' });
    const wholeSec = sampleRun({ id: 'run-whole-sec', startedAt: '2026-11-23T10:00:00Z', endedAt: '2026-11-23T10:00:05Z' });
    const fracA = sampleRun({ id: 'run-frac-a', startedAt: '2026-11-23T10:00:00.500Z', endedAt: '2026-11-23T10:00:05.500Z' });
    const fracB = sampleRun({ id: 'run-frac-b', startedAt: '2026-11-23T10:00:00.500Z', endedAt: '2026-11-23T10:00:05.500Z' });

    for (const r of [offsetOld, wholeSec, fracA, fracB]) {
      writeFileSync(join(dir, `${r.id}.json`), JSON.stringify(r));
    }
    // Corrupt manifest with device.name: null must be skipped without breaking filtering
    const corrupt = { ...sampleRun({ id: 'run-corrupt' }), device: { ...sampleRun().device, name: null } };
    writeFileSync(join(dir, 'run-corrupt.json'), JSON.stringify(corrupt));

    const listed = listRunSummaries({ device: 'pdtest-1' }, dir);
    assert.deepEqual(listed.map((r) => r.id), ['run-frac-b', 'run-frac-a', 'run-whole-sec', 'run-offset-old']);

    // Prune keeping 3 removes the corrupt/oldest entries (corrupt + run-offset-old)
    pruneRuns(dir, 3);
    assert.equal(existsSync(join(dir, 'run-offset-old.json')), false, 'oldest by epoch (+05:30) should be pruned');
    assert.equal(existsSync(join(dir, 'run-frac-b.json')), true);
    assert.equal(existsSync(join(dir, 'run-frac-a.json')), true);
    assert.equal(existsSync(join(dir, 'run-whole-sec.json')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
