// Exercise the actual source launcher: warming its cache must not alter help, command dispatch, or failures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('source launcher: cold, warm, disabled and unavailable compile caches preserve CLI behavior', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdtest-cli-startup-'));
  const env = { ...process.env, PHONEDOCK_PORT: '47433', PHONEDOCK_HOME: join(dir, 'home'), PHONEDOCK_DEVICE_FILTER: 'pdtest-', PHONEDOCK_NODE: process.execPath };
  const cli = (args: string[], extra: Record<string, string> = {}) => spawnSync(resolve('bin/phonedock'), args, { env: { ...env, ...extra }, encoding: 'utf8', timeout: 20_000 });
  try {
    const cache = { NODE_COMPILE_CACHE: join(dir, 'cache') };
    const cold = cli(['help'], cache), warm = cli(['help'], cache);
    assert.equal(cold.status, 0, cold.stderr); assert.equal(warm.status, 0, warm.stderr);
    assert.equal(warm.stdout, cold.stdout);
    assert.match(warm.stdout, /flow check/); assert.match(warm.stdout, /trace start/);
    const forced = cli(['help'], { ...cache, PHONEDOCK_CLI_MAIN: '1' });
    assert.equal(forced.status, 0, forced.stderr); assert.equal(forced.stdout, cold.stdout);
    // Setting NODE_COMPILE_CACHE before Node starts also enables it automatically. Set it *inside* the probe,
    // so this proves that importing the bootstrap enables caching, rather than just testing Node's env support.
    const probeEnv: NodeJS.ProcessEnv = { ...env }; delete probeEnv.NODE_COMPILE_CACHE; delete probeEnv.NODE_DISABLE_COMPILE_CACHE;
    const probeCache = join(dir, 'probe-cache');
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { getCompileCacheDir } from 'node:module';
      import { pathToFileURL } from 'node:url';
      assert.equal(getCompileCacheDir(), undefined);
      process.env.NODE_COMPILE_CACHE = ${JSON.stringify(probeCache)};
      process.argv = [process.execPath, ${JSON.stringify(resolve('bin/phonedock.mjs'))}, 'help'];
      await import(pathToFileURL(process.argv[1]).href);
      assert.ok(getCompileCacheDir());
    `], { env: probeEnv, encoding: 'utf8', timeout: 20_000 });
    assert.equal(probe.status, 0, probe.stderr); assert.equal(probe.stdout, cold.stdout);
    assert.ok(readdirSync(probeCache).length > 0, 'the bootstrap wrote compile-cache data');
    const disabled = cli(['help'], { ...cache, NODE_DISABLE_COMPILE_CACHE: '1' });
    assert.equal(disabled.status, 0, disabled.stderr); assert.equal(disabled.stdout, cold.stdout);
    const file = join(dir, 'not-a-directory'); writeFileSync(file, 'cache unavailable');
    const unavailable = cli(['help'], { NODE_COMPILE_CACHE: file });
    assert.equal(unavailable.status, 0, unavailable.stderr); assert.equal(unavailable.stdout, cold.stdout);
    const flow = join(dir, 'flow.yaml'); writeFileSync(flow, 'name: Startup\nsteps:\n  - wait: 1\n');
    for (const command of ['flow', 'flows']) {
      const r = cli([command, 'check', flow], cache);
      assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Startup/);
    }
    for (const command of ['trace', 'perf', 'test']) {
      const r = cli([command], cache);
      assert.equal(r.status, 2, r.stderr); assert.match(r.stderr, /Usage:|Missing argument/);
    }
    const unknown = cli(['pdtest-unknown-command'], cache);
    assert.equal(unknown.status, 2); assert.match(unknown.stderr, /Unknown command/i);
    const forcedUnknown = cli(['pdtest-unknown-command'], { ...cache, PHONEDOCK_CLI_MAIN: '1' });
    assert.equal(forcedUnknown.status, 2); assert.equal(forcedUnknown.stderr, unknown.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
