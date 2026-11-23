// Regression tests for ios-device launchApp: devicectl flag placement before `--` and WDA terminate-before-launch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { backend, buildDevicectlArgs, buildDevicectlLaunchArgs } from './ios-device.ts';

test('ios-device devicectl launch: --json-output and --quiet always precede `--` separator', () => {
  const withArgs = buildDevicectlArgs(
    buildDevicectlLaunchArgs('UDID-123', 'com.example.app', { args: ['-UITesting', '1'] }),
    '/tmp/out.json',
  );
  assert.deepEqual(withArgs, [
    'devicectl', 'device', 'process', 'launch', '--device', 'UDID-123', '--terminate-existing',
    '--json-output', '/tmp/out.json', '--quiet',
    '--', 'com.example.app', '-UITesting', '1',
  ]);
  const sepIdx = withArgs.indexOf('--');
  assert.ok(sepIdx > withArgs.indexOf('--json-output'), '--json-output must come before --');
  assert.ok(sepIdx > withArgs.indexOf('--quiet'), '--quiet must come before --');

  const envOnly = buildDevicectlArgs(
    buildDevicectlLaunchArgs('UDID-123', 'com.example.app', { env: { API_TOKEN: 'secret' } }),
    '/tmp/out.json',
  );
  assert.deepEqual(envOnly, [
    'devicectl', 'device', 'process', 'launch', '--device', 'UDID-123', '--terminate-existing',
    'com.example.app', '--json-output', '/tmp/out.json', '--quiet',
  ]);

  const plain = buildDevicectlArgs(
    buildDevicectlLaunchArgs('UDID-123', 'com.example.app'),
    '/tmp/out.json',
  );
  assert.deepEqual(plain, [
    'devicectl', 'device', 'process', 'launch', '--device', 'UDID-123',
    'com.example.app', '--json-output', '/tmp/out.json', '--quiet',
  ]);
});

test('ios-device WDA launch: terminates running app before launching when args or env are passed, skips terminate on plain launch', async () => {
  const requests: { method: string; url: string; body: unknown }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method ?? '', url: req.url ?? '', body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/session') {
        res.end(JSON.stringify({ value: { sessionId: 'sess-1' } }));
      } else {
        res.end(JSON.stringify({ value: null }));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const prevWda = process.env.PHONEDOCK_WDA_URL;
  process.env.PHONEDOCK_WDA_URL = `http://127.0.0.1:${port}`;
  try {
    // Launch with args & env: must terminate first, then launch with arguments & environment
    await backend.launchApp!('udid-wda-test', 'com.example.app', {
      args: ['-UITesting', '1'],
      env: { API_TOKEN: 'sec-123' },
    });
    const appCalls1 = requests.filter((r) => r.url.includes('/wda/apps/'));
    assert.deepEqual(appCalls1, [
      { method: 'POST', url: '/session/sess-1/wda/apps/terminate', body: { bundleId: 'com.example.app' } },
      {
        method: 'POST',
        url: '/session/sess-1/wda/apps/launch',
        body: { bundleId: 'com.example.app', arguments: ['-UITesting', '1'], environment: { API_TOKEN: 'sec-123' } },
      },
    ]);

    // Launch with env only: must also terminate first
    requests.length = 0;
    await backend.launchApp!('udid-wda-test', 'com.example.app', { env: { MODE: 'staging' } });
    const appCalls2 = requests.filter((r) => r.url.includes('/wda/apps/'));
    assert.deepEqual(appCalls2, [
      { method: 'POST', url: '/session/sess-1/wda/apps/terminate', body: { bundleId: 'com.example.app' } },
      { method: 'POST', url: '/session/sess-1/wda/apps/launch', body: { bundleId: 'com.example.app', environment: { MODE: 'staging' } } },
    ]);

    // Plain launch without options: must NOT terminate first
    requests.length = 0;
    await backend.launchApp!('udid-wda-test', 'com.example.app');
    const appCalls3 = requests.filter((r) => r.url.includes('/wda/apps/'));
    assert.deepEqual(appCalls3, [
      { method: 'POST', url: '/session/sess-1/wda/apps/launch', body: { bundleId: 'com.example.app' } },
    ]);
  } finally {
    if (prevWda === undefined) delete process.env.PHONEDOCK_WDA_URL;
    else process.env.PHONEDOCK_WDA_URL = prevWda;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
