// Regression tests for ios-device terminateApp:
// - WDA returning value:false (or true) while the pid survives must escalate to `devicectl ... --kill`
// - devicectl SIGTERM leaving the pid alive (e.g. TikTok on iOS 18) must escalate to `--kill`
// - a process that survives even `--kill` must fail with terminate_failed (never report success)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { backend } from './ios-device.ts';
import { fakeDevicectl } from './fake-devicectl.ts';
import { PhoneDockError } from '../core/types.ts';

const UDID = '00008020-001D381C3408002E';
const TIKTOK = 'com.zhiliaoapp.musically';
const TIKTOK_URL = 'file:///private/var/containers/Bundle/Application/AAA/TikTok.app/';

test('ios-device terminateApp (devicectl): escalates to --kill when SIGTERM leaves pid running', async () => {
  const prevWda = process.env.PHONEDOCK_WDA_URL;
  delete process.env.PHONEDOCK_WDA_URL;
  const fake = fakeDevicectl({
    phones: [{ udid: UDID, coreDeviceId: 'cd-1', tunnelIp: 'fd00::1', osVersion: '18.7.12' }],
    runners: {},
    apps: {
      [UDID]: [{ bundleIdentifier: TIKTOK, url: TIKTOK_URL, executable: `${TIKTOK_URL}TikTok`, pids: [4242], ignoresSigterm: true }],
    },
  });
  try {
    await backend.terminateApp!(UDID, TIKTOK);
    const termCalls = fake.calls().filter((l) => l.includes('process terminate'));
    assert.equal(termCalls.some((l) => l.includes('--pid 4242') && !l.includes('--kill')), true, 'should try SIGTERM first');
    assert.equal(termCalls.some((l) => l.includes('--pid 4242') && l.includes('--kill')), true, 'should escalate to --kill');
  } finally {
    fake.restore();
    if (prevWda !== undefined) process.env.PHONEDOCK_WDA_URL = prevWda;
  }
});

test('ios-device terminateApp (WDA): re-checks process list when WDA returns value:false and escalates to --kill', async () => {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/session') res.end(JSON.stringify({ value: { sessionId: 'sess-term' } }));
      else if (req.url?.endsWith('/wda/apps/terminate')) res.end(JSON.stringify({ value: false }));
      else res.end(JSON.stringify({ value: null }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const prevWda = process.env.PHONEDOCK_WDA_URL;
  process.env.PHONEDOCK_WDA_URL = `http://127.0.0.1:${port}`;
  const fake = fakeDevicectl({
    phones: [{ udid: UDID, coreDeviceId: 'cd-1', tunnelIp: 'fd00::1', osVersion: '18.7.12' }],
    runners: {},
    apps: {
      [UDID]: [{ bundleIdentifier: TIKTOK, url: TIKTOK_URL, executable: `${TIKTOK_URL}TikTok`, pids: [5150], ignoresSigterm: true }],
    },
  });
  try {
    await backend.terminateApp!(UDID, TIKTOK);
    const killCalls = fake.calls().filter((l) => l.includes('process terminate') && l.includes('--pid 5150') && l.includes('--kill'));
    assert.equal(killCalls.length, 1, 'must escalate to devicectl --kill when pid survives WDA terminate');
  } finally {
    fake.restore();
    if (prevWda === undefined) delete process.env.PHONEDOCK_WDA_URL; else process.env.PHONEDOCK_WDA_URL = prevWda;
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('ios-device terminateApp fails with terminate_failed when the process survives --kill', async () => {
  const prevWda = process.env.PHONEDOCK_WDA_URL;
  delete process.env.PHONEDOCK_WDA_URL;
  const fake = fakeDevicectl({
    phones: [{ udid: UDID, coreDeviceId: 'cd-1', tunnelIp: 'fd00::1', osVersion: '18.7.12' }],
    runners: {},
    apps: {
      [UDID]: [{
        bundleIdentifier: TIKTOK,
        url: TIKTOK_URL,
        executable: `${TIKTOK_URL}TikTok`,
        pids: [9001],
        ignoresSigterm: true,
        ignoresSigkill: true,
      }],
    },
  });
  try {
    await assert.rejects(
      () => backend.terminateApp!(UDID, TIKTOK),
      (e: unknown) => e instanceof PhoneDockError && e.code === 'terminate_failed' && e.status === 502 && String(e.detail).includes('9001'),
    );
  } finally {
    fake.restore();
    if (prevWda !== undefined) process.env.PHONEDOCK_WDA_URL = prevWda;
  }
});
