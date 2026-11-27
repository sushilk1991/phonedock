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

test('passcodeSupportForDevice distinguishes Android, iOS 27 native (with or without WDA), iOS 18-26 WDA, and simulators', () => {
  assert.equal(passcodeSupportForDevice(fakeDevice()).supported, true);
  assert.equal(passcodeSupportForDevice(fakeDevice({ backend: 'android-emulator', kind: 'virtual' })).supported, true);
  assert.equal(passcodeSupportForDevice(fakeDevice({ backend: 'ios-simulator', platform: 'ios', kind: 'virtual', capabilities: ['tap'] })).supported, false);
  assert.equal(passcodeSupportForDevice(fakeDevice({ backend: 'ios-device', platform: 'ios', osVersion: '18.5', capabilities: ['tap', 'type'] })).supported, false);
  assert.equal(passcodeSupportForDevice(fakeDevice({ backend: 'ios-device', platform: 'ios', osVersion: '27.0', capabilities: ['tap', 'type'] })).supported, true);
});

test('idle-sleep classifies passcode routes properly (GET observe, PUT/DELETE control, POST unlock use)', () => {
  assert.equal(classifyRequest('GET', '/v1/devices/:id/passcode'), 'observe');
  assert.equal(classifyRequest('PUT', '/v1/devices/:id/passcode'), 'control');
  assert.equal(classifyRequest('DELETE', '/v1/devices/:id/passcode'), 'control');
  assert.equal(classifyRequest('POST', '/v1/devices/:id/unlock'), 'use');
});

test('two PasscodeManagers sharing one home allow at most ONE submission across lost acknowledgement and restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-pm-multi-'));
  const dbPath = join(dir, 'passcodes.sqlite');
  const secrets = createFileSecretStore(join(dir, 'secrets.json'));
  const dev = fakeDevice();
  let submissions = 0;

  const makeBackend = (loseAck: boolean): Backend => ({
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
    lockState: async () => ({ locked: true, unlockedSinceBoot: true, secure: true, screenOn: true }),
    unlock: async (_nid, _p, opts) => {
      await opts?.beforeDispatch?.();
      submissions++;
      if (loseAck) throw new Error('lost connection after sending 1234');
      return { unlocked: true, method: 'android_pin' };
    },
  });

  const makeMgr = (b: Backend) => new PasscodeManager({
    getDevice: async () => dev,
    getBackend: () => b,
    splitId: (id) => { const i = id.indexOf(':'); return { backend: id.slice(0, i), nativeId: id.slice(i + 1) }; },
    checkLease: () => {},
    storeOpts: { dbPath, secretStore: secrets },
  });

  const mgrA = makeMgr(makeBackend(true));
  const mgrB = makeMgr(makeBackend(false));
  try {
    await mgrA.configure(dev.id, { passcode: '1234', enabled: true }, 'app:human');

    // Manager A sends credential and loses acknowledgement (raw Error must be mapped to allowlisted PhoneDockError with delivery='unknown').
    await assert.rejects(
      () => mgrA.unlock(dev.id, 'mcp:claude:1'),
      (e: PhoneDockError) => e.code === 'unlock_failed' && e.delivery === 'unknown' && !e.message.includes('1234'),
    );
    assert.equal(submissions, 1);

    // Manager B (second daemon sharing the same home) must see the trip and NEVER submit a second time.
    await assert.rejects(
      () => mgrB.unlock(dev.id, 'mcp:claude:1'),
      (e: PhoneDockError) => e.code === 'passcode_tripped' && e.status === 409,
    );
    assert.equal(submissions, 1);

    // Freshly restarted Manager C must ALSO refuse without submitting.
    const mgrC = makeMgr(makeBackend(false));
    try {
      await assert.rejects(
        () => mgrC.unlock(dev.id, 'mcp:claude:1'),
        (e: PhoneDockError) => e.code === 'passcode_tripped' && e.status === 409,
      );
      assert.equal(submissions, 1);
    } finally {
      mgrC.store.close();
    }
  } finally {
    mgrA.store.close();
    mgrB.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PasscodeManager enforces strict disabled toggle (no app:human bypass), BFU safety, pre-dispatch non-tripping, and serialization', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-pm-test-'));
  let mgr: PasscodeManager | undefined;
  try {
    let lockState: LockStateInfo = { locked: true, unlockedSinceBoot: true, secure: true, screenOn: false };
    let unlockCalls = 0;
    let nextUnlock: (passcode?: string, opts?: { beforeDispatch?: () => void | Promise<void> }) => Promise<UnlockResult> = async (p, opts) => {
      await opts?.beforeDispatch?.();
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
      unlock: async (_nid, p, opts) => nextUnlock(p, opts),
    };

    mgr = new PasscodeManager({
      getDevice: async () => dev,
      getBackend: () => backend,
      splitId: (id) => { const i = id.indexOf(':'); return { backend: id.slice(0, i), nativeId: id.slice(i + 1) }; },
      checkLease: () => {},
      storeOpts: {
        dbPath: join(dir, 'passcodes.sqlite'),
        secretStore: createFileSecretStore(join(dir, 'secrets.json')),
      },
    });

    // No passcode saved -> 409 passcode_required
    await assert.rejects(() => mgr!.unlock(dev.id, 'mcp:claude:1'), (e: PhoneDockError) => e.code === 'passcode_required' && e.status === 409);

    // Save passcode disabled -> BOTH agent AND app:human get 403 unattended_unlock_disabled (no spoofable bypass)
    await mgr.configure(dev.id, { passcode: '1234', enabled: false }, 'app:human');
    await assert.rejects(() => mgr!.unlock(dev.id, 'mcp:claude:1'), (e: PhoneDockError) => e.code === 'unattended_unlock_disabled' && e.status === 403);
    await assert.rejects(() => mgr!.unlock(dev.id, 'app:human'), (e: PhoneDockError) => e.code === 'unattended_unlock_disabled' && e.status === 403);

    // Enable unattended unlock -> BFU refuses without tripping
    await mgr.configure(dev.id, { enabled: true }, 'app:human');
    lockState = { locked: true, unlockedSinceBoot: false, secure: true, screenOn: false };
    await assert.rejects(() => mgr!.unlock(dev.id, 'mcp:claude:1'), (e: PhoneDockError) => e.code === 'before_first_unlock' && e.status === 409);
    assert.equal((await mgr.status(dev.id)).tripped, null);

    // Pre-dispatch error (before beforeDispatch runs) does NOT trip the breaker
    lockState = { locked: true, unlockedSinceBoot: true, secure: true, screenOn: false };
    nextUnlock = async () => { throw new PhoneDockError('wake channel failed', 'unlock_failed', 502, undefined, undefined, 'not_sent'); };
    await assert.rejects(() => mgr!.unlock(dev.id, 'mcp:claude:1'), (e: PhoneDockError) => e.code === 'unlock_failed' && e.delivery === 'not_sent');
    assert.equal((await mgr.status(dev.id)).tripped, null);
    assert.equal(mgr.isAutoUnlockReady(dev.id), true);

    // Concurrent calls serialize so only 1 real unlock happens.
    unlockCalls = 0;
    nextUnlock = async (p, opts) => {
      if (lockState.locked === false) return { unlocked: true, alreadyUnlocked: true, method: 'already_unlocked' };
      await opts?.beforeDispatch?.();
      unlockCalls++;
      await new Promise((r) => setTimeout(r, 25));
      lockState = { locked: false, unlockedSinceBoot: true, secure: true, screenOn: true };
      return { unlocked: true, method: p ? 'android_pin' : 'wake' };
    };
    const [a, b] = await Promise.all([mgr.unlock(dev.id, 'mcp:claude:1'), mgr.unlock(dev.id, 'mcp:claude:1')]);
    assert.equal(a.unlocked, true);
    assert.equal(b.unlocked, true);
    assert.equal(unlockCalls, 1, 'serialized concurrent unlock must not enter passcode twice');
  } finally {
    mgr?.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('routes-passcode forbids mcp:* owners and returns fixed bad_json without leaking secret snippets', async () => {
  const putMatch = router.match('PUT', '/v1/devices/android-device:SER1/passcode');
  const delMatch = router.match('DELETE', '/v1/devices/android-device:SER1/passcode');
  assert.ok(putMatch && putMatch !== 'method');
  assert.ok(delMatch && delMatch !== 'method');

  const fakeCtx = (owner: string, params: Record<string, string>, bodyFn: () => Promise<unknown> = async () => ({ passcode: '1234' })) => ({
    req: {} as any,
    res: {} as any,
    url: new URL('http://127.0.0.1/v1/devices/android-device:SER1/passcode'),
    params,
    owner,
    body: bodyFn,
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
  // Malformed JSON error must not echo secret text from parser diagnostic
  await assert.rejects(
    async () => putMatch.h(fakeCtx('app:human', putMatch.params, async () => {
      throw new PhoneDockError('Invalid JSON', 'bad_json', 400, undefined, 'Unexpected token S in {"passcode":"SuperSecret99');
    })),
    (e: PhoneDockError) => e.code === 'bad_json' && !String(e.detail ?? '').includes('SuperSecret99') && !e.message.includes('SuperSecret99'),
  );
});

test('inputRoute auto-unlocks ONLY on pre-dispatch device_locked (delivery=not_sent) and skips array lock-key inputs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-delivery-unlock-'));
  let mgr: PasscodeManager | undefined;
  try {
    let locked = true;
    let lockStateCalls = 0;
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
      lockState: async () => { lockStateCalls++; return { locked, unlockedSinceBoot: true, secure: true }; },
      unlock: async (_nid, p, opts) => {
        await opts?.beforeDispatch?.();
        if (p === '2468') { locked = false; return { unlocked: true, method: 'ios_hid_passcode' }; }
        return { unlocked: false, reason: 'wrong_passcode' };
      },
    };
    mgr = new PasscodeManager({
      getDevice: async () => dev,
      getBackend: () => backend,
      splitId: (id) => { const i = id.indexOf(':'); return { backend: id.slice(0, i), nativeId: id.slice(i + 1) }; },
      checkLease: () => {},
      storeOpts: {
        dbPath: join(dir, 'passcodes.sqlite'),
        secretStore: createFileSecretStore(join(dir, 'secrets.json')),
      },
    });
    await mgr.configure(dev.id, { passcode: '2468', enabled: true }, 'app:human');
    setPasscodeManagerForTests(mgr);

    // 1. Post-dispatch device_locked WITHOUT delivery='not_sent' must NOT be replayed!
    let postDispatchAttempts = 0;
    const postDispatchHandler = inputRoute(async () => {
      postDispatchAttempts++;
      throw new PhoneDockError('The iPhone is locked', 'device_locked', 409); // no delivery='not_sent'
    });
    await assert.rejects(
      () => postDispatchHandler({
        req: { headers: {} } as any,
        res: {} as any,
        url: new URL('http://127.0.0.1/v1/devices/ios-device:UDID27/apps/com.x/launch'),
        params: { id: dev.id },
        owner: 'mcp:claude:1',
        body: async () => ({}),
        q: () => undefined,
      }) as Promise<unknown>,
      (e: PhoneDockError) => e.code === 'device_locked' && e.delivery === 'unknown',
    );
    assert.equal(postDispatchAttempts, 1, 'must NOT replay post-dispatch device_locked error');

    // 2. Pre-dispatch device_locked WITH delivery='not_sent' auto-unlocks once and retries!
    let attempts = 0;
    const handler = inputRoute(async () => {
      attempts++;
      if (locked) throw new PhoneDockError('The iPhone is locked', 'device_locked', 409, undefined, undefined, 'not_sent');
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

    // 3. Array lock-key input on Android must NOT trigger pre-input auto-unlock probe!
    const androidDev = fakeDevice({ id: 'android-device:SER2', nativeId: 'SER2' });
    await mgr.configure(androidDev.id, { passcode: '1234', enabled: true }, 'app:human');
    const beforeCalls = lockStateCalls;
    const lockArrayHandler = inputRoute(async () => ({ ok: true }));
    await lockArrayHandler({
      req: { headers: {} } as any,
      res: {} as any,
      url: new URL('http://127.0.0.1/v1/devices/android-device:SER2/input'),
      params: { id: androidDev.id },
      owner: 'mcp:claude:1',
      body: async () => ({ actions: [{ action: 'key', key: 'lock' }] }),
      q: () => undefined,
    });
    assert.equal(lockStateCalls, beforeCalls, 'array lock key must bypass pre-input auto-unlock');
  } finally {
    setPasscodeManagerForTests(undefined);
    mgr?.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
