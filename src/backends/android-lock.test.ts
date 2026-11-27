import test from 'node:test';
import assert from 'node:assert/strict';
import { androidUnlock, buildAndroidCredentialScript, parseAndroidLockState, type AdbRunner } from './android-lock.ts';
import type { PhoneDockError } from '../core/types.ts';

function fakeLockDump(opts: {
  uid?: string;
  ce?: string;
  awake?: boolean;
  showing?: boolean;
  secure?: boolean;
  trust?: string;
  trustLocked?: boolean;
}): string {
  const uid = opts.uid ?? '0';
  const trustBody = opts.trust ?? `User "Owner" (id=${uid}): deviceLocked=${opts.trustLocked ? '1' : '0'}`;
  return [
    '===UID===',
    uid,
    '===CE===',
    opts.ce ?? 'true',
    '===PWR===',
    opts.awake === false ? 'mWakefulness=Asleep' : 'mWakefulness=Awake',
    '===WIN===',
    `mShowingLockscreen=${opts.showing ? 'true' : 'false'}`,
    `isStatusBarKeyguard=${opts.showing ? 'true' : 'false'}`,
    `mIsSecure=${opts.secure ? 'true' : 'false'}`,
    '===TRUST===',
    trustBody,
  ].join('\n');
}

test('parseAndroidLockState scopes trust dump to foreground user and ignores locked work profile', () => {
  const withWorkProfile = parseAndroidLockState({
    userId: '0',
    ceAvailable: 'true',
    power: 'mWakefulness=Awake',
    window: 'mShowingLockscreen=false\nisStatusBarKeyguard=false\nmIsSecure=true',
    trust: [
      'User "Owner" (id=0): deviceLocked=0',
      'User "Work profile" (id=10): deviceLocked=1',
    ].join('\n'),
  });
  assert.deepEqual(withWorkProfile, { locked: false, unlockedSinceBoot: true, secure: true, screenOn: true });

  const bfu = parseAndroidLockState({ ceAvailable: 'false', window: 'mShowingLockscreen=true\nmIsSecure=true' });
  assert.equal(bfu.unlockedSinceBoot, false);
  assert.equal(bfu.locked, true);
});

test('buildAndroidCredentialScript splits literal %s so Android input text does not turn it into a space', () => {
  assert.equal(buildAndroidCredentialScript('2580'), 'input keyevent KEYCODE_2 KEYCODE_5 KEYCODE_8 KEYCODE_0 KEYCODE_ENTER\n');
  const script = buildAndroidCredentialScript('a%sb c');
  assert.equal(script.includes("input text 'a%' && input text 'sb%sc' && input keyevent KEYCODE_ENTER"), true);
});

test('androidUnlock skips entry when already unlocked, wakes if screen is off, and refuses BFU or unknown AFU', async () => {
  const calls: { args: string[]; input?: string }[] = [];
  const makeRunner = (dump: string): AdbRunner => async (_s, args, opts) => {
    calls.push({ args, input: typeof opts?.input === 'string' ? opts.input : undefined });
    if (args[1]?.includes('===CE===')) return { stdout: dump, stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  };

  const r1 = await androidUnlock('emu-1', '1234', { adb: makeRunner(fakeLockDump({ awake: true, showing: false })), wait: async () => {} });
  assert.deepEqual(r1, { unlocked: true, alreadyUnlocked: true, method: 'already_unlocked' });
  assert.equal(calls.length, 1);

  calls.length = 0;
  const r2 = await androidUnlock('emu-1', '1234', { adb: makeRunner(fakeLockDump({ awake: false, showing: false })), wait: async () => {} });
  assert.deepEqual(r2, { unlocked: true, alreadyUnlocked: true, method: 'wake' });
  assert.deepEqual(calls[1].args, ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);

  // BFU -> never sends passcode
  calls.length = 0;
  const r3 = await androidUnlock('emu-1', '1234', { adb: makeRunner(fakeLockDump({ ce: 'false', showing: true, secure: true })), wait: async () => {} });
  assert.deepEqual(r3, { unlocked: false, reason: 'before_first_unlock' });
  assert.equal(calls.length, 1);

  // Unknown AFU (ce empty) -> refuses before typing
  calls.length = 0;
  let dispatched = false;
  const r4 = await androidUnlock('emu-1', '1234', {
    adb: makeRunner(fakeLockDump({ ce: '', awake: true, showing: true, secure: true, trustLocked: true })),
    screenSize: async () => ({ width: 1080, height: 2400 }),
    wait: async () => {},
    beforeDispatch: () => { dispatched = true; },
  });
  assert.deepEqual(r4, { unlocked: false, reason: 'before_first_unlock' });
  assert.equal(dispatched, false);
});

test('androidUnlock sends PIN and %s password strictly via `shell sh -s` stdin with zero credentials in host argv', async () => {
  for (const [secret, expectedMethod] of [['2580', 'android_pin'], ['P@ss%s99', 'android_password']] as const) {
    const calls: { args: string[]; input?: string }[] = [];
    let unlocked = false;
    let awake = false;
    let beforeDispatchCalls = 0;
    const adb: AdbRunner = async (_s, args, opts) => {
      calls.push({ args, input: typeof opts?.input === 'string' ? opts.input : undefined });
      if (args[1]?.includes('===CE===')) {
        return { stdout: fakeLockDump({ awake, showing: !unlocked, secure: true, trustLocked: !unlocked }), stderr: '', code: 0 };
      }
      if (args.includes('KEYCODE_WAKEUP')) awake = true;
      if (args[0] === 'shell' && args[1] === 'sh' && args[2] === '-s') {
        unlocked = true;
      }
      return { stdout: '', stderr: '', code: 0 };
    };

    const res = await androidUnlock('emu-1', secret, {
      adb,
      screenSize: async () => ({ width: 1080, height: 2400 }),
      wait: async () => {},
      beforeDispatch: () => { beforeDispatchCalls++; },
    });
    assert.deepEqual(res, { unlocked: true, method: expectedMethod });
    assert.equal(beforeDispatchCalls, 1);

    // Every single child argv must NEVER contain plaintext, escaped secret, or ordered PIN digits.
    for (const c of calls) {
      const joined = c.args.join(' ');
      assert.equal(joined.includes(secret), false, `secret leaked in argv: ${joined}`);
      assert.equal(joined.includes('KEYCODE_2 KEYCODE_5 KEYCODE_8 KEYCODE_0'), false, `PIN digits leaked in argv: ${joined}`);
    }
    const stdinCalls = calls.filter((c) => c.args[0] === 'shell' && c.args[1] === 'sh' && c.args[2] === '-s');
    assert.equal(stdinCalls.length, 1);
    assert.ok(stdinCalls[0].input && stdinCalls[0].input.includes('KEYCODE_ENTER'));
  }
});

test('androidUnlock returns without typing when device unlocks during wake/dismiss', async () => {
  let dismissed = false;
  let dispatched = false;
  const adb: AdbRunner = async (_s, args) => {
    if (args[1]?.includes('===CE===')) {
      return { stdout: fakeLockDump({ awake: true, showing: !dismissed, secure: false, trustLocked: false }), stderr: '', code: 0 };
    }
    if (args[1] === 'wm' && args[2] === 'dismiss-keyguard') dismissed = true;
    return { stdout: '', stderr: '', code: 0 };
  };

  const res = await androidUnlock('emu-1', '1234', {
    adb,
    wait: async () => {},
    beforeDispatch: () => { dispatched = true; },
  });
  assert.deepEqual(res, { unlocked: true, method: 'dismiss_keyguard' });
  assert.equal(dispatched, false);
});

test('androidUnlock distinguishes confirmed wrong_passcode from unreadable unlock_unverified and never retries', async () => {
  let stdinSubmits = 0;
  const alwaysLocked: AdbRunner = async (_s, args) => {
    if (args[1]?.includes('===CE===')) {
      return { stdout: fakeLockDump({ awake: true, showing: true, secure: true, trustLocked: true }), stderr: '', code: 0 };
    }
    if (args[1] === 'sh' && args[2] === '-s') stdinSubmits++;
    return { stdout: '', stderr: '', code: 0 };
  };

  const rWrong = await androidUnlock('emu-1', '9999', {
    adb: alwaysLocked,
    screenSize: async () => ({ width: 1080, height: 2400 }),
    wait: async () => {},
  });
  assert.deepEqual(rWrong, { unlocked: false, reason: 'wrong_passcode' });
  assert.equal(stdinSubmits, 1);

  // Unreadable probes after dispatch -> unlock_unverified
  let dispatched = false;
  const unreadableAfter: AdbRunner = async (_s, args) => {
    if (args[1]?.includes('===CE===')) {
      if (dispatched) return { stdout: '', stderr: 'offline', code: 1 };
      return { stdout: fakeLockDump({ awake: true, showing: true, secure: true, trustLocked: true }), stderr: '', code: 0 };
    }
    if (args[1] === 'sh' && args[2] === '-s') dispatched = true;
    return { stdout: '', stderr: '', code: 0 };
  };
  const rUnverified = await androidUnlock('emu-1', '9999', {
    adb: unreadableAfter,
    screenSize: async () => ({ width: 1080, height: 2400 }),
    wait: async () => {},
  });
  assert.deepEqual(rUnverified, { unlocked: false, reason: 'unlock_unverified' });
});
