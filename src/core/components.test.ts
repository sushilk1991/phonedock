// Unit tests for managed components: manifest/lock validation, bsdtar argv & post-extraction tree walk,
// lock-free atomic activation & concurrent races, failure cleanup at every step, .last-used & pruning/GC,
// python-venv pre-rename relocation, lookup order, and auto-trigger dedupe/backoff.
// Uses local HTTP fixture servers and fake tarballs only (never hits the network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ComponentManager, getComponentManager, isolatedPythonEnv, resolveWdaSource, safeExtractTarGz, setComponentManager,
  tarExtractArgv, verifyExtractedTree,
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
  wdaArtifact: { url: string; sha256: string; size: number; version: string } = {
    url: 'https://github.com/appium/WebDriverAgent/archive/refs/tags/v16.15.3.tar.gz', sha256: 'd'.repeat(64), size: 100, version: '16.15.3',
  },
): ComponentManifest {
  mkdirSync(toolsDir, { recursive: true });
  mkdirSync(join(toolsDir, 'licenses'), { recursive: true });
  writeFileSync(join(toolsDir, 'licenses', 'WebDriverAgent-LICENSE'), 'BSD License\n', 'utf8');
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
      wda: {
        id: 'wda',
        displayName: 'iPhone WebDriverAgent',
        description: 'Test wda',
        kind: 'source-archive',
        version: wdaArtifact.version,
        publishedAt: '2026-10-16T21:41:13Z',
        estimatedDiskBytes: 5_000_000,
        licenseFile: 'licenses/WebDriverAgent-LICENSE',
        artifacts: [{
          platforms: ['darwin-arm64', 'darwin-x64'],
          filename: `WebDriverAgent-${wdaArtifact.version}.tar.gz`,
          url: wdaArtifact.url,
          sha256: wdaArtifact.sha256,
          size: wdaArtifact.size,
        }],
        verify: { sourceDir: `WebDriverAgent-${wdaArtifact.version}`, requiredFiles: ['WebDriverAgent.xcodeproj/project.pbxproj', 'LICENSE'] },
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
  // WebDriverAgent: a pinned tag archive (never HEAD), at least 14 days old when pinned, with its licence shipped.
  const wda = manifest.components.wda;
  assert.equal(wda.kind, 'source-archive');
  assert.match(wda.artifacts[0].url, /^https:\/\/github\.com\/appium\/WebDriverAgent\/archive\/refs\/tags\/v\d+\.\d+\.\d+\.tar\.gz$/);
  assert.match(wda.artifacts[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(wda.verify.sourceDir, `WebDriverAgent-${wda.version}`);
  assert.ok(manifest.allowedHosts.includes('codeload.github.com'), 'the tag archive redirects to codeload.github.com');
  assert.match(readFileSync(join(toolsDir, wda.licenseFile!), 'utf8'), /^BSD License\n\nFor WebDriverAgent software/);
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

test('safeExtractTarGz invokes /usr/bin/tar with secure defaults and never passes -P', async () => {
  const work = makeTempDir('pd-comp-tar-argv-');
  try {
    const dest = join(work, 'dest');
    const calls: { cmd: string; args: string[] }[] = [];
    await safeExtractTarGz('/tmp/archive.tar.gz', dest, async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, '/usr/bin/tar');
    assert.deepEqual(calls[0].args, ['-xzf', '/tmp/archive.tar.gz', '-C', dest, '--no-same-owner']);
    assert.deepEqual(tarExtractArgv('/tmp/archive.tar.gz', dest), ['-xzf', '/tmp/archive.tar.gz', '-C', dest, '--no-same-owner']);
    for (const arg of calls[0].args) {
      assert.ok(arg !== '-P' && arg !== '--absolute-names', `must never pass ${arg} to tar`);
      assert.ok(!/^-[^-]*P/.test(arg), `must never combine -P into ${arg}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('post-extraction walk rejects FIFOs, escaping symlinks, symlink chains, dangling symlinks, and nlink > 1 files while allowing valid frameworks', async () => {
  const work = makeTempDir('pd-comp-walk-');
  try {
    // 1. FIFO rejected
    const fifoDir = join(work, 'fifo-dir');
    mkdirSync(fifoDir, { recursive: true });
    execFileSync('/usr/bin/mkfifo', [join(fifoDir, 'pipe')]);
    assert.throws(() => verifyExtractedTree(fifoDir), (e: any) => e.code === 'unsafe_archive');

    // 2. Direct escaping symlink rejected
    const escDir = join(work, 'esc-dir');
    mkdirSync(escDir, { recursive: true });
    writeFileSync(join(work, 'outside.txt'), 'secret');
    symlinkSync('../outside.txt', join(escDir, 'leak'));
    assert.throws(() => verifyExtractedTree(escDir), (e: any) => e.code === 'unsafe_archive');

    // 3. Escaping symlink chain rejected
    const chainDir = join(work, 'chain-dir');
    mkdirSync(chainDir, { recursive: true });
    symlinkSync('.', join(chainDir, 'a'));
    symlinkSync('a/..', join(chainDir, 'b'));
    symlinkSync('b/outside.txt', join(chainDir, 'axe'));
    assert.throws(() => verifyExtractedTree(chainDir), (e: any) => e.code === 'unsafe_archive');

    // 4. Dangling/unresolvable symlink rejected
    const danglingDir = join(work, 'dangling-dir');
    mkdirSync(danglingDir, { recursive: true });
    symlinkSync('does-not-exist', join(danglingDir, 'broken'));
    assert.throws(() => verifyExtractedTree(danglingDir), (e: any) => e.code === 'unsafe_archive');

    // 5. Hardlinked regular file (nlink > 1) rejected
    const hardlinkDir = join(work, 'hardlink-dir');
    mkdirSync(hardlinkDir, { recursive: true });
    writeFileSync(join(hardlinkDir, 'orig.txt'), 'hello');
    linkSync(join(hardlinkDir, 'orig.txt'), join(hardlinkDir, 'copy.txt'));
    assert.throws(() => verifyExtractedTree(hardlinkDir), (e: any) => e.code === 'unsafe_archive');

    // 6. Real tarballs with traversal, FIFO, escaping symlink, or hardlink are rejected by safeExtractTarGz
    const buildTar = (kind: string, outPath: string) => {
      execFileSync('python3', ['-c', `
import io, tarfile, sys
kind, out = sys.argv[1], sys.argv[2]
with tarfile.open(out, 'w:gz') as tf:
    if kind == 'traversal':
        ti = tarfile.TarInfo('../escape.txt')
        data = b'pwn'
        ti.size = len(data)
        tf.addfile(ti, io.BytesIO(data))
    elif kind == 'fifo':
        ti = tarfile.TarInfo('pipe')
        ti.type = tarfile.FIFOTYPE
        tf.addfile(ti)
    elif kind == 'symlink':
        ti = tarfile.TarInfo('badlink')
        ti.type = tarfile.SYMTYPE
        ti.linkname = '../../../etc/passwd'
        tf.addfile(ti)
    elif kind == 'hardlink':
        f = tarfile.TarInfo('orig.txt')
        data = b'hello'
        f.size = len(data)
        f.mode = 0o644
        tf.addfile(f, io.BytesIO(data))
        h = tarfile.TarInfo('copy.txt')
        h.type = tarfile.LNKTYPE
        h.linkname = 'orig.txt'
        tf.addfile(h)
    elif kind == 'valid-framework':
        for d in ['Frameworks', 'Frameworks/Foo.framework', 'Frameworks/Foo.framework/Versions', 'Frameworks/Foo.framework/Versions/A']:
            ti = tarfile.TarInfo(d)
            ti.type = tarfile.DIRTYPE
            ti.mode = 0o755
            tf.addfile(ti)
        f = tarfile.TarInfo('Frameworks/Foo.framework/Versions/A/Foo')
        data = b'ok'
        f.size = len(data)
        f.mode = 0o644
        tf.addfile(f, io.BytesIO(data))
        l1 = tarfile.TarInfo('Frameworks/Foo.framework/Versions/Current')
        l1.type = tarfile.SYMTYPE
        l1.linkname = 'A'
        tf.addfile(l1)
        l2 = tarfile.TarInfo('Frameworks/Foo.framework/Foo')
        l2.type = tarfile.SYMTYPE
        l2.linkname = 'Versions/Current/Foo'
        tf.addfile(l2)
`, kind, outPath]);
    };

    const travTar = join(work, 'traversal.tar.gz');
    buildTar('traversal', travTar);
    await assert.rejects(() => safeExtractTarGz(travTar, join(work, 'out-traversal')));
    assert.equal(existsSync(join(work, 'escape.txt')), false);

    for (const bad of ['fifo', 'symlink', 'hardlink']) {
      const p = join(work, `${bad}.tar.gz`);
      buildTar(bad, p);
      await assert.rejects(() => safeExtractTarGz(p, join(work, `out-${bad}`)), (e: any) => e.code === 'unsafe_archive', `expected ${bad} to be rejected`);
    }

    // 7. Valid relative framework symlinks (same layout as AXe) pass
    const okTar = join(work, 'valid-framework.tar.gz');
    buildTar('valid-framework', okTar);
    await safeExtractTarGz(okTar, join(work, 'out-ok'));
    assert.equal(readFileSync(join(work, 'out-ok', 'Frameworks/Foo.framework/Foo'), 'utf8'), 'ok');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('two ComponentManager instances racing concurrently on the same key: one wins, the other adopts, zero staging left', async () => {
  const work = makeTempDir('pd-comp-race-');
  try {
    const tar = makeFakeAxeTarGz(work, '1.8.0');
    let downloads = 0;
    let releaseBoth!: () => void;
    const bothArrived = new Promise<void>((r) => {
      let seen = 0;
      releaseBoth = () => { if (++seen >= 2) r(); };
    });

    await withServer(async (_req, res) => {
      downloads++;
      releaseBoth();
      await bothArrived;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(tar.buf.length) });
      res.end(tar.buf);
    }, async (base) => {
      const toolsDir = join(work, 'tools');
      const rootDir = join(work, 'components');
      const m = writeTestTools(toolsDir, { url: `${base}/axe.tar.gz`, sha256: tar.sha256, size: tar.buf.length, version: '1.8.0' });
      const key = componentKey(m.components.axe, m.components.axe.artifacts[0]);

      const mgr1 = new ComponentManager({
        rootDir, toolsDir, platformKey: 'darwin-arm64', allowLocalhost: true,
        externalLookup: () => undefined, envOverride: () => undefined,
      });
      const mgr2 = new ComponentManager({
        rootDir, toolsDir, platformKey: 'darwin-arm64', allowLocalhost: true,
        externalLookup: () => undefined, envOverride: () => undefined,
      });

      // Both managers start simultaneously on the same key and proceed through download, extract, self-check, and rename.
      const [st1, st2] = await Promise.all([mgr1.install('axe'), mgr2.install('axe')]);
      assert.equal(st1.state, 'ready');
      assert.equal(st2.state, 'ready');
      assert.equal(st1.installedVersion, '1.8.0');
      assert.equal(st2.installedVersion, '1.8.0');
      assert.equal(downloads, 2, 'both concurrent processes downloaded independently before atomic rename race');

      // Activated key has both .ready.json and .last-used, and zero stage-* dirs remain.
      const axeDir = join(rootDir, 'axe');
      const entries = readdirSync(axeDir);
      assert.deepEqual(entries, [key]);
      assert.ok(existsSync(join(axeDir, key, '.ready.json')));
      assert.ok(existsSync(join(axeDir, key, '.last-used')));
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('failure at every install step never creates a key dir without .ready.json and leaves no staging behind', async () => {
  const work = makeTempDir('pd-comp-failures-');
  let uncaught: unknown;
  const onUncaught = (err: unknown) => { uncaught = err; };
  process.on('uncaughtException', onUncaught);
  try {
    const goodTar = makeFakeAxeTarGz(work, '1.8.0');
    const badVerTar = makeFakeAxeTarGz(work, '9.9.9');
    const tamperedBuf = Buffer.from(goodTar.buf);
    tamperedBuf[tamperedBuf.length - 1] ^= 0xff;

    // Build a tarball containing a FIFO (valid sha256, fails post-extraction walk)
    const fifoTarPath = join(work, 'fifo-payload.tar.gz');
    execFileSync('python3', ['-c', `
import tarfile, sys
with tarfile.open(sys.argv[1], 'w:gz') as tf:
    ti = tarfile.TarInfo('pipe')
    ti.type = tarfile.FIFOTYPE
    tf.addfile(ti)
`, fifoTarPath]);
    const fifoBuf = readFileSync(fifoTarPath);
    const fifoSha = sha256Hex(fifoBuf);

    let mode: 'http500' | 'tampered' | 'fifo' | 'badver' | 'enospc' = 'http500';
    await withServer((_req, res) => {
      if (mode === 'http500') {
        res.writeHead(500);
        res.end('server error');
        return;
      }
      if (mode === 'enospc') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(goodTar.buf.length) });
        setTimeout(() => res.end(goodTar.buf), 80);
        return;
      }
      const buf = mode === 'tampered' ? tamperedBuf : mode === 'fifo' ? fifoBuf : badVerTar.buf;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) });
      res.end(buf);
    }, async (base) => {
      const assertClean = (rootDir: string) => {
        const axeDir = join(rootDir, 'axe');
        if (!existsSync(axeDir)) return;
        const entries = readdirSync(axeDir);
        assert.deepEqual(entries, [], `expected empty axe dir after failure, found ${entries.join(', ')}`);
      };

      // Step 1a: Download HTTP 500
      {
        mode = 'http500';
        const toolsDir = join(work, 't-http500');
        const rootDir = join(work, 'c-http500');
        writeTestTools(toolsDir, { url: `${base}/axe.tar.gz`, sha256: goodTar.sha256, size: goodTar.buf.length, version: '1.8.0' });
        const mgr = new ComponentManager({ rootDir, toolsDir, platformKey: 'darwin-arm64', allowLocalhost: true, externalLookup: () => undefined, envOverride: () => undefined });
        await assert.rejects(() => mgr.install('axe'), (e: any) => e.code === 'download_failed');
        assertClean(rootDir);
      }

      // Step 1b: Async download write stream ENOSPC
      {
        mode = 'enospc';
        const toolsDir = join(work, 't-enospc');
        const rootDir = join(work, 'c-enospc');
        writeTestTools(toolsDir, { url: `${base}/axe.tar.gz`, sha256: goodTar.sha256, size: goodTar.buf.length, version: '1.8.0' });
        const fakeStreamFactory = (() => {
          const em = new EventEmitter() as any;
          em.write = () => true;
          em.end = () => {};
          em.destroy = () => {};
          setTimeout(() => em.emit('error', Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })), 15);
          return em;
        }) as any;
        const mgr = new ComponentManager({
          rootDir, toolsDir, platformKey: 'darwin-arm64', allowLocalhost: true,
          createWriteStream: fakeStreamFactory, externalLookup: () => undefined, envOverride: () => undefined,
        });
        await assert.rejects(() => mgr.install('axe'), (e: any) => e.code === 'download_write_failed');
        assert.equal(uncaught, undefined);
        assertClean(rootDir);
      }

      // Step 2: Checksum mismatch
      {
        mode = 'tampered';
        const toolsDir = join(work, 't-sha');
        const rootDir = join(work, 'c-sha');
        writeTestTools(toolsDir, { url: `${base}/axe.tar.gz`, sha256: goodTar.sha256, size: goodTar.buf.length, version: '1.8.0' });
        const mgr = new ComponentManager({ rootDir, toolsDir, platformKey: 'darwin-arm64', allowLocalhost: true, externalLookup: () => undefined, envOverride: () => undefined });
        await assert.rejects(() => mgr.install('axe'), (e: any) => e.code === 'checksum_mismatch');
        assertClean(rootDir);
      }

      // Step 3: Post-extraction tree walk rejection (FIFO)
      {
        mode = 'fifo';
        const toolsDir = join(work, 't-fifo');
        const rootDir = join(work, 'c-fifo');
        writeTestTools(toolsDir, { url: `${base}/axe.tar.gz`, sha256: fifoSha, size: fifoBuf.length, version: '1.8.0' });
        const mgr = new ComponentManager({ rootDir, toolsDir, platformKey: 'darwin-arm64', allowLocalhost: true, externalLookup: () => undefined, envOverride: () => undefined });
        await assert.rejects(() => mgr.install('axe'), (e: any) => e.code === 'unsafe_archive');
        assertClean(rootDir);
      }

      // Step 4: Self-check failure (wrong version output)
      {
        mode = 'badver';
        const toolsDir = join(work, 't-badver');
        const rootDir = join(work, 'c-badver');
        writeTestTools(toolsDir, { url: `${base}/axe.tar.gz`, sha256: badVerTar.sha256, size: badVerTar.buf.length, version: '1.8.0' });
        const mgr = new ComponentManager({ rootDir, toolsDir, platformKey: 'darwin-arm64', allowLocalhost: true, externalLookup: () => undefined, envOverride: () => undefined });
        await assert.rejects(() => mgr.install('axe'), (e: any) => e.code === 'self_check_failed');
        assertClean(rootDir);
      }
    });
  } finally {
    process.off('uncaughtException', onUncaught);
    rmSync(work, { recursive: true, force: true });
  }
});

test('atomic activation, .last-used file, pin bump coexistence, 30-day pruning, and startup GC of stage-* (>24h) and .trash-*', async () => {
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
        now: () => nowMs, pidAlive: (pid) => pid === process.pid,
        externalLookup: () => undefined, envOverride: () => undefined,
      });

      const st1 = await mgr.install('axe');
      assert.equal(st1.state, 'ready');
      assert.equal(st1.installedVersion, '1.8.0');
      assert.equal(st1.updateAvailable, false);
      const readyBefore = readFileSync(join(rootDir, 'axe', key1, '.ready.json'), 'utf8');
      assert.ok(existsSync(join(rootDir, 'axe', key1, '.last-used')));

      // touchUsed updates .last-used without rewriting .ready.json
      nowMs += 120_000;
      mgr.touchUsed('axe');
      assert.equal(readFileSync(join(rootDir, 'axe', key1, '.ready.json'), 'utf8'), readyBefore);
      assert.equal(readFileSync(join(rootDir, 'axe', key1, '.last-used'), 'utf8').trim(), new Date(nowMs).toISOString());

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

      // Seed abandoned dead-PID stage-<pid>-* (>24h), fresh dead-PID stage-<pid>-* (<24h), and leftover dead-PID .trash-*
      const oldStage = join(rootDir, 'axe', 'stage-999991-dead');
      const freshStage = join(rootDir, 'axe', 'stage-999992-fresh');
      const leftoverTrash = join(rootDir, 'axe', '.trash-999991-dead');
      mkdirSync(oldStage, { recursive: true });
      mkdirSync(freshStage, { recursive: true });
      mkdirSync(leftoverTrash, { recursive: true });
      const twoDaysAgo = new Date(nowMs - 48 * 3_600_000);
      const oneHourAgo = new Date(nowMs - 3_600_000);
      utimesSync(oldStage, twoDaysAgo, twoDaysAgo);
      utimesSync(freshStage, oneHourAgo, oneHourAgo);

      // 10 days later: key1 must NOT be pruned; dead old stage & trash ARE removed; fresh stage is kept
      const gc1 = mgr.prune('axe');
      assert.deepEqual(gc1.removedKeys, []);
      assert.deepEqual(gc1.removedStaging, ['axe/stage-999991-dead']);
      assert.deepEqual(gc1.removedTrash, ['axe/.trash-999991-dead']);
      assert.equal(existsSync(oldStage), false);
      assert.equal(existsSync(leftoverTrash), false);
      assert.equal(existsSync(freshStage), true);
      assert.ok(existsSync(join(rootDir, 'axe', key1)));

      // 35 days later: key1 IS pruned via .trash-* rename+remove, pinned key2 is NEVER pruned
      nowMs += 35 * 86_400_000;
      const pruned = mgr.prune('axe');
      assert.deepEqual(pruned.removedKeys, [`axe/${key1}`]);
      assert.equal(existsSync(join(rootDir, 'axe', key1)), false);
      assert.equal(existsSync(join(rootDir, 'axe', key2)), true);
      assert.ok(!readdirSync(join(rootDir, 'axe')).some((n) => n.startsWith('.trash-')));
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
        key, version: ver, activatedAt, sizeBytes: 10, binaryRelPath: 'axe',
      }));
      writeFileSync(join(dir, '.last-used'), activatedAt + '\n');
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
    const iosKey = componentKey(m.components['ios-tools'], m.components['ios-tools'].artifacts[0]);
    const iosDir = join(rootDir, 'ios-tools', iosKey);
    const pyBin = mkBin(join(iosDir, 'venv', 'bin', 'python'));
    writeFileSync(join(iosDir, '.ready.json'), JSON.stringify({
      key: iosKey, version: '11.63.1', activatedAt: '2026-11-24T00:00:00Z', sizeBytes: 10, binaryRelPath: 'venv/bin/python',
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
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(hits, 1);
      assert.equal(mgr.status('axe').state, 'failed');
      assert.equal(mgr.triggerAuto('axe'), false);
      assert.equal(hits, 1);

      // Advance past first backoff, succeed, and verify concurrent dedupe
      nowMs += 11_000;
      shouldFail = false;
      assert.equal(mgr.triggerAuto('axe'), true);
      assert.equal(mgr.triggerAuto('axe'), false);
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

test('python-venv stages, relocates symlinks/pyvenv.cfg/shebangs before atomic rename, and cleans up on self-check failure', async () => {
  const work = makeTempDir('pd-comp-venv-');
  try {
    const makeFakePythonTar = (failSelfCheck: boolean) => {
      const src = join(work, `py-src-${failSelfCheck ? 'fail' : 'ok'}`);
      const pyBinDir = join(src, 'python', 'bin');
      mkdirSync(pyBinDir, { recursive: true });
      const fakePy = join(pyBinDir, 'python3');
      writeFileSync(fakePy, [
        '#!/bin/sh',
        'SELF="$0"',
        'if [ "$1" = "-I" ] && [ "$2" = "-m" ] && [ "$3" = "venv" ]; then',
        '  VDIR="$4"',
        '  mkdir -p "$VDIR/bin"',
        '  ln -s "$SELF" "$VDIR/bin/python3"',
        '  ln -s "python3" "$VDIR/bin/python"',
        '  printf "home = %s\\nexecutable = %s\\n" "$(dirname "$SELF")" "$SELF" > "$VDIR/pyvenv.cfg"',
        `  printf '#!/bin/sh\\n'"'''exec' '%s/bin/python' \"\\$0\" \"\\$@\"\\n' '''\\nprint(1)\\n" "$VDIR" > "$VDIR/bin/pymd3-cli"`,
        '  chmod +x "$VDIR/bin/pymd3-cli"',
        '  exit 0',
        'fi',
        'if [ "$1" = "-I" ] && [ "$2" = "-m" ] && [ "$3" = "pip" ]; then',
        '  exit 0',
        'fi',
        'if [ "$1" = "-I" ] && [ "$2" = "-c" ]; then',
        failSelfCheck ? '  exit 1' : '  echo "ok:11.63.1:1"; exit 0',
        'fi',
        'echo "fake-python"',
        '',
      ].join('\n'), 'utf8');
      chmodSync(fakePy, 0o755);
      const tarPath = join(work, `py-${failSelfCheck ? 'fail' : 'ok'}.tar.gz`);
      execFileSync('/usr/bin/tar', ['-czf', tarPath, '-C', src, '.']);
      const buf = readFileSync(tarPath);
      return { buf, sha256: sha256Hex(buf) };
    };

    const okPy = makeFakePythonTar(false);
    const failPy = makeFakePythonTar(true);

    await withServer((req, res) => {
      const buf = req.url?.includes('fail') ? failPy.buf : okPy.buf;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) });
      res.end(buf);
    }, async (base) => {
      // 1. Failing self-check never activates a key dir and leaves zero staging dirs
      {
        const toolsDir = join(work, 'tools-fail');
        const rootDir = join(work, 'comp-fail');
        const m = writeTestTools(toolsDir, { url: `${base}/axe.tar.gz`, sha256: 'c'.repeat(64), size: 100, version: '1.8.0' });
        m.components['ios-tools'].artifacts[0].url = `${base}/py-fail.tar.gz`;
        m.components['ios-tools'].artifacts[0].sha256 = failPy.sha256;
        m.components['ios-tools'].artifacts[0].size = failPy.buf.length;
        writeFileSync(join(toolsDir, 'components.json'), JSON.stringify(m, null, 2));
        const mgr = new ComponentManager({
          rootDir, toolsDir, platformKey: 'darwin-arm64', allowLocalhost: true,
          externalLookup: () => undefined, envOverride: () => undefined,
        });
        await assert.rejects(() => mgr.install('ios-tools'));
        assert.deepEqual(readdirSync(join(rootDir, 'ios-tools')), []);
      }

      // 2. Successful install activates atomically with relative python3 symlink & rewritten pyvenv.cfg/shebangs
      {
        const toolsDir = join(work, 'tools-ok');
        const rootDir = join(work, 'comp-ok');
        const m = writeTestTools(toolsDir, { url: `${base}/axe.tar.gz`, sha256: 'c'.repeat(64), size: 100, version: '1.8.0' });
        m.components['ios-tools'].artifacts[0].url = `${base}/py-ok.tar.gz`;
        m.components['ios-tools'].artifacts[0].sha256 = okPy.sha256;
        m.components['ios-tools'].artifacts[0].size = okPy.buf.length;
        writeFileSync(join(toolsDir, 'components.json'), JSON.stringify(m, null, 2));
        const key = componentKey(m.components['ios-tools'], m.components['ios-tools'].artifacts[0]);

        const mgr = new ComponentManager({
          rootDir, toolsDir, platformKey: 'darwin-arm64', allowLocalhost: true,
          externalLookup: () => undefined, envOverride: () => undefined,
        });
        const st = await mgr.install('ios-tools');
        assert.equal(st.state, 'ready');
        assert.deepEqual(readdirSync(join(rootDir, 'ios-tools')), [key]);

        const finalDir = join(rootDir, 'ios-tools', key);
        const py3Link = join(finalDir, 'venv', 'bin', 'python3');
        assert.ok(lstatSync(py3Link).isSymbolicLink());
        assert.equal(readlinkSync(py3Link), '../../python/bin/python3');

        const pyvenvCfg = readFileSync(join(finalDir, 'venv', 'pyvenv.cfg'), 'utf8');
        assert.ok(!pyvenvCfg.includes('stage-'), `pyvenv.cfg must not reference staging: ${pyvenvCfg}`);
        assert.ok(pyvenvCfg.includes(key));

        const cliScript = readFileSync(join(finalDir, 'venv', 'bin', 'pymd3-cli'), 'utf8');
        assert.ok(!cliScript.includes('stage-'), `shebang wrapper must not reference staging: ${cliScript}`);
        assert.ok(cliScript.includes(key));

        const resolved = mgr.resolveManaged('ios-tools');
        assert.ok(resolved);
        const out = execFileSync(resolved.path, [], { encoding: 'utf8' }).trim();
        assert.equal(out, 'fake-python');
      }
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('progress throttling skips status/external probes on chunk updates', async () => {
  const work = makeTempDir('pd-comp-throttle-');
  try {
    const tar = makeFakeAxeTarGz(work, '1.8.0', { 'pad.txt': 'x'.repeat(20_000) });
    await withServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(tar.buf.length) });
      const chunkSize = Math.ceil(tar.buf.length / 40);
      let off = 0;
      const sendNext = () => {
        if (off >= tar.buf.length) { res.end(); return; }
        res.write(tar.buf.subarray(off, off + chunkSize));
        off += chunkSize;
        setImmediate(sendNext);
      };
      sendNext();
    }, async (base) => {
      const toolsDir = join(work, 'tools');
      const rootDir = join(work, 'components');
      writeTestTools(toolsDir, { url: `${base}/axe.tar.gz`, sha256: tar.sha256, size: tar.buf.length, version: '1.8.0' });
      let externalProbes = 0;
      let events = 0;
      const mgr = new ComponentManager({
        rootDir, toolsDir, platformKey: 'darwin-arm64', allowLocalhost: true,
        externalLookup: () => { externalProbes++; return '/usr/local/bin/axe'; },
        envOverride: () => undefined,
        onChange: () => { events++; },
      });
      const st = await mgr.install('axe');
      assert.equal(st.state, 'ready');
      assert.equal(externalProbes, 1, 'external discovery must run at most once during install, never per chunk');
      assert.ok(events < 15, `expected throttled events, got ${events}`);
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('override protects old key from pruning, invalid override blocks auto-install, external never claims updateAvailable', () => {
  const work = makeTempDir('pd-comp-overrides-');
  try {
    const toolsDir = join(work, 'tools');
    const rootDir = join(work, 'components');
    writeTestTools(toolsDir, { url: 'https://github.com/cameroncooke/AXe/releases/download/v1.8.0/a.tar.gz', sha256: 'c'.repeat(64), size: 100, version: '1.8.0' });

    const oldKey = '1.7.0-aaaaaaaaaaaa';
    const oldDir = join(rootDir, 'axe', oldKey);
    mkdirSync(oldDir, { recursive: true });
    const oldBin = join(oldDir, 'axe');
    writeFileSync(oldBin, '#!/bin/sh\necho 1.7.0\n');
    chmodSync(oldBin, 0o755);
    const oldIso = '2026-09-01T00:00:00Z';
    writeFileSync(join(oldDir, '.ready.json'), JSON.stringify({
      key: oldKey, version: '1.7.0', activatedAt: oldIso, sizeBytes: 10, binaryRelPath: 'axe',
    }));
    writeFileSync(join(oldDir, '.last-used'), oldIso + '\n');
    const aliasLink = join(work, 'axe-override-link');
    symlinkSync(oldBin, aliasLink);

    // prune() 60 days later MUST NOT delete oldKey when envOverride resolves into it (directly or via symlink)
    const nowMs = Date.parse('2026-11-24T00:00:00Z');
    const mgrOverride = new ComponentManager({
      rootDir, toolsDir, platformKey: 'darwin-arm64', now: () => nowMs,
      envOverride: (id) => (id === 'axe' ? aliasLink : undefined),
      externalLookup: () => undefined,
    });
    assert.deepEqual(mgrOverride.prune('axe').removedKeys, []);
    assert.ok(existsSync(oldBin));

    // invalid override blocks auto-install and reports invalid_override
    const missingOverride = join(work, 'does-not-exist', 'axe');
    const mgrInvalid = new ComponentManager({
      rootDir, toolsDir, platformKey: 'darwin-arm64', autoEnabled: () => true,
      envOverride: (id) => (id === 'axe' ? missingOverride : undefined),
      externalLookup: () => undefined,
    });
    assert.equal(mgrInvalid.triggerAuto('axe'), false);
    const invalidSt = mgrInvalid.status('axe');
    assert.equal(invalidSt.state, 'failed');
    assert.equal(invalidSt.source, 'override');
    assert.equal(invalidSt.updateAvailable, false);
    assert.equal(invalidSt.error?.code, 'invalid_override');

    // external copy has updateAvailable=false and clear detail text
    rmSync(oldDir, { recursive: true, force: true });
    const extBin = join(work, 'host-axe');
    writeFileSync(extBin, '#!/bin/sh\necho 1.8.0\n');
    chmodSync(extBin, 0o755);
    const mgrExt = new ComponentManager({
      rootDir, toolsDir, platformKey: 'darwin-arm64',
      envOverride: () => undefined,
      externalLookup: (id) => (id === 'axe' ? extBin : undefined),
    });
    const extSt = mgrExt.status('axe');
    assert.equal(extSt.state, 'ready');
    assert.equal(extSt.source, 'external');
    assert.equal(extSt.updateAvailable, false);
    assert.match(extSt.detail ?? '', /installed on this Mac/i);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('Round 4 #1 (P1): touchUsed never recreates a pruned key, and activation cleans up a garbage key without .ready.json', async () => {
  const work = makeTempDir('pd-comp-r4-touch-');
  try {
    const tar = makeFakeAxeTarGz(work, '1.8.0');
    await withServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(tar.buf.length) });
      res.end(tar.buf);
    }, async (base) => {
      const toolsDir = join(work, 'tools');
      const rootDir = join(work, 'components');
      const m = writeTestTools(toolsDir, { url: `${base}/axe.tar.gz`, sha256: tar.sha256, size: tar.buf.length, version: '1.8.0' });
      const pinnedKey = componentKey(m.components.axe, m.components.axe.artifacts[0]);

      // Part A: Exact interleaving — A passes ready check in touchUsed(), B prunes oldKey before A writes .last-used
      const oldKey = '1.7.0-aaaaaaaaaaaa';
      const oldDir = join(rootDir, 'axe', oldKey);
      mkdirSync(oldDir, { recursive: true });
      const oldBin = join(oldDir, 'axe');
      writeFileSync(oldBin, '#!/bin/sh\necho 1.7.0\n');
      chmodSync(oldBin, 0o755);
      const expiredIso = '2026-09-01T00:00:00Z';
      writeFileSync(join(oldDir, '.ready.json'), JSON.stringify({
        key: oldKey, version: '1.7.0', activatedAt: expiredIso, sizeBytes: 10, binaryRelPath: 'axe',
      }));
      writeFileSync(join(oldDir, '.last-used'), expiredIso + '\n');

      const nowMs = Date.parse('2026-11-24T00:00:00Z');
      const prunerB = new ComponentManager({
        rootDir, toolsDir, platformKey: 'darwin-arm64', allowLocalhost: true, now: () => nowMs,
        externalLookup: () => undefined, envOverride: () => undefined,
      });

      let hookFired = false;
      const toucherA = new ComponentManager({
        rootDir, toolsDir, platformKey: 'darwin-arm64', allowLocalhost: true, now: () => nowMs,
        externalLookup: () => undefined, envOverride: () => undefined,
        onBeforeTouchWrite: (_id, key) => {
          hookFired = true;
          assert.equal(key, oldKey);
          // B prunes oldKey right after A saw .ready.json
          assert.deepEqual(prunerB.prune('axe').removedKeys, [`axe/${oldKey}`]);
          assert.equal(existsSync(oldDir), false);
        },
      });

      toucherA.touchUsed('axe');
      assert.equal(hookFired, true);
      // A must NOT have recreated oldDir with a lone .last-used!
      assert.equal(existsSync(oldDir), false);

      // Part B: Defensive activation — pre-existing garbage <key> without .ready.json is trashed and activation succeeds
      const garbageKeyDir = join(rootDir, 'axe', pinnedKey);
      mkdirSync(garbageKeyDir, { recursive: true });
      writeFileSync(join(garbageKeyDir, '.last-used'), expiredIso + '\n');
      assert.equal(existsSync(join(garbageKeyDir, '.ready.json')), false);

      const installer = new ComponentManager({
        rootDir, toolsDir, platformKey: 'darwin-arm64', allowLocalhost: true,
        now: () => nowMs, externalLookup: () => undefined, envOverride: () => undefined,
      });
      const st = await installer.install('axe');
      assert.equal(st.state, 'ready');
      assert.equal(st.installedVersion, '1.8.0');
      assert.ok(existsSync(join(garbageKeyDir, '.ready.json')));
      assert.deepEqual(readdirSync(join(rootDir, 'axe')), [pinnedKey]);
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('Round 4 #2 (P2): slow pruner re-checks trashed copy and restores (or discards duplicate of) a fresh reinstall', () => {
  const work = makeTempDir('pd-comp-r4-slowprune-');
  try {
    const toolsDir = join(work, 'tools');
    const rootDir = join(work, 'components');
    writeTestTools(toolsDir, { url: 'https://github.com/cameroncooke/AXe/releases/download/v1.9.0/a.tar.gz', sha256: 'c'.repeat(64), size: 100, version: '1.9.0' });

    const targetKey = '1.8.0-bbbbbbbbbbbb';
    const keyDir = join(rootDir, 'axe', targetKey);
    const seedKey = (activatedIso: string, lastUsedIso: string, tag: string) => {
      mkdirSync(keyDir, { recursive: true });
      const bin = join(keyDir, 'axe');
      writeFileSync(bin, `#!/bin/sh\necho "${tag}"\n`);
      chmodSync(bin, 0o755);
      writeFileSync(join(keyDir, '.ready.json'), JSON.stringify({
        key: targetKey, version: '1.8.0', activatedAt: activatedIso, sizeBytes: 10, binaryRelPath: 'axe',
      }));
      writeFileSync(join(keyDir, '.last-used'), lastUsedIso + '\n');
    };

    const expiredIso = '2026-09-01T00:00:00Z';
    const nowIso = '2026-11-24T00:00:00Z';
    const nowMs = Date.parse(nowIso);

    // Part A: A reads expired copy and pauses -> B prunes -> C reinstalls fresh copy -> A trashes C's copy,
    // re-checks activatedAt/.last-used, sees it's within 30 days, and restores it to <key>.
    seedKey(expiredIso, expiredIso, 'old-copy');
    const prunerB = new ComponentManager({
      rootDir, toolsDir, platformKey: 'darwin-arm64', now: () => nowMs,
      externalLookup: () => undefined, envOverride: () => undefined,
    });
    let paused = false;
    const prunerA = new ComponentManager({
      rootDir, toolsDir, platformKey: 'darwin-arm64', now: () => nowMs,
      externalLookup: () => undefined, envOverride: () => undefined,
      onBeforePruneTrash: (_id, key) => {
        paused = true;
        assert.equal(key, targetKey);
        assert.deepEqual(prunerB.prune('axe').removedKeys, [`axe/${targetKey}`]);
        // C reinstalls fresh copy of the same key
        seedKey(nowIso, nowIso, 'fresh-C');
      },
    });
    const resA = prunerA.prune('axe');
    assert.equal(paused, true);
    assert.deepEqual(resA.removedKeys, []);
    assert.ok(existsSync(join(keyDir, '.ready.json')), 'C fresh copy must be restored to <key>');
    assert.equal(execFileSync(join(keyDir, 'axe'), [], { encoding: 'utf8' }).trim(), 'fresh-C');
    assert.deepEqual(readdirSync(join(rootDir, 'axe')), [targetKey]);

    // Part B: Same interleaving, plus D already placed a copy back at <key> before A restores ->
    // A sees ENOTEMPTY/EEXIST on restore and deletes its duplicate .trash-* cleanly while keeping D's copy.
    rmSync(keyDir, { recursive: true, force: true });
    seedKey(expiredIso, expiredIso, 'old-copy-2');
    const prunerA2 = new ComponentManager({
      rootDir, toolsDir, platformKey: 'darwin-arm64', now: () => nowMs,
      externalLookup: () => undefined, envOverride: () => undefined,
      onBeforePruneTrash: () => {
        assert.deepEqual(prunerB.prune('axe').removedKeys, [`axe/${targetKey}`]);
        seedKey(nowIso, nowIso, 'fresh-C2');
      },
      onBeforePruneRestore: () => {
        // D places a fresh copy at <key> while A holds C2 in .trash-*
        seedKey(nowIso, nowIso, 'fresh-D');
      },
    });
    const resA2 = prunerA2.prune('axe');
    assert.deepEqual(resA2.removedKeys, []);
    assert.equal(execFileSync(join(keyDir, 'axe'), [], { encoding: 'utf8' }).trim(), 'fresh-D');
    assert.deepEqual(readdirSync(join(rootDir, 'axe')), [targetKey]);

    // Part C: Concurrent touchUsed updating .last-used (with old activatedAt) also causes post-trash re-check to restore.
    rmSync(keyDir, { recursive: true, force: true });
    seedKey(expiredIso, expiredIso, 'touched-copy');
    const prunerA3 = new ComponentManager({
      rootDir, toolsDir, platformKey: 'darwin-arm64', now: () => nowMs,
      externalLookup: () => undefined, envOverride: () => undefined,
      onBeforePruneTrash: () => {
        writeFileSync(join(keyDir, '.last-used'), nowIso + '\n');
      },
    });
    assert.deepEqual(prunerA3.prune('axe').removedKeys, []);
    assert.equal(execFileSync(join(keyDir, 'axe'), [], { encoding: 'utf8' }).trim(), 'touched-copy');
    assert.deepEqual(readdirSync(join(rootDir, 'axe')), [targetKey]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('Round 4 #3 (P2): startup cleanup deletes stage-<pid>-* only when PID is dead AND older than 24 h', () => {
  const work = makeTempDir('pd-comp-r4-stagepid-');
  try {
    const toolsDir = join(work, 'tools');
    const rootDir = join(work, 'components');
    writeTestTools(toolsDir, { url: 'https://github.com/cameroncooke/AXe/releases/download/v1.8.0/a.tar.gz', sha256: 'c'.repeat(64), size: 100, version: '1.8.0' });

    const nowMs = Date.parse('2026-11-24T00:00:00Z');
    const twoDaysAgo = new Date(nowMs - 48 * 3_600_000);
    const twoHoursAgo = new Date(nowMs - 2 * 3_600_000);

    const axeDir = join(rootDir, 'axe');
    const liveOldStage = join(axeDir, 'stage-11111-liveold');
    const deadFreshStage = join(axeDir, 'stage-22222-deadfresh');
    const deadOldStage = join(axeDir, 'stage-33333-deadold');
    const liveTrash = join(axeDir, '.trash-11111-live');
    const deadTrash = join(axeDir, '.trash-33333-dead');
    for (const d of [liveOldStage, deadFreshStage, deadOldStage, liveTrash, deadTrash]) {
      mkdirSync(d, { recursive: true });
    }
    utimesSync(liveOldStage, twoDaysAgo, twoDaysAgo);
    utimesSync(deadFreshStage, twoHoursAgo, twoHoursAgo);
    utimesSync(deadOldStage, twoDaysAgo, twoDaysAgo);

    const mgr = new ComponentManager({
      rootDir, toolsDir, platformKey: 'darwin-arm64', now: () => nowMs,
      pidAlive: (pid) => pid === 11111,
      externalLookup: () => undefined, envOverride: () => undefined,
    });

    const gc = mgr.prune('axe');
    assert.deepEqual(gc.removedStaging, ['axe/stage-33333-deadold']);
    assert.deepEqual(gc.removedTrash, ['axe/.trash-33333-dead']);
    // Suspended live installer (>24h) and dead-PID (<24h) MUST be preserved
    assert.equal(existsSync(liveOldStage), true);
    assert.equal(existsSync(deadFreshStage), true);
    assert.equal(existsSync(liveTrash), true);
    // Dead-PID (>24h) stage and dead-PID trash MUST be removed
    assert.equal(existsSync(deadOldStage), false);
    assert.equal(existsSync(deadTrash), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('Round 5: activation garbage recovery restores and adopts a concurrent ready winner instead of trashing it', async () => {
  const work = makeTempDir('pd-comp-r5-garbage-race-');
  try {
    const tar = makeFakeAxeTarGz(work, '1.8.0');
    await withServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(tar.buf.length) });
      res.end(tar.buf);
    }, async (base) => {
      const toolsDir = join(work, 'tools');
      const rootDir = join(work, 'components');
      const m = writeTestTools(toolsDir, { url: `${base}/axe.tar.gz`, sha256: tar.sha256, size: tar.buf.length, version: '1.8.0' });
      const key = componentKey(m.components.axe, m.components.axe.artifacts[0]);
      const finalDir = join(rootDir, 'axe', key);

      // Part A: Exact A/B schedule — garbage exists at <key>; A sees no .ready.json and pauses;
      // B clears garbage and activates B's ready key; A renames B's ready key to .trash-*, sees .ready.json inside,
      // renames B's ready key back to <key>, and adopts B instead of overwriting with A's payload.
      mkdirSync(finalDir, { recursive: true });
      writeFileSync(join(finalDir, '.last-used'), '2026-09-01T00:00:00Z\n');

      const mgrB = new ComponentManager({
        rootDir, toolsDir, platformKey: 'darwin-arm64', allowLocalhost: true,
        externalLookup: () => undefined, envOverride: () => undefined,
      });

      let bActivated = false;
      const mgrA = new ComponentManager({
        rootDir, toolsDir, platformKey: 'darwin-arm64', allowLocalhost: true,
        externalLookup: () => undefined, envOverride: () => undefined,
        onBeforeGarbageTrash: async (_id, k) => {
          assert.equal(k, key);
          const stB = await mgrB.install('axe');
          assert.equal(stB.state, 'ready');
          // Mark B's activated dir with a sentinel file so we can prove B's exact copy was restored & adopted
          writeFileSync(join(finalDir, '.winner-sentinel'), 'B-won\n');
          bActivated = true;
        },
      });

      const stA = await mgrA.install('axe');
      assert.equal(bActivated, true);
      assert.equal(stA.state, 'ready');
      assert.ok(existsSync(join(finalDir, '.ready.json')));
      assert.equal(readFileSync(join(finalDir, '.winner-sentinel'), 'utf8').trim(), 'B-won', 'A must restore and adopt B winner');
      assert.deepEqual(readdirSync(join(rootDir, 'axe')), [key]);

      // Part B: Same A/B schedule, PLUS C places a ready copy at <key> before A restores B's trashed copy ->
      // A gets ENOTEMPTY/EEXIST on restore, deletes trashed B, and adopts C at <key>.
      rmSync(finalDir, { recursive: true, force: true });
      mkdirSync(finalDir, { recursive: true });
      writeFileSync(join(finalDir, '.last-used'), '2026-09-01T00:00:00Z\n');

      const mgrC = new ComponentManager({
        rootDir, toolsDir, platformKey: 'darwin-arm64', allowLocalhost: true,
        externalLookup: () => undefined, envOverride: () => undefined,
      });
      const mgrA2 = new ComponentManager({
        rootDir, toolsDir, platformKey: 'darwin-arm64', allowLocalhost: true,
        externalLookup: () => undefined, envOverride: () => undefined,
        onBeforeGarbageTrash: async () => {
          await mgrB.install('axe');
          writeFileSync(join(finalDir, '.winner-sentinel'), 'B2-won\n');
        },
        onBeforeGarbageRestore: async () => {
          // C activates at <key> while A2 holds B2 in .trash-*
          await mgrC.install('axe');
          writeFileSync(join(finalDir, '.winner-sentinel'), 'C-won\n');
        },
      });

      const stA2 = await mgrA2.install('axe');
      assert.equal(stA2.state, 'ready');
      assert.equal(readFileSync(join(finalDir, '.winner-sentinel'), 'utf8').trim(), 'C-won', 'A2 must discard duplicate trash and adopt C');
      assert.deepEqual(readdirSync(join(rootDir, 'axe')), [key]);
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ── wda: a pinned source archive PhoneDock builds (never a clone of upstream HEAD) ──

function makeFakeWdaTarGz(workDir: string, version: string, opts: { license?: boolean; extraTop?: string } = {}): { buf: Buffer; sha256: string } {
  const src = join(workDir, `wda-src-${Math.random().toString(36).slice(2, 8)}`);
  const top = join(src, `WebDriverAgent-${version}`);
  mkdirSync(join(top, 'WebDriverAgent.xcodeproj'), { recursive: true });
  writeFileSync(join(top, 'WebDriverAgent.xcodeproj', 'project.pbxproj'), '// fake project\n');
  if (opts.license !== false) writeFileSync(join(top, 'LICENSE'), 'BSD License\n');
  if (opts.extraTop) mkdirSync(join(src, opts.extraTop), { recursive: true });
  const tarPath = join(workDir, `wda-${Math.random().toString(36).slice(2, 8)}.tar.gz`);
  execFileSync('/usr/bin/tar', ['-czf', tarPath, '-C', src, '.']);
  const buf = readFileSync(tarPath);
  return { buf, sha256: sha256Hex(buf) };
}

test('wda installs a pinned source archive: checksum-verified, one top directory with the project and licence, no external copy', async () => {
  const work = makeTempDir('pd-comp-wda-');
  try {
    const good = makeFakeWdaTarGz(work, '16.15.3');
    const noLicense = makeFakeWdaTarGz(work, '16.15.3', { license: false });
    const twoTops = makeFakeWdaTarGz(work, '16.15.3', { extraTop: 'other' });
    const served = new Map<string, Buffer>([['/good.tar.gz', good.buf], ['/nolicense.tar.gz', noLicense.buf], ['/twotops.tar.gz', twoTops.buf]]);
    await withServer((req, res) => {
      const buf = served.get(req.url ?? '');
      if (!buf) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Length': String(buf.length) });
      res.end(buf);
    }, async (base) => {
      const axe = { url: 'https://github.com/cameroncooke/AXe/releases/download/v1.8.0/a.tar.gz', sha256: 'c'.repeat(64), size: 100, version: '1.8.0' };
      const setup = (name: string, wda: { url: string; sha256: string; size: number }) => {
        const toolsDir = join(work, `t-${name}`);
        const rootDir = join(work, `c-${name}`);
        writeTestTools(toolsDir, axe, '11.63.1', { ...wda, version: '16.15.3' });
        // Default externalLookup: nothing on disk (a stray checkout, the old HEAD clone) ever counts as wda.
        const mgr = new ComponentManager({ rootDir, toolsDir, platformKey: 'darwin-arm64', allowLocalhost: true, envOverride: () => undefined });
        return { mgr, rootDir };
      };

      const { mgr, rootDir } = setup('good', { url: `${base}/good.tar.gz`, sha256: good.sha256, size: good.buf.length });
      assert.equal(mgr.status('wda').state, 'missing');
      assert.equal(mgr.status('wda').source, 'none');
      const st = await mgr.install('wda');
      assert.equal(st.state, 'ready');
      assert.equal(st.installedVersion, '16.15.3');
      const src = resolveWdaSource(mgr);
      assert.ok(src && src.source === 'managed');
      assert.match(src.path, /WebDriverAgent-16\.15\.3$/);
      assert.ok(existsSync(join(src.path, 'WebDriverAgent.xcodeproj', 'project.pbxproj')));
      assert.ok(existsSync(join(src.path, 'LICENSE')));
      assert.equal(mgr.isCurrent('wda'), true);

      // Same size, wrong bytes: rejected by sha256, nothing activated.
      const flipped = Buffer.from(good.buf); flipped[flipped.length - 5] ^= 0xff;
      served.set('/flipped.tar.gz', flipped);
      const bad = setup('flipped', { url: `${base}/flipped.tar.gz`, sha256: good.sha256, size: good.buf.length });
      await assert.rejects(() => bad.mgr.install('wda'), (e: any) => e.code === 'checksum_mismatch');
      assert.equal(bad.mgr.resolveManaged('wda'), undefined);
      assert.deepEqual(readdirSync(join(bad.rootDir, 'wda')).filter((n) => !n.startsWith('.')), []);

      const nl = setup('nolicense', { url: `${base}/nolicense.tar.gz`, sha256: noLicense.sha256, size: noLicense.buf.length });
      await assert.rejects(() => nl.mgr.install('wda'), (e: any) => e.code === 'self_check_failed' && /LICENSE/.test(e.detail));
      const tt = setup('twotops', { url: `${base}/twotops.tar.gz`, sha256: twoTops.sha256, size: twoTops.buf.length });
      await assert.rejects(() => tt.mgr.install('wda'), (e: any) => e.code === 'self_check_failed');
      assert.ok(existsSync(rootDir));
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('PHONEDOCK_WDA_SOURCE overrides wda only with a WebDriverAgent folder, and blocks auto-install either way', () => {
  const work = makeTempDir('pd-comp-wda-ovr-');
  try {
    const toolsDir = join(work, 'tools');
    writeTestTools(toolsDir, { url: 'https://github.com/cameroncooke/AXe/releases/download/v1.8.0/a.tar.gz', sha256: 'c'.repeat(64), size: 100, version: '1.8.0' });
    const checkout = join(work, 'checkout');
    mkdirSync(join(checkout, 'WebDriverAgent.xcodeproj'), { recursive: true });
    writeFileSync(join(checkout, 'WebDriverAgent.xcodeproj', 'project.pbxproj'), '');
    writeFileSync(join(checkout, 'LICENSE'), 'BSD License\n');
    let override: string | undefined = checkout;
    const mgr = new ComponentManager({ rootDir: join(work, 'c'), toolsDir, platformKey: 'darwin-arm64', envOverride: (id) => (id === 'wda' ? override : undefined) });
    assert.deepEqual(resolveWdaSource(mgr), { path: checkout, version: undefined, source: 'override' });
    assert.equal(mgr.status('wda').state, 'ready');
    assert.equal(mgr.triggerAuto('wda'), false);
    override = join(work, 'empty');
    mkdirSync(override);
    const st = mgr.status('wda');
    assert.equal(st.state, 'failed');
    assert.equal(st.error?.code, 'invalid_override');
    assert.match(st.error?.message ?? '', /PHONEDOCK_WDA_SOURCE/);
    assert.equal(resolveWdaSource(mgr), undefined);
    assert.equal(mgr.triggerAuto('wda'), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('manifest validation: a source archive needs sourceDir and safe requiredFiles, and its licence must ship in tools/', () => {
  const dir = makeTempDir('pd-comp-wda-val-');
  try {
    const m = writeTestTools(dir, { url: 'https://github.com/cameroncooke/AXe/releases/download/v1.8.0/a.tar.gz', sha256: 'c'.repeat(64), size: 100, version: '1.8.0' });
    assert.doesNotThrow(() => validateManifest(m, dir));
    const clone = () => JSON.parse(JSON.stringify(m)) as ComponentManifest;
    const noDir = clone(); delete noDir.components.wda.verify.sourceDir;
    assert.throws(() => validateManifest(noDir, dir), /sourceDir/);
    const escape = clone(); escape.components.wda.verify.requiredFiles = ['../../etc/passwd'];
    assert.throws(() => validateManifest(escape, dir), /requiredFiles/);
    const noLicence = clone(); noLicence.components.wda.licenseFile = 'licenses/missing';
    assert.throws(() => validateManifest(noLicence, dir), /Licence notice missing/);
    const codeload = clone(); codeload.components.wda.artifacts[0].url = 'https://codeload.github.com/appium/WebDriverAgent/tar.gz/refs/tags/v16.15.3';
    assert.throws(() => validateManifest(codeload, dir), /not allowed/);   // not in this fixture's allowlist
    // An older manifest without wda is fine (#10); a wda entry that is there must be well formed.
    const missing = clone(); delete (missing.components as Record<string, unknown>).wda;
    assert.doesNotThrow(() => validateManifest(missing, dir));
    const wrongId = clone(); (wrongId.components.wda as { id: string }).id = 'axe';
    assert.throws(() => validateManifest(wrongId, dir), /Missing component "wda"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#10: main’s manifest (no "wda") still loads; WebDriverAgent is reported unavailable only when asked for', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync: mk, mkdirSync: mkd, writeFileSync: wf, rmSync: rm } = await import('node:fs');
  const { tmpdir: td } = await import('node:os');
  const { join: j } = await import('node:path');
  const dir = mk(j(td(), 'pd-main-manifest-'));
  try {
    const show = (path: string) => execFileSync('git', ['show', `origin/main:${path}`], { encoding: 'utf8' });
    const manifest = JSON.parse(show('tools/components.json'));
    assert.equal(manifest.components.wda, undefined, 'main’s manifest has no wda');
    wf(j(dir, 'components.json'), JSON.stringify(manifest));
    for (const c of Object.values(manifest.components) as { licenseFile?: string; lockFile?: string }[]) {
      for (const f of [c.licenseFile, c.lockFile]) if (f) { mkd(j(dir, f, '..'), { recursive: true }); wf(j(dir, f), show(`tools/${f}`)); }
    }
    const { manifest: loaded } = loadManifest(dir);
    assert.deepEqual(Object.keys(loaded.components).sort(), ['axe', 'ios-tools']);
    const mgr = new ComponentManager({ rootDir: j(dir, 'root'), toolsDir: dir, platformKey: 'darwin-arm64', externalLookup: () => undefined, envOverride: () => undefined });
    assert.deepEqual(mgr.listStatuses().map((x) => x.id).sort(), ['axe', 'ios-tools']);
    assert.throws(() => mgr.status('wda'), (e: { code?: string }) => e.code === 'component_unavailable');
  } finally { rm(dir, { recursive: true, force: true }); }
});

