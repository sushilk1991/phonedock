import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Device } from '../core/types.ts';
import { ProxyManager } from './proxies.ts';

function makeDevice(over: Partial<Device> = {}): Device {
  return {
    id: 'android-emulator:pdtest-px',
    backend: 'android-emulator',
    nativeId: 'pdtest-px',
    name: 'pdtest-px',
    platform: 'android',
    kind: 'virtual',
    state: 'running',
    managed: true,
    capabilities: [],
    meta: { serial: 'emulator-5554' },
    ...over,
  };
}

test('ProxyManager saves with mode 0600, redacts passwords, attaches/detaches Android via adb, and shares forwarders', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-proxy-test-'));
  const storePath = join(dir, 'proxies.json');
  const adbCalls: { serial: string; args: string[] }[] = [];
  let nextPort = 41000;
  const closedPorts: number[] = [];

  const makeManager = (devices: Device[]) => new ProxyManager({
    storeFile: () => storePath,
    runAdb: async (serial, args) => {
      adbCalls.push({ serial, args });
      return { stdout: '', stderr: '', code: 0 };
    },
    startForwarder: async () => {
      const port = nextPort++;
      return { port, close: async () => { closedPorts.push(port); } };
    },
    testFn: async () => ({ ok: true, ip: '198.51.100.10', country: 'US', city: 'Boston', latencyMs: 42, at: '2026-11-26T00:00:00.000Z' }),
    getDevices: async () => devices,
  });

  try {
    const dev1 = makeDevice();
    const dev2 = makeDevice({ id: 'android-device:ABC123', backend: 'android-device', nativeId: 'ABC123', name: 'Pixel', kind: 'physical', meta: { serial: 'ABC123' } });
    const mgr = makeManager([dev1, dev2]);

    // Save proxy with secret password
    const saved = await mgr.add({ name: 'Boston US', url: 'socks5h://bob:superSecret99@proxy.test:1080', test: true });
    assert.equal(saved.name, 'Boston US');
    assert.equal(saved.hasAuth, true);
    assert.equal(saved.url, 'socks5h://bob:***@proxy.test:1080');
    assert.equal(saved.lastTest?.city, 'Boston');
    assert.equal('password' in saved, false);

    // Check file mode 0600 on disk
    const mode = statSync(storePath).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.ok(readFileSync(storePath, 'utf8').includes('superSecret99'));

    // Attach to dev1 -> starts forwarder 41000, runs adb reverse + settings put global http_proxy
    const st1 = await mgr.attach(dev1, saved.id, 'cli:test');
    assert.equal(st1.supported, true);
    assert.equal(st1.applied, true);
    assert.equal(st1.localPort, 41000);
    assert.deepEqual(adbCalls, [
      { serial: 'emulator-5554', args: ['reverse', 'tcp:41000', 'tcp:41000'] },
      { serial: 'emulator-5554', args: ['shell', 'settings', 'put', 'global', 'http_proxy', '127.0.0.1:41000'] },
    ]);

    // Attach same proxy to dev2 -> shares the SAME forwarder (port 41000), does not start a second one
    adbCalls.length = 0;
    const st2 = await mgr.attach(dev2, saved.id, 'cli:test');
    assert.equal(st2.applied, true);
    assert.equal(st2.localPort, 41000);
    assert.equal(nextPort, 41001);
    assert.deepEqual(adbCalls, [
      { serial: 'ABC123', args: ['reverse', 'tcp:41000', 'tcp:41000'] },
      { serial: 'ABC123', args: ['shell', 'settings', 'put', 'global', 'http_proxy', '127.0.0.1:41000'] },
    ]);

    // Detach dev1 -> clears proxy on dev1, forwarder stays alive for dev2
    adbCalls.length = 0;
    const d1After = await mgr.detach(dev1, 'cli:test');
    assert.equal(d1After.proxyId, null);
    assert.equal(d1After.applied, false);
    assert.deepEqual(adbCalls, [
      { serial: 'emulator-5554', args: ['shell', 'settings', 'put', 'global', 'http_proxy', ':0'] },
      { serial: 'emulator-5554', args: ['reverse', '--remove', 'tcp:41000'] },
    ]);
    assert.equal(closedPorts.length, 0);

    // Persistence across daemon restart: a fresh manager sees dev2's attachment and reconciles it
    adbCalls.length = 0;
    const mgr2 = makeManager([dev1, dev2]);
    assert.equal(mgr2.list().length, 1);
    assert.equal('password' in mgr2.list()[0], false);
    await mgr2.reconcileAll([dev1, dev2]);
    assert.deepEqual(adbCalls, [
      { serial: 'ABC123', args: ['reverse', 'tcp:41001', 'tcp:41001'] },
      { serial: 'ABC123', args: ['shell', 'settings', 'put', 'global', 'http_proxy', '127.0.0.1:41001'] },
    ]);

    // Detach dev2 -> forwarder closes when last device leaves
    await mgr2.detach(dev2, 'cli:test');
    assert.deepEqual(closedPorts as number[], [41001]);

    // Stopped device saves attachment and applies once it boots
    adbCalls.length = 0;
    const stoppedDev = makeDevice({ state: 'stopped', meta: {} });
    const stStopped = await mgr2.attach(stoppedDev, saved.id, 'cli:test');
    assert.equal(stStopped.proxyId, saved.id);
    assert.equal(stStopped.applied, false);
    assert.match(stStopped.note ?? '', /boot/i);
    assert.equal(adbCalls.length, 0);

    await mgr2.reapplyDevice(dev1);
    assert.equal(mgr2.getDeviceState(dev1).applied, true);
    assert.equal(adbCalls.length, 2);

    // Deleting a proxy detaches its device and closes the forwarder
    adbCalls.length = 0;
    const removed = await mgr2.remove(saved.id, 'cli:test');
    assert.deepEqual(removed.detachedDevices, [dev1.id]);
    assert.equal(mgr2.list().length, 0);
    assert.ok(closedPorts.includes(41002));
    await mgr.closeAll();
    await mgr2.closeAll();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ProxyManager returns 501 not_supported for iOS simulator and real iPhone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-proxy-ios-'));
  const mgr = new ProxyManager({ storeFile: () => join(dir, 'proxies.json') });
  try {
    const saved = await mgr.add({ name: 'Test', url: 'http://127.0.0.1:8080' });
    const sim = makeDevice({ id: 'ios-simulator:SIM1', backend: 'ios-simulator', nativeId: 'SIM1', platform: 'ios', meta: {} });
    const iphone = makeDevice({ id: 'ios-device:UDID1', backend: 'ios-device', nativeId: 'UDID1', platform: 'ios', kind: 'physical', meta: {} });

    const simState = mgr.getDeviceState(sim);
    assert.equal(simState.supported, false);
    assert.match(simState.reason ?? '', /Mac.*network/i);

    const phoneState = mgr.getDeviceState(iphone);
    assert.equal(phoneState.supported, false);
    assert.match(phoneState.reason ?? '', /Wi-Fi/i);

    await assert.rejects(() => mgr.attach(sim, saved.id), (e: any) => e.code === 'not_supported' && e.status === 501);
    await assert.rejects(() => mgr.attach(iphone, saved.id), (e: any) => e.code === 'not_supported' && e.status === 501);
    await assert.rejects(() => mgr.detach(sim), (e: any) => e.code === 'not_supported' && e.status === 501);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
