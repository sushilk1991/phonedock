// Route tests for GET /v1/components and POST /v1/components/:id/install (including idempotency).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComponentManager } from '../core/components.ts';
import { sha256Hex } from '../core/components-manifest.ts';
import { Raw, Router, type Ctx } from './http.ts';
import { componentHandlers } from './routes-components.ts';

test('component routes list status, return 404 on unknown id, and deduplicate concurrent installs', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pd-route-comp-'));
  const src = join(work, 'src');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'axe'), '#!/bin/sh\necho "1.8.0"\n');
  chmodSync(join(src, 'axe'), 0o755);
  const tarPath = join(work, 'axe.tar.gz');
  execFileSync('/usr/bin/tar', ['-czf', tarPath, '-C', src, '.']);
  const buf = readFileSync(tarPath);

  let releaseDownload!: () => void;
  const gate = new Promise<void>((r) => { releaseDownload = r; });

  const srv = createServer(async (_req, res) => {
    await gate;
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) });
    res.end(buf);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;

  try {
    const toolsDir = join(work, 'tools');
    mkdirSync(toolsDir, { recursive: true });
    const lockText = `pymobiledevice3==11.63.1 \\\n    --hash=sha256:${'a'.repeat(64)}\n`;
    writeFileSync(join(toolsDir, 'ios-tools.lock'), lockText);
    writeFileSync(join(toolsDir, 'components.json'), JSON.stringify({
      schemaVersion: 1,
      minAgeDays: 14,
      allowedHosts: ['github.com'],
      components: {
        'ios-tools': {
          id: 'ios-tools', displayName: 'iPhone Control', description: 'ios-tools', kind: 'python-venv',
          version: '11.63.1', publishedAt: '2026-10-01T00:00:00Z', pythonVersion: '3.12.16', pythonRelease: '20261026',
          lockFile: 'ios-tools.lock', lockSha256: sha256Hex(lockText), estimatedDiskBytes: 277_000_000,
          artifacts: [{ platforms: ['darwin-arm64'], filename: 'py.tar.gz', url: 'https://github.com/a/b/py.tar.gz', sha256: 'b'.repeat(64), size: 10 }],
          verify: { package: 'pymobiledevice3', version: '11.63.1', sidecars: [] },
        },
        axe: {
          id: 'axe', displayName: 'Simulator Control', description: 'axe', kind: 'binary-archive',
          version: '1.8.0', publishedAt: '2026-07-20T00:00:00Z', estimatedDiskBytes: 16_000_000,
          artifacts: [{ platforms: ['darwin-arm64', 'darwin-x64'], filename: 'axe.tar.gz', url: `http://127.0.0.1:${port}/axe.tar.gz`, sha256: sha256Hex(buf), size: buf.length }],
          verify: { binary: 'axe', versionArgs: ['--version'], expectedVersion: '1.8.0' },
        },
        wda: {
          id: 'wda', displayName: 'iPhone WebDriverAgent', description: 'wda', kind: 'source-archive',
          version: '16.15.3', publishedAt: '2026-10-16T00:00:00Z', estimatedDiskBytes: 5_000_000,
          artifacts: [{ platforms: ['darwin-arm64', 'darwin-x64'], filename: 'wda.tar.gz', url: `http://127.0.0.1:${port}/wda.tar.gz`, sha256: 'e'.repeat(64), size: 100 }],
          verify: { sourceDir: 'WebDriverAgent-16.15.3', requiredFiles: ['WebDriverAgent.xcodeproj/project.pbxproj'] },
        },
      },
    }));

    const mgr = new ComponentManager({
      rootDir: join(work, 'components'), toolsDir, platformKey: 'darwin-arm64', allowLocalhost: true,
      externalLookup: () => undefined, envOverride: () => undefined,
    });
    const h = componentHandlers(() => mgr);
    const router = new Router();
    router.get('/v1/components', h.list);
    router.post('/v1/components/:id/install', h.install);

    const listMatch = router.match('GET', '/v1/components');
    assert.ok(listMatch && listMatch !== 'method');
    const listed = await listMatch.h({ params: {}, q: () => undefined } as unknown as Ctx) as any[];
    assert.deepEqual(listed.map((x) => x.id), ['ios-tools', 'axe', 'wda']);
    assert.equal(listed.find((x) => x.id === 'axe')?.state, 'missing');
    assert.equal(listed.find((x) => x.id === 'wda')?.state, 'missing', 'no checkout on disk ever counts as the wda component');

    const badMatch = router.match('POST', '/v1/components/nope/install');
    assert.ok(badMatch && badMatch !== 'method');
    await assert.rejects(
      Promise.resolve(badMatch.h({ params: badMatch.params } as Ctx)),
      (e: any) => e.code === 'not_found' && e.status === 404,
    );

    const postMatch = router.match('POST', '/v1/components/axe/install');
    assert.ok(postMatch && postMatch !== 'method');
    const first = await postMatch.h({ params: postMatch.params } as Ctx);
    assert.ok(first instanceof Raw);
    assert.equal(first.status, 202);
    const body1 = JSON.parse(String(first.body));
    assert.ok(body1.job?.id);

    // Second POST while installing returns the exact same job (idempotent)
    const second = await postMatch.h({ params: postMatch.params } as Ctx);
    assert.ok(second instanceof Raw);
    const body2 = JSON.parse(String(second.body));
    assert.equal(body2.job.id, body1.job.id);

    releaseDownload();
    // Wait for install to settle
    await mgr.install('axe');
    assert.equal(mgr.status('axe').state, 'ready');
  } finally {
    releaseDownload();
    await new Promise<void>((r) => srv.close(() => r()));
    rmSync(work, { recursive: true, force: true });
  }
});
