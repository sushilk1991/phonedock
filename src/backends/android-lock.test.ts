import test from 'node:test';
import assert from 'node:assert/strict';
import { androidUnlock, parseAndroidLockState, type AdbRunner } from './android-lock.ts';
import type { PhoneDockError } from '../core/types.ts';

function fakeLockDump(opts: { ce?: string; awake?: boolean; showing?: boolean; secure?: boolean; trustLocked?: boolean }): string {
  return [
    '===CE===',
    opts.ce ?? 'true',
    '===PWR===',
    opts.awake === false ? 'mWakefulness=Asleep' : 'mWakefulness=Awake',
    '===WIN===',
    `mShowingLockscreen=${opts.showing ? 'true' : 'false'}`,
    `isStatusBarKeyguard=${opts.showing ? 'true' : 'false'}`,
    `mIsSecure=${opts.secure ? 'true' : 'false'}`,
    '===TRUST===',
    `deviceLocked=${opts.trustLocked ? '1' : '0'}`,
  ].join('\n');
}

test('parseAndroidLockState parses awake/unlocked, locked/secure, swipe-only, and BFU states', () => {
  const unlocked = parseAndroidLockState({
    ceAvailable: 'true',
    power: 'mWakefulness=Awake',
    window: 'mShowingLockscreen=false\nisStatusBarKeyguard=false\nmIsSecure=true',
    trust: 'deviceLocked=0',
  });
  assert.deepEqual(unlocked, { locked: false, unlockedSinceBoot: true, secure: true, screenOn: true });

  const lockedPin = parseAndroidLockState({
    ceAvailable: 'true',
    power: 'mWakefulness=Asleep',
    window: 'mShowingLockscreen=true\nmIsSecure=true',
    trust: 'deviceLocked=1',
  });
  assert.deepEqual(lockedPin, { locked: true, unlockedSinceBoot: true, secure: true, screenOn: false });

  const bfu = parseAndroidLockState({ ceAvailable: 'false', window: 'mShowingLockscreen=true\nmIsSecure=true' });
  assert.equal(bfu.unlockedSinceBoot, false);
  assert.equal(bfu.locked, true);

  const swipeOnly = parseAndroidLockState({
    ceAvailable: 'true',
    power: 'mWakefulness=Awake',
    window: 'mShowingLockscreen=true\nmIsSecure=false',
    trust: 'deviceLocked=0',
  });
  assert.deepEqual(swipeOnly, { locked: true, unlockedSinceBoot: true, secure: false, screenOn: true });
});

test('androidUnlock skips entry when already unlocked, wakes if screen is off, and refuses BFU', async () => {
  const calls: string[][] = [];
  const makeRunner = (dump: string): AdbRunner => async (_s, args) => {
    calls.push(args);
    if (args[1]?.includes('===CE===')) return { stdout: dump, stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  };

  // Already unlocked & awake
  const r1 = await androidUnlock('emu-1', '1234', { adb: makeRunner(fakeLockDump({ awake: true, showing: false })), wait: async () => {} });
  assert.deepEqual(r1, { unlocked: true, alreadyUnlocked: true, method: 'already_unlocked' });
  assert.equal(calls.length, 1);

  // Already unlocked & asleep -> wakes
  calls.length = 0;
  const r2 = await androidUnlock('emu-1', '1234', { adb: makeRunner(fakeLockDump({ awake: false, showing: false })), wait: async () => {} });
  assert.deepEqual(r2, { unlocked: true, alreadyUnlocked: true, method: 'wake' });
  assert.deepEqual(calls[1], ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);

  // BFU -> never sends passcode
  calls.length = 0;
  const r3 = await androidUnlock('emu-1', '1234', { adb: makeRunner(fakeLockDump({ ce: 'false', showing: true, secure: true })), wait: async () => {} });
  assert.deepEqual(r3, { unlocked: false, reason: 'before_first_unlock' });
  assert.equal(calls.length, 1);
});

test('androidUnlock enters numeric PIN once via KEYCODE_0..9 + ENTER and returns unlocked', async () => {
  const calls: string[][] = [];
  let unlocked = false;
  const adb: AdbRunner = async (_s, args) => {
    calls.push(args);
    if (args[1]?.includes('===CE===')) {
      return { stdout: fakeLockDump({ awake: unlocked, showing: !unlocked, secure: true, trustLocked: !unlocked }), stderr: '', code: 0 };
    }
    if (args.includes('KEYCODE_1') && args.includes('KEYCODE_4') && args.includes('KEYCODE_ENTER')) {
      unlocked = true;
    }
    return { stdout: '', stderr: '', code: 0 };
  };

  const res = await androidUnlock('emu-1', '1234', {
    adb,
    screenSize: async () => ({ width: 1080, height: 2400 }),
    wait: async () => {},
  });
  assert.deepEqual(res, { unlocked: true, method: 'android_pin' });
  const pinCalls = calls.filter((a) => a.includes('KEYCODE_1'));
  assert.equal(pinCalls.length, 1);
  assert.deepEqual(pinCalls[0], ['shell', 'input', 'keyevent', 'KEYCODE_1', 'KEYCODE_2', 'KEYCODE_3', 'KEYCODE_4', 'KEYCODE_ENTER']);
});

test('androidUnlock never retries a wrong PIN and redacts password errors', async () => {
  const calls: string[][] = [];
  const alwaysLocked: AdbRunner = async (_s, args) => {
    calls.push(args);
    if (args[1]?.includes('===CE===')) {
      return { stdout: fakeLockDump({ awake: false, showing: true, secure: true, trustLocked: true }), stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  };

  const res = await androidUnlock('emu-1', '9999', {
    adb: alwaysLocked,
    screenSize: async () => ({ width: 1080, height: 2400 }),
    wait: async () => {},
  });
  assert.deepEqual(res, { unlocked: false, reason: 'wrong_passcode' });
  // Must attempt keyevent entry EXACTLY ONCE.
  assert.equal(calls.filter((a) => a.includes('KEYCODE_9')).length, 1);

  // Alphanumeric password error must redact the secret.
  const failingPw: AdbRunner = async (_s, args) => {
    if (args[1]?.includes('===CE===')) {
      return { stdout: fakeLockDump({ awake: false, showing: true, secure: true, trustLocked: true }), stderr: '', code: 0 };
    }
    if (args[1] === 'input' && args[2] === 'text') {
      return { stdout: '', stderr: `permission denied for input text ${args[3]}`, code: 1 };
    }
    return { stdout: '', stderr: '', code: 0 };
  };

  await assert.rejects(
    () => androidUnlock('emu-1', 'My$ecret99', {
      adb: failingPw,
      screenSize: async () => ({ width: 1080, height: 2400 }),
      wait: async () => {},
    }),
    (e: PhoneDockError) => e.code === 'unlock_failed' && !String(e.detail).includes('My$ecret99') && !String(e.detail).includes('My\\$ecret99'),
  );
});

test('androidUnlock handles swipe-only lock without a passcode and rejects secure lock without a passcode', async () => {
  let dismissed = false;
  const swipeAdb: AdbRunner = async (_s, args) => {
    if (args[1]?.includes('===CE===')) {
      return { stdout: fakeLockDump({ awake: true, showing: !dismissed, secure: false, trustLocked: false }), stderr: '', code: 0 };
    }
    if (args[1] === 'wm' && args[2] === 'dismiss-keyguard') dismissed = true;
    return { stdout: '', stderr: '', code: 0 };
  };

  const r1 = await androidUnlock('emu-1', undefined, { adb: swipeAdb, wait: async () => {} });
  assert.deepEqual(r1, { unlocked: true, method: 'dismiss_keyguard' });

  const secureAdb: AdbRunner = async (_s, args) => {
    if (args[1]?.includes('===CE===')) {
      return { stdout: fakeLockDump({ awake: true, showing: true, secure: true, trustLocked: true }), stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  };
  await assert.rejects(
    () => androidUnlock('emu-1', undefined, { adb: secureAdb, wait: async () => {} }),
    (e: PhoneDockError) => e.code === 'passcode_required' && e.status === 409,
  );
});
