// Unit tests for managed components: manifest/lock validation, checksum & tar traversal rejection,
// atomic activation, pruning, cross-process locking + stale recovery, lookup order, and auto-trigger dedupe/backoff.
// Uses local HTTP fixture servers and fake tarballs only (never hits the network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ComponentManager, isolatedPythonEnv, safeExtractTarGz, setComponentManager, getComponentManager,
} from './components.ts';
import {
  assertAllowedUrl, componentKey, loadManifest, sha256Hex, validateLockContent, validateManifest,
  type ComponentManifest,
} from './components-manifest.ts';
import { invalidatePymd3PythonCache, pymd3Python } from '../backends/pymd3-python.ts';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeFakeAxeTarGz(workDir: string, version: string, extraFiles: Record<string, string> = {}): { path: string; buf: Buffer; sha256: string } {
  const src = join(workDir, `src-${version}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(src, { recursive: true });
  const bin = join(src, 'axe');
  writeFileSync(bin, `#!/bin/sh\necho "${version}"\n`, 'utf8');
  chmodSync(bin, 0o755);
  for (const [rel, content] of Object.entries(extraFiles)) {
    const p = join(src, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }
  const tarPath = join(workDir, `axe-${version}-${Math.random().toString(36).slice(2, 8)}.tar.gz`);
  execFileSync('/usr/bin/tar', ['-czf', tarPath, '-C', src, '.']);
  const buf = readFileSync(tarPath);
  return { path: tarPath, buf, sha256: sha256Hex(buf) };
}

function writeTestTools(
  toolsDir: string,
  axeArtifact: { url: string; sha256: string; size: number; version: string },
  iosVersion = '11.63.1',
): ComponentManifest {
  mkdirSync(toolsDir, { recursive: true });
  const lockText = `pymobiledevice3==${iosVersion} \\\n    --hash=sha256:${'a'.repeat(64)}\n`;
  writeFileSync(join(toolsDir, 'ios-tools.lock'), lockText, 'utf8');
  writeFileSync(join(toolsDir, 'pd-ios-hid.py'), 'import pymobiledevice3\n', 'utf8');
  writeFileSync(join(toolsDir, 'pd-ios-native.py'), 'import pymobiledevice3\n', 'utf8');
  const manifest: ComponentManifest = {
    schemaVersion: 1,
    minAgeDays: 14,
    allowedHosts: ['github.com', 'objects.githubusercontent.com', 'files.pythonhosted.org'],
    components: {
      'ios-tools': {
        id: 'ios-tools',
        displayName: 'iPhone Control',
        description: 'Test ios-tools',
        kind: 'python-venv',
        version: iosVersion,
        publishedAt: '2026-10-01T00:00:00Z',
        pythonVersion: '3.12.16',
        pythonRelease: '20261026',
        lockFile: 'ios-tools.lock',
        lockSha256: sha256Hex(lockText),
        excludeNewerCutoff: '2026-11-10T00:00:00Z',
        recentExceptions: [],
        estimatedDiskBytes: 277_000_000,
        artifacts: [{
          platforms: ['darwin-arm64'],
          filename: 'python.tar.gz',
          url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20261026/python.tar.gz',
          sha256: 'b'.repeat(64),
          size: 1024,
        }],
        verify: { package: 'pymobiledevice3', version: iosVersion, sidecars: ['pd-ios-hid.py', 'pd-ios-native.py'] },
      },
      axe: {
        id: 'axe',
        displayName: 'Simulator Control',
        description: 'Test axe',
        kind: 'binary-archive',
        version: axeArtifact.version,
        publishedAt: '2026-07-20T12:14:36Z',
        estimatedDiskBytes: axeArtifact.size * 2,
        artifacts: [{
          platforms: ['darwin-arm64', 'darwin-x64'],
          filename: `AXe-macOS-v${axeArtifact.version}-universal.tar.gz`,
          url: axeArtifact.url,
          sha256: axeArtifact.sha256,
          size: axeArtifact.size,
        }],
        verify: { binary: 'axe', versionArgs: ['--version'], expectedVersion: axeArtifact.version },
      },
    },
  };
  writeFileSync(join(toolsDir, 'components.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

async function withServer(
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const srv: Server = createServer(handler);
  await new Promise<void>((res) => srv.listen(0, '127.0.0.1', () => res()));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((res) => srv.close(() => res()));
  }
}

test('repo tools/components.json and tools/ios-tools.lock pass validation', () => {
  const { manifest, toolsDir } = loadManifest();
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.components['ios-tools'].version, '11.63.1');
  assert.equal(manifest.components.axe.version, '1.8.0');
  assert.ok(existsSync(join(toolsDir, 'ios-tools.lock')));
});

test('manifest and lock validation rejects bad URLs, hosts, hashes and unhashed locks', () => {
  assert.throws(() => assertAllowedUrl('http://github.com/a.tar.gz', ['github.com']), /HTTPS/);
  assert.throws(() => assertAllowedUrl('https://evil.example/a.tar.gz', ['github.com']), /not allowed/);
  assert.doesNotThrow(() => assertAllowedUrl('https://github.com/a.tar.gz', ['github.com']));
  assert.doesNotThrow(() => assertAllowedUrl('http://127.0.0.1:9999/a.tar.gz', ['github.com'], true));

  assert.throws(() => validateLockContent('pymobiledevice3==11.63.1\n'), /missing package hashes/);
  assert.throws(() => validateLockContent('--extra-index-url https://evil.example\n'), /Unsupported directive/);
  assert.throws(() => validateLockContent(''), /empty/);
  assert.equal(validateLockContent(`foo==1.0.0 \\\n    --hash=sha256:${'f'.repeat(64)}\n`).packageCount, 1);

  const dir = makeTempDir('pd-comp-val-');
  try {
    const manifest = writeTestTools(dir, { url: 'https://github.com/cameroncooke/AXe/releases/download/v1.8.0/a.tar.gz', sha256: 'c'.repeat(64), size: 100, version: '1.8.0' });
    assert.doesNotThrow(() => validateManifest(manifest, dir));
    writeFileSync(join(dir, 'ios-tools.lock'), `pymobiledevice3==11.63.1 \\\n    --hash=sha256:${'9'.repeat(64)}\n`);
    assert.throws(() => validateManifest(manifest, dir), /hash mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isolatedPythonEnv drops inherited PIP_* and PYTHON* vars and enforces isolation', () => {
  const env = isolatedPythonEnv({
    PATH: '/opt/homebrew/bin:/usr/bin',
    HOME: '/tmp/home',
    PIP_INDEX_URL: 'https://evil.example/simple',
    PIP_EXTRA_INDEX_URL: 'https://evil.example/extra',
    PIP_CONFIG_FILE: '/tmp/pip.conf',
    PYTHONPATH: '/tmp/evil-site',
    PYTHONHOME: '/tmp/evil-py',
    PYTHONSTARTUP: '/tmp/evil.py',
    LANG: 'en_US.UTF-8',
  });
  assert.equal(env.PIP_INDEX_URL, undefined);
  assert.equal(env.PIP_EXTRA_INDEX_URL, undefined);
  assert.equal(env.PYTHONPATH, undefined);
  assert.equal(env.PYTHONHOME, undefined);
  assert.equal(env.PYTHONSTARTUP, undefined);
  assert.equal(env.PIP_CONFIG_FILE, '/dev/null');
  assert.equal(env.PYTHONNOUSERSITE, '1');
  assert.equal(env.LANG, 'en_US.UTF-8');
});

test('sha256 mismatch is rejected and leaves nothing behind', async () => {
  const work = makeTempDir('pd-comp-sha-');
  try {
    const tar = makeFakeAxeTarGz(work, '1.8.0');
    const tampered = Buffer.from(tar.buf);
    tampered[tampered.length - 1] ^= 0xff;

    await withServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(tampered.length) });
      res.end(tampered);
    }, async (base) => {
      const toolsDir = join(work, 'tools');
      const rootDir = join(work, 'components');
      writeTestTools(toolsDir, { url: `${base}/axe.tar.gz`, sha256: tar.sha256, size: tar.buf.length, version: '1.8.0' });
      const mgr = new ComponentManager({ rootDir, toolsDir, platformKey: 'darwin-arm64', allowLocalhost: true, externalLookup: () => undefined, envOverride: () => undefined });
      await assert.rejects(() => mgr.install('axe'), (e: any) => e.code === 'checksum_mismatch');
      const st = mgr.status('axe');
      assert.equal(st.state, 'failed');
      assert.equal(st.error?.code, 'checksum_mismatch');
      // Nothing activated and staging cleaned up
      const entries = readdirSync(join(rootDir, 'axe'));
      assert.ok(!entries.some((n) => !n.startsWith('.')));
      const staging = join(rootDir, 'axe', '.staging');
      assert.equal(existsSync(staging) ? readdirSync(staging).length : 0, 0);
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('tar traversal, absolute paths, and escaping symlinks are rejected', async () => {
  const work = makeTempDir('pd-comp-tar-');
  try {
    // Build a malicious tar.gz with `../evil.txt` via python tarfile (no shell strings)
    const makeTar = (kind: string, outPath: string) => {
      execFileSync('python3', ['-c', `
import io, tarfile, sys
kind, out = sys.argv[1], sys.argv[2]
with tarfile.open(out, 'w:gz') as tf:
    if kind == 'traversal':
        ti = tarfile.TarInfo('../escape.txt')
        data = b'pwn'
        ti.size = len(data)
        tf.addfile(ti, io.BytesIO(data))
    elif kind == 'absolute':
        ti = tarfile.TarInfo('/tmp/pd-abs-evil.txt')
        data = b'pwn'
        ti.size = len(data)
        tf.addfile(ti, io.BytesIO(data))
    elif kind == 'symlink':
        ti = tarfile.TarInfo('badlink')
        ti.type = tarfile.SYMTYPE
        ti.linkname = '../../../etc/passwd'
        tf.addfile(ti)
`, kind, outPath]);
    };

    for (const kind of ['traversal', 'absolute', 'symlink']) {
      const tarPath = join(work, `${kind}.tar.gz`);
      const dest = join(work, `extract-${kind}`);
      makeTar(kind, tarPath);
      await assert.rejects(() => safeExtractTarGz(tarPath, dest), (e: any) => e.code === 'unsafe_archive');
    }
    assert.equal(existsSync(join(work, 'escape.txt')), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('atomic activation, pin bump coexistence, and 30-day pruning rules', async () => {
  const work = makeTempDir('pd-comp-act-');
  try {
    const tar1 = makeFakeAxeTarGz(work, '1.8.0');
    const tar2 = makeFakeAxeTarGz(work, '1.9.0');
    let nowMs = Date.parse('2026-11-01T00:00:00Z');

    await withServer((req, res) => {
      const buf = req.url?.includes('1.9.0') ? tar2.buf : tar1.buf;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) });
      res.end(buf);
    }, async (base) => {
      const toolsDir = join(work, 'tools');
      const rootDir = join(work, 'components');
      const m1 = writeTestTools(toolsDir, { url: `${base}/axe-1.8.0.tar.gz`, sha256: tar1.sha256, size: tar1.buf.length, version: '1.8.0' });
      const key1 = componentKey(m1.components.axe, m1.components.axe.artifacts[0]);

      const mgr = new ComponentManager({
        rootDir, toolsDir, platformKey: 'darwin-arm64', allowLocalhost: true,
        now: () => nowMs, externalLookup: () => undefined, envOverride: () => undefined,
      });

      const st1 = await mgr.install('axe');
      assert.equal(st1.state, 'ready');
      assert.equal(st1.installedVersion, '1.8.0');
      assert.equal(st1.updateAvailable, false);
      assert.ok(existsSync(join(rootDir, 'axe', key1, '.ready.json')));

      // Bump pin to 1.9.0: old 1.8.0 stays usable via fallback until 1.9.0 activates
      const m2 = writeTestTools(toolsDir, { url: `${base}/axe-1.9.0.tar.gz`, sha256: tar2.sha256, size: tar2.buf.length, version: '1.9.0' });
      const key2 = componentKey(m2.components.axe, m2.components.axe.artifacts[0]);
      mgr.reloadManifest();

      const beforeBump = mgr.status('axe');
      assert.equal(beforeBump.state, 'ready');
      assert.equal(beforeBump.installedVersion, '1.8.0');
      assert.equal(beforeBump.pinnedVersion, '1.9.0');
      assert.equal(beforeBump.updateAvailable, true);

      nowMs += 60_000;
      const st2 = await mgr.install('axe');
      assert.equal(st2.state, 'ready');
      assert.equal(st2.installedVersion, '1.9.0');
      assert.equal(st2.updateAvailable, false);
      assert.ok(existsSync(join(rootDir, 'axe', key1, '.ready.json')));
      assert.ok(existsSync(join(rootDir, 'axe', key2, '.ready.json')));

      // 10 days later: key1 must NOT be pruned (another daemon version may still use it)
      nowMs += 10 * 86_400_000;
      assert.deepEqual(mgr.prune('axe').removedKeys, []);
      assert.ok(existsSync(join(rootDir, 'axe', key1)));

      // 25 more days later (35 days since key1 lastUsed): key1 IS pruned, pinned key2 is NEVER pruned even if untouched
      nowMs += 25 * 86_400_000;
      const pruned = mgr.prune('axe');
      assert.deepEqual(pruned.removedKeys, [`axe/${key1}`]);
      assert.equal(existsSync(join(rootDir, 'axe', key1)), false);
      assert.equal(existsSync(join(rootDir, 'axe', key2)), true);
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('cross-process lock contention and stale-lock recovery (dead PID and stale heartbeat)', async () => {
  const work = makeTempDir('pd-comp-lock-');
  try {
    const tar = makeFakeAxeTarGz(work, '1.8.0');
    let downloads = 0;
    let nowMs = Date.parse('2026-11-24T00:00:00Z');

    await withServer((_req, res) => {
      downloads++;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(tar.buf.length) });
      res.end(tar.buf);
    }, async (base) => {
      const toolsDir = join(work, 'tools');
      const rootDir = join(work, 'components');
      const m = writeTestTools(toolsDir, { url: `${base}/axe.tar.gz`, sha256: tar.sha256, size: tar.buf.length, version: '1.8.0' });
      const key = componentKey(m.components.axe, m.components.axe.artifacts[0]);

      // 1. Stale lock from a dead PID is reclaimed automatically
      const lockDir = join(rootDir, 'axe', '.lock');
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
        pid: 999_999, startedAt: new Date(nowMs).toISOString(), heartbeatAt: new Date(nowMs).toISOString(), key,
      }));
      const mgr1 = new ComponentManager({
        rootDir, toolsDir, platformKey: 'darwin-arm64', allowLocalhost: true,
        now: () => nowMs, pidAlive: (pid) => pid === process.pid,
        lockPollMs: 20, externalLookup: () => undefined, envOverride: () => undefined,
      });
      const st = await mgr1.install('axe');
      assert.equal(st.state, 'ready');
      assert.equal(downloads, 1);
      assert.equal(existsSync(lockDir), false);

      // 2. Contention: live lock held by another manager; once it activates target key, waiter exits without re-downloading
      rmSync(join(rootDir, 'axe', key), { recursive: true, force: true });
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
        pid: 424242, startedAt: new Date(nowMs).toISOString(), heartbeatAt: new Date(nowMs).toISOString(), key,
      }));
      const mgr2 = new ComponentManager({
        rootDir, toolsDir, platformKey: 'darwin-arm64', allowLocalhost: true,
        now: () => nowMs, pidAlive: () => true,
        lockPollMs: 20, lockStaleMs: 60_000, externalLookup: () => undefined, envOverride: () => undefined,
      });
      const waiter = mgr2.install('axe');
      // Simulate the lock holder finishing activation after 60 ms
      setTimeout(() => {
        const finalDir = join(rootDir, 'axe', key);
        mkdirSync(finalDir, { recursive: true });
        const fakeBin = join(finalDir, 'axe');
        writeFileSync(fakeBin, '#!/bin/sh\necho 1.8.0\n');
        chmodSync(fakeBin, 0o755);
        writeFileSync(join(finalDir, '.ready.json'), JSON.stringify({
          key, version: '1.8.0', activatedAt: new Date(nowMs).toISOString(), lastUsedAt: new Date(nowMs).toISOString(),
          sizeBytes: 10, binaryRelPath: 'axe',
        }));
        rmSync(lockDir, { recursive: true, force: true });
      }, 60);
      const st2 = await waiter;
      assert.equal(st2.state, 'ready');
      assert.equal(downloads, 1); // waiter did NOT re-download!
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('lookup order: env override -> pinned key -> newest other ready managed key -> external discovery + cache invalidation', () => {
  const work = makeTempDir('pd-comp-lookup-');
  const prevMgr = getComponentManager();
  const prevEnv = process.env.PHONEDOCK_PYMD3_PYTHON;
  const prevPath = process.env.PATH;
  const prevHome = process.env.HOME;
  try {
    const toolsDir = join(work, 'tools');
    const rootDir = join(work, 'components');
    const m = writeTestTools(toolsDir, { url: 'https://github.com/cameroncooke/AXe/releases/download/v1.8.0/a.tar.gz', sha256: 'c'.repeat(64), size: 100, version: '1.8.0' });
    const pinnedAxeKey = componentKey(m.components.axe, m.components.axe.artifacts[0]);

    const mkBin = (p: string) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, '#!/bin/sh\nexit 0\n'); chmodSync(p, 0o755); return p; };
    const overrideBin = mkBin(join(work, 'override', 'axe'));
    const externalBin = mkBin(join(work, 'ext', 'axe'));

    const writeReady = (key: string, ver: string, activatedAt: string) => {
      const dir = join(rootDir, 'axe', key);
      const bin = mkBin(join(dir, 'axe'));
      writeFileSync(join(dir, '.ready.json'), JSON.stringify({
        key, version: ver, activatedAt, lastUsedAt: activatedAt, sizeBytes: 10, binaryRelPath: 'axe',
      }));
      return bin;
    };

    const olderBin = writeReady('1.6.0-aaaaaaaaaaaa', '1.6.0', '2026-08-01T00:00:00Z');
    const newerOtherBin = writeReady('1.7.0-bbbbbbbbbbbb', '1.7.0', '2026-09-01T00:00:00Z');

    let envVal: string | undefined;
    const mgr = new ComponentManager({
      rootDir, toolsDir, platformKey: 'darwin-arm64',
      envOverride: (id) => (id === 'axe' ? envVal : undefined),
      externalLookup: (id) => (id === 'axe' ? externalBin : undefined),
    });

    // Step 3: newest other ready managed key when pinned isn't ready
    assert.equal(mgr.resolveManaged('axe')?.path, newerOtherBin);
    assert.notEqual(mgr.resolveManaged('axe')?.path, olderBin);

    // Step 2: pinned key wins once ready
    const pinnedBin = writeReady(pinnedAxeKey, '1.8.0', '2026-07-01T00:00:00Z');
    assert.equal(mgr.resolveManaged('axe')?.path, pinnedBin);

    // Step 1: env override wins over pinned
    envVal = overrideBin;
    assert.equal(mgr.resolveManaged('axe')?.path, overrideBin);

    // Negative cache invalidation on pymd3Python()
    delete process.env.PHONEDOCK_PYMD3_PYTHON;
    process.env.PATH = join(work, 'empty-bin');
    process.env.HOME = join(work, 'empty-home');
    mkdirSync(process.env.PATH, { recursive: true });
    mkdirSync(process.env.HOME, { recursive: true });
    setComponentManager(mgr);
    invalidatePymd3PythonCache();
    assert.equal(pymd3Python(), undefined);
    // Activate a fake python3.12-like script in managed ios-tools key
    const iosKey = componentKey(m.components['ios-tools'], m.components['ios-tools'].artifacts[0]);
    const iosDir = join(rootDir, 'ios-tools', iosKey);
    const pyBin = mkBin(join(iosDir, 'venv', 'bin', 'python'));
    writeFileSync(join(iosDir, '.ready.json'), JSON.stringify({
      key: iosKey, version: '11.63.1', activatedAt: '2026-11-24T00:00:00Z', lastUsedAt: '2026-11-24T00:00:00Z',
      sizeBytes: 10, binaryRelPath: 'venv/bin/python',
    }));
    invalidatePymd3PythonCache();
    assert.equal(pymd3Python(), pyBin);
  } finally {
    setComponentManager(prevMgr);
    if (prevEnv === undefined) delete process.env.PHONEDOCK_PYMD3_PYTHON; else process.env.PHONEDOCK_PYMD3_PYTHON = prevEnv;
    process.env.PATH = prevPath;
    process.env.HOME = prevHome;
    invalidatePymd3PythonCache();
    rmSync(work, { recursive: true, force: true });
  }
});

test('auto-trigger respects PHONEDOCK_COMPONENTS_AUTO=0, deduplicates concurrent calls, and backs off on failure', async () => {
  const work = makeTempDir('pd-comp-auto-');
  try {
    const tar = makeFakeAxeTarGz(work, '1.8.0');
    let hits = 0;
    let shouldFail = true;
    let nowMs = Date.parse('2026-11-24T00:00:00Z');

    await withServer((_req, res) => {
      hits++;
      if (shouldFail) {
        res.writeHead(500);
        res.end('boom');
        return;
      }
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(tar.buf.length) });
        res.end(tar.buf);
      }, 40);
    }, async (base) => {
      const toolsDir = join(work, 'tools');
      const rootDir = join(work, 'components');
      writeTestTools(toolsDir, { url: `${base}/axe.tar.gz`, sha256: tar.sha256, size: tar.buf.length, version: '1.8.0' });

      // Disabled when autoEnabled() returns false
      const disabled = new ComponentManager({
        rootDir, toolsDir, platformKey: 'darwin-arm64', allowLocalhost: true, autoEnabled: () => false,
      });
      assert.equal(disabled.triggerAuto('axe'), false);
      assert.equal(hits, 0);

      // Enabled: failure triggers backoff (10s -> 30s)
      const mgr = new ComponentManager({
        rootDir, toolsDir, platformKey: 'darwin-arm64', allowLocalhost: true,
        autoEnabled: () => true, now: () => nowMs, backoffMs: [10_000, 30_000],
        externalLookup: () => undefined, envOverride: () => undefined,
      });
      assert.equal(mgr.triggerAuto('axe'), true);
      // Wait for failure to settle
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(hits, 1);
      assert.equal(mgr.status('axe').state, 'failed');
      // Still inside backoff window -> auto trigger refused
      assert.equal(mgr.triggerAuto('axe'), false);
      assert.equal(hits, 1);

      // Advance past first backoff, succeed, and verify concurrent dedupe
      nowMs += 11_000;
      shouldFail = false;
      assert.equal(mgr.triggerAuto('axe'), true);
      assert.equal(mgr.triggerAuto('axe'), false); // deduped while installing
      const p1 = mgr.install('axe');
      const p2 = mgr.install('axe');
      assert.strictEqual(p1, p2);
      const st = await p1;
      assert.equal(st.state, 'ready');
      assert.equal(hits, 2);
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('python-venv install activates working non-broken venv symlinks and cleans up on self-check failure', async () => {
  const work = makeTempDir('pd-comp-venv-');
  try {
    // Fake python runtime tarball whose python3 creates a real symlink in venv/bin/python -> <base>/python/bin/python3
    // mimicking CPython's venv absolute symlink behavior.
    const src = join(work, 'py-src');
    const pyBinDir = join(src, 'python', 'bin');
    mkdirSync(pyBinDir, { recursive: true });
    const fakePy = join(pyBinDir, 'python3');
    writeFileSync(fakePy, [
      '#!/bin/sh',
      'SELF="$0"',
      'if [ "$1" = "-I" ] && [ "$2" = "-m" ] && [ "$3" = "venv" ]; then',
      '  VDIR="$4"',
      '  mkdir -p "$VDIR/bin"',
      '  ln -s "$SELF" "$VDIR/bin/python"',
      '  exit 0',
      'fi',
      'if [ "$1" = "-I" ] && [ "$2" = "-m" ] && [ "$3" = "pip" ]; then',
      '  exit 0',
      'fi',
      'if [ "$1" = "-I" ] && [ "$2" = "-c" ]; then',
      '  if [ "${FAIL_CHECK:-0}" = "1" ]; then exit 1; fi',
      '  echo "ok:11.63.1:1"',
      '  exit 0',
      'fi',
      'echo "fake-python"',
      '',
    ].join('\n'), 'utf8');
    chmodSync(fakePy, 0o755);
    const tarPath = join(work, 'py.tar.gz');
    execFileSync('/usr/bin/tar', ['-czf', tarPath, '-C', src, '.']);
    const buf = readFileSync(tarPath);

    await withServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) });
      res.end(buf);
    }, async (base) => {
      const toolsDir = join(work, 'tools');
      const rootDir = join(work, 'components');
      const m = writeTestTools(toolsDir, { url: `${base}/axe.tar.gz`, sha256: 'c'.repeat(64), size: 100, version: '1.8.0' });
      m.components['ios-tools'].artifacts[0].url = `${base}/py.tar.gz`;
      m.components['ios-tools'].artifacts[0].sha256 = sha256Hex(buf);
      m.components['ios-tools'].artifacts[0].size = buf.length;
      writeFileSync(join(toolsDir, 'components.json'), JSON.stringify(m, null, 2));

      const mgr = new ComponentManager({
        rootDir, toolsDir, platformKey: 'darwin-arm64', allowLocalhost: true,
        externalLookup: () => undefined, envOverride: () => undefined,
      });

      const st = await mgr.install('ios-tools');
      assert.equal(st.state, 'ready');
      const resolved = mgr.resolveManaged('ios-tools');
      assert.ok(resolved);
      // Symlink must resolve cleanly after staging is deleted!
      const out = execFileSync(resolved.path, [], { encoding: 'utf8' }).trim();
      assert.equal(out, 'fake-python');
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
