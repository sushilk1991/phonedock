import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileSecretStore } from '../core/passcode-store.ts';
import { PhoneDockError, type Backend, type Device, type LockStateInfo, type UnlockResult } from '../core/types.ts';
import { inputRoute } from './delivery.ts';
import { classifyRequest } from './idle-sleep.ts';
import { PasscodeManager, passcodeSupportForDevice, setPasscodeManagerForTests } from './passcodes.ts';
import { router } from './routes.ts';
import './routes-passcode.ts';

function fakeDevice(overrides: Partial<Device> = {}): Device {
  return {
    id: 'android-device:SER1',
    backend: 'android-device',
    nativeId: 'SER1',
    name: 'Pixel 9',
    platform: 'android',
    kind: 'physical',
    state: 'running',
    managed: false,
    capabilities: ['screenshot', 'tap', 'swipe', 'type', 'key', 'unlock'],
    ...overrides,
  };
}

test('passcodeSupportForDevice distinguishes Android, iOS 27 native, iOS 18-26 WDA, and simulators', () => {
  assert.equal(passcodeSupportForDevice(fakeDevice()).supported, true);
  assert.equal(passcodeSupportForDevice(fakeDevice({ backend: 'android-emulator', kind: 'virtual' })).supported, true);
  assert.equal(passcodeSupportForDevice(fakeDevice({ backend: 'ios-simulator', platform: 'ios', kind: 'virtual', capabilities: ['tap'] })).supported, false);
  assert.equal(passcodeSupportForDevice(fakeDevice({ backend: 'ios-device', platform: 'ios', osVersion: '18.5', capabilities: ['tap', 'type'] })).supported, false);
  assert.equal(passcodeSupportForDevice(fakeDevice({ backend: 'ios-device', platform: 'ios', osVersion: '27.0', capabilities: ['tap', 'type', 'unlock'] })).supported, true);
});

test('idle-sleep classifies passcode routes properly (GET observe, PUT/DELETE control, POST unlock use)', () => {
  assert.equal(classifyRequest('GET', '/v1/devices/:id/passcode'), 'observe');
  assert.equal(classifyRequest('PUT', '/v1/devices/:id/passcode'), 'control');
  assert.equal(classifyRequest('DELETE', '/v1/devices/:id/passcode'), 'control');
  assert.equal(classifyRequest('POST', '/v1/devices/:id/unlock'), 'use');
});

test('PasscodeManager enforces opt-in, BFU safety, 1-failure breaker, channel-error non-tripping, and serialization', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-pm-test-'));
  try {
    let lockState: LockStateInfo = { locked: true, unlockedSinceBoot: true, secure: true, screenOn: false };
    let unlockCalls = 0;
    let nextUnlock: (passcode?: string) => Promise<UnlockResult> = async (p) => {
      unlockCalls++;
      if (p === '1234') {
        lockState = { locked: false, unlockedSinceBoot: true, secure: true, screenOn: true };
        return { unlocked: true, method: 'android_pin' };
      }
      return { unlocked: false, reason: 'wrong_passcode' };
    };

    const dev = fakeDevice();
    const backend: Backend = {
      id: 'android-device',
      displayName: 'Android',
      platform: 'android',
      kind: 'physical',
      capabilities: ['screenshot', 'tap', 'swipe', 'type', 'key', 'unlock'],
      available: async () => ({ ok: true }),
      listDevices: async () => [dev],
      screenshot: async () => Buffer.alloc(0),
      tap: async () => {},
      swipe: async () => {},
      type: async () => {},
      key: async () => {},
      lockState: async () => lockState,
      unlock: async (_nid, p) => nextUnlock(p),
    };

    const mgr = new PasscodeManager({
      getDevice: async () => dev,
      getBackend: () => backend,
      splitId: (id) => { const i = id.indexOf(':'); return { backend: id.slice(0, i), nativeId: id.slice(i + 1) }; },
      checkLease: () => {},
      storeOpts: {
        metaPath: join(dir, 'passcodes.json'),
        secretStore: createFileSecretStore(join(dir, 'secrets.json')),
      },
    });

    // No passcode saved -> 409 passcode_required
    await assert.rejects(() => mgr.unlock(dev.id, 'mcp:claude:1'), (e: PhoneDockError) => e.code === 'passcode_required' && e.status === 409);

    // Save passcode disabled -> agent gets 403 unattended_unlock_disabled, human app can test-unlock
    await mgr.configure(dev.id, { passcode: '1234', enabled: false }, 'app:human');
    await assert.rejects(() => mgr.unlock(dev.id, 'mcp:claude:1'), (e: PhoneDockError) => e.code === 'unattended_unlock_disabled' && e.status === 403);

    // Enable unattended unlock -> BFU refuses without tripping
    await mgr.configure(dev.id, { enabled: true }, 'app:human');
    lockState = { locked: true, unlockedSinceBoot: false, secure: true, screenOn: false };
    await assert.rejects(() => mgr.unlock(dev.id, 'mcp:claude:1'), (e: PhoneDockError) => e.code === 'before_first_unlock' && e.status === 409);
    assert.equal((await mgr.status(dev.id)).tripped, null);

    // Channel error does NOT trip the wrong-passcode breaker and redacts secret
    lockState = { locked: true, unlockedSinceBoot: true, secure: true, screenOn: false };
    nextUnlock = async (p) => { throw new PhoneDockError(`transport failed with ${p}`, 'unlock_failed', 502); };
    await assert.rejects(
      () => mgr.unlock(dev.id, 'mcp:claude:1'),
      (e: PhoneDockError) => e.code === 'unlock_failed' && !e.message.includes('1234'),
    );
    assert.equal((await mgr.status(dev.id)).tripped, null);
    assert.equal(mgr.isAutoUnlockReady(dev.id), true);

    // Wrong passcode trips the 1-failure circuit breaker; second attempt never touches backend!
    await mgr.configure(dev.id, { passcode: '9999', enabled: true }, 'app:human');
    unlockCalls = 0;
    nextUnlock = async (p) => {
      unlockCalls++;
      return p === '1234' ? { unlocked: true, method: 'android_pin' } : { unlocked: false, reason: 'wrong_passcode' };
    };
    await assert.rejects(() => mgr.unlock(dev.id, 'mcp:claude:1'), (e: PhoneDockError) => e.code === 'passcode_tripped' && e.status === 409);
    assert.equal(unlockCalls, 1);
    assert.equal(mgr.isAutoUnlockReady(dev.id), false);
    await assert.rejects(() => mgr.unlock(dev.id, 'mcp:claude:1'), (e: PhoneDockError) => e.code === 'passcode_tripped');
    assert.equal(unlockCalls, 1, 'tripped breaker must prevent any second unlock attempt');

    // Re-saving correct passcode clears breaker and succeeds; concurrent calls serialize so only 1 real unlock happens.
    await mgr.configure(dev.id, { passcode: '1234', enabled: true }, 'app:human');
    unlockCalls = 0;
    nextUnlock = async (p) => {
      if (lockState.locked === false) return { unlocked: true, alreadyUnlocked: true, method: 'already_unlocked' };
      unlockCalls++;
      await new Promise((r) => setTimeout(r, 25));
      if (p === '1234') {
        lockState = { locked: false, unlockedSinceBoot: true, secure: true, screenOn: true };
        return { unlocked: true, method: 'android_pin' };
      }
      return { unlocked: false, reason: 'wrong_passcode' };
    };
    const [a, b] = await Promise.all([mgr.unlock(dev.id, 'mcp:claude:1'), mgr.unlock(dev.id, 'mcp:claude:1')]);
    assert.equal(a.unlocked, true);
    assert.equal(b.unlocked, true);
    assert.equal(unlockCalls, 1, 'serialized concurrent unlock must not enter passcode twice');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('routes-passcode forbids mcp:* owners from saving or deleting passcodes', async () => {
  const putMatch = router.match('PUT', '/v1/devices/android-device:SER1/passcode');
  const delMatch = router.match('DELETE', '/v1/devices/android-device:SER1/passcode');
  assert.ok(putMatch && putMatch !== 'method');
  assert.ok(delMatch && delMatch !== 'method');

  const fakeCtx = (owner: string, params: Record<string, string>) => ({
    req: {} as any,
    res: {} as any,
    url: new URL('http://127.0.0.1/v1/devices/android-device:SER1/passcode'),
    params,
    owner,
    body: async () => ({ passcode: '1234' }),
    q: () => undefined,
  });

  await assert.rejects(
    async () => putMatch.h(fakeCtx('mcp:claude:42', putMatch.params)),
    (e: PhoneDockError) => e.code === 'forbidden' && e.status === 403,
  );
  await assert.rejects(
    async () => delMatch.h(fakeCtx('mcp:codex:99', delMatch.params)),
    (e: PhoneDockError) => e.code === 'forbidden' && e.status === 403,
  );
});

test('inputRoute auto-unlocks once on device_locked when unattended unlock is active and retries input', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-delivery-unlock-'));
  try {
    let locked = true;
    const dev = fakeDevice({ id: 'ios-device:UDID27', backend: 'ios-device', nativeId: 'UDID27', platform: 'ios', osVersion: '27.0', capabilities: ['tap', 'unlock'] });
    const backend: Backend = {
      id: 'ios-device',
      displayName: 'iOS',
      platform: 'ios',
      kind: 'physical',
      capabilities: ['tap', 'unlock'],
      available: async () => ({ ok: true }),
      listDevices: async () => [dev],
      screenshot: async () => Buffer.alloc(0),
      tap: async () => {},
      swipe: async () => {},
      type: async () => {},
      key: async () => {},
      lockState: async () => ({ locked, unlockedSinceBoot: true, secure: true }),
      unlock: async (_nid, p) => {
        if (p === '2468') { locked = false; return { unlocked: true, method: 'ios_hid_passcode' }; }
        return { unlocked: false, reason: 'wrong_passcode' };
      },
    };
    const mgr = new PasscodeManager({
      getDevice: async () => dev,
      getBackend: () => backend,
      splitId: (id) => { const i = id.indexOf(':'); return { backend: id.slice(0, i), nativeId: id.slice(i + 1) }; },
      checkLease: () => {},
      storeOpts: {
        metaPath: join(dir, 'passcodes.json'),
        secretStore: createFileSecretStore(join(dir, 'secrets.json')),
      },
    });
    await mgr.configure(dev.id, { passcode: '2468', enabled: true }, 'app:human');
    setPasscodeManagerForTests(mgr);

    let attempts = 0;
    const handler = inputRoute(async () => {
      attempts++;
      if (locked) throw new PhoneDockError('The iPhone is locked', 'device_locked', 409);
      return { ok: true };
    });

    const out = await handler({
      req: { headers: {} } as any,
      res: {} as any,
      url: new URL('http://127.0.0.1/v1/devices/ios-device:UDID27/input'),
      params: { id: dev.id },
      owner: 'mcp:claude:1',
      body: async () => ({ action: 'tap', x: 10, y: 20 }),
      q: () => undefined,
    }) as any;

    assert.equal(out.ok, true);
    assert.equal(attempts, 2);
    assert.equal(locked, false);
  } finally {
    setPasscodeManagerForTests(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});
