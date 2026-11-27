// Android lock-state detection and unattended unlock over adb (real Android phones and Android emulators).
// Supports swipe-only lock screens (dismiss-keyguard) and PIN / password locks after first unlock (AFU).
// Never echoes or logs the passcode in errors or command diagnostics.
import { sleep } from '../core/exec.ts';
import { redactSecretStrings } from '../core/secrets.ts';
import { PhoneDockError, type ExecResult, type LockStateInfo, type UnlockResult } from '../core/types.ts';
import * as A from './android-common.ts';

export type AdbRunner = (serial: string, args: string[], opts?: { allowFail?: boolean; timeoutMs?: number }) => Promise<ExecResult>;

export interface AndroidUnlockDeps {
  adb?: AdbRunner;
  screenSize?: (serial: string) => Promise<{ width: number; height: number }>;
  wait?: (ms: number) => Promise<void>;
}

/** Parse Android lock/screen/security state from `dumpsys window policy`, `dumpsys power`, `dumpsys trust`,
 *  and `getprop sys.user.0.ce_available`. Pure function for unit tests. */
export function parseAndroidLockState(input: {
  window?: string;
  power?: string;
  trust?: string;
  ceAvailable?: string;
}): LockStateInfo {
  const win = input.window ?? '';
  const pwr = input.power ?? '';
  const trust = input.trust ?? '';
  const ce = (input.ceAvailable ?? '').trim().toLowerCase();

  let screenOn: boolean | null = null;
  if (/mWakefulness=Awake\b/i.test(pwr) || /Display Power:\s*state=ON\b/i.test(pwr) || /mInteractive=true\b/i.test(pwr)) {
    screenOn = true;
  } else if (/mWakefulness=(?:Asleep|Dozing)\b/i.test(pwr) || /Display Power:\s*state=OFF\b/i.test(pwr) || /mInteractive=false\b/i.test(pwr)) {
    screenOn = false;
  }

  // `sys.user.0.ce_available` is `true` once credential-encrypted storage is unlocked (After First Unlock).
  let unlockedSinceBoot: boolean | null = null;
  if (ce === 'true' || ce === '1') unlockedSinceBoot = true;
  else if (ce === 'false' || ce === '0') unlockedSinceBoot = false;

  // Determine whether the keyguard / lock screen is currently showing.
  let locked: boolean | null = null;
  const winTrue =
    /\bmShowingLockscreen=true\b/i.test(win)
    || /\bisStatusBarKeyguard=true\b/i.test(win)
    || /\bmDreamingLockscreen=true\b/i.test(win)
    || /\bshowing=true\b/i.test(win);
  const winFalse =
    /\bmShowingLockscreen=false\b/i.test(win)
    || /\bisStatusBarKeyguard=false\b/i.test(win)
    || /\bshowing=false\b/i.test(win);

  const trustLocked = /\bdeviceLocked=1\b/i.test(trust) || /\blocked=1\b/i.test(trust);
  const trustUnlocked = /\bdeviceLocked=0\b/i.test(trust) || /\blocked=0\b/i.test(trust);

  if (winTrue) locked = true;
  else if (winFalse && !trustLocked) locked = false;
  else if (trustLocked) locked = true;
  else if (trustUnlocked) locked = false;

  // Determine whether the lock screen requires credentials (PIN / password / pattern) vs swipe-only.
  let secure: boolean | null = null;
  if (/\bmIsSecure=true\b/i.test(win) || /\bisKeyguardSecure=true\b/i.test(win) || /\bsecure=true\b/i.test(win) || /\bdeviceLocked=1\b/i.test(trust)) {
    secure = true;
  } else if (/\bmIsSecure=false\b/i.test(win) || /\bisKeyguardSecure=false\b/i.test(win) || /\bsecure=false\b/i.test(win)) {
    secure = false;
  }

  return { locked, unlockedSinceBoot, secure, screenOn };
}

/** Query the current Android lock state in a single shell round-trip. */
export async function androidLockState(serial: string, adbRun: AdbRunner = A.adb): Promise<LockStateInfo> {
  const script = [
    'echo "===CE==="',
    'getprop sys.user.0.ce_available',
    'echo "===PWR==="',
    'dumpsys power | grep -E "mWakefulness=|Display Power:|mInteractive=" | head -n 10',
    'echo "===WIN==="',
    'dumpsys window policy | grep -E "mShowingLockscreen|isStatusBarKeyguard|mDreamingLockscreen|showing=|mIsSecure|isKeyguardSecure|secure=" | head -n 20',
    'echo "===TRUST==="',
    'dumpsys trust | grep -E "deviceLocked=|locked=" | head -n 10',
  ].join('; ');
  const r = await adbRun(serial, ['shell', script], { allowFail: true, timeoutMs: 10_000 });
  const out = r.stdout;
  const section = (tag: string, next?: string): string => {
    const start = out.indexOf(`===${tag}===`);
    if (start < 0) return '';
    const from = start + tag.length + 6;
    const end = next ? out.indexOf(`===${next}===`, from) : -1;
    return (end >= 0 ? out.slice(from, end) : out.slice(from)).trim();
  };
  return parseAndroidLockState({
    ceAvailable: section('CE', 'PWR'),
    power: section('PWR', 'WIN'),
    window: section('WIN', 'TRUST'),
    trust: section('TRUST'),
  });
}

/** Map a numeric digit `'0'..'9'` to its Android KEYCODE_0..KEYCODE_9 name. */
function digitKeycodes(pin: string): string[] {
  return [...pin].map((d) => `KEYCODE_${d}`);
}

/** Unlock an Android phone or emulator.
 *  - If already unlocked (and screen off), wakes it and returns `alreadyUnlocked: true`.
 *  - If swipe-only lock, dismisses keyguard without needing a passcode.
 *  - If PIN/password lock, wakes, opens bouncer, enters the passcode once, and polls lock state to confirm.
 *  Never retries a wrong passcode. Redacts the passcode from any error details. */
export async function androidUnlock(serial: string, passcode?: string, deps: AndroidUnlockDeps = {}): Promise<UnlockResult> {
  const adbRun = deps.adb ?? A.adb;
  const wait = deps.wait ?? sleep;
  const getSize = deps.screenSize ?? (async (s: string) => {
    const info = await A.screenInfo(s).catch(() => undefined);
    return info ? { width: info.width, height: info.height } : { width: 1080, height: 2400 };
  });

  const before = await androidLockState(serial, adbRun);
  if (before.unlockedSinceBoot === false) {
    return { unlocked: false, reason: 'before_first_unlock' };
  }

  if (before.locked === false) {
    if (before.screenOn === false) {
      await adbRun(serial, ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], { allowFail: true, timeoutMs: 8_000 });
      return { unlocked: true, alreadyUnlocked: true, method: 'wake' };
    }
    return { unlocked: true, alreadyUnlocked: true, method: 'already_unlocked' };
  }

  // Wake the display first.
  await adbRun(serial, ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], { allowFail: true, timeoutMs: 8_000 });
  await wait(300);

  // If the lock screen is not secure (swipe-only), try dismissing keyguard first.
  if (before.secure === false) {
    await adbRun(serial, ['shell', 'wm', 'dismiss-keyguard'], { allowFail: true, timeoutMs: 8_000 });
    await wait(400);
    const afterDismiss = await androidLockState(serial, adbRun);
    if (afterDismiss.locked === false) {
      return { unlocked: true, method: 'dismiss_keyguard' };
    }
    const sz = await getSize(serial);
    const cx = Math.round(sz.width / 2);
    await adbRun(
      serial,
      ['shell', 'input', 'swipe', String(cx), String(Math.round(sz.height * 0.85)), String(cx), String(Math.round(sz.height * 0.25)), '250'],
      { allowFail: true, timeoutMs: 8_000 },
    );
    await wait(450);
    const afterSwipe = await androidLockState(serial, adbRun);
    if (afterSwipe.locked === false) {
      return { unlocked: true, method: 'swipe_unlock' };
    }
    if (!passcode) {
      return { unlocked: false, reason: 'still_locked' };
    }
  }

  // Secure lock (or unknown security while locked): try wm dismiss-keyguard first in case it's actually swipe-only.
  if (!passcode) {
    if (before.secure === null) {
      await adbRun(serial, ['shell', 'wm', 'dismiss-keyguard'], { allowFail: true, timeoutMs: 8_000 });
      await wait(400);
      const after = await androidLockState(serial, adbRun);
      if (after.locked === false) return { unlocked: true, method: 'dismiss_keyguard' };
    }
    throw new PhoneDockError(
      'The Android device is locked and requires a passcode',
      'passcode_required',
      409,
      ['Save a passcode in PhoneDock Device Settings (Unattended Unlock) or unlock the phone manually.'],
    );
  }

  // Bring up the PIN/password bouncer.
  await adbRun(serial, ['shell', 'wm', 'dismiss-keyguard'], { allowFail: true, timeoutMs: 8_000 });
  await wait(250);
  const sz = await getSize(serial);
  const cx = Math.round(sz.width / 2);
  await adbRun(
    serial,
    ['shell', 'input', 'swipe', String(cx), String(Math.round(sz.height * 0.85)), String(cx), String(Math.round(sz.height * 0.25)), '250'],
    { allowFail: true, timeoutMs: 8_000 },
  );
  await wait(450);

  // Enter the passcode ONCE. Never retry on failure.
  const isNumericPin = /^\d+$/.test(passcode);
  try {
    if (isNumericPin) {
      // Send individual KEYCODE_0..KEYCODE_9 events + ENTER: works reliably on Android PIN bouncers.
      const res = await adbRun(serial, ['shell', 'input', 'keyevent', ...digitKeycodes(passcode), 'KEYCODE_ENTER'], {
        allowFail: true,
        timeoutMs: 12_000,
      });
      if (res.code !== 0) {
        const clean = redactSecretStrings(res.stderr.trim(), [passcode]);
        throw new PhoneDockError(
          'Couldn’t enter the PIN on the Android device',
          'unlock_failed',
          502,
          ['On some OEMs (Xiaomi/MIUI, vivo, OPPO), enable "USB debugging (Security settings)" in Developer options.'],
          clean || `adb input keyevent exited ${res.code}`,
        );
      }
    } else {
      const escaped = A.escapeInputText(passcode);
      const res = await adbRun(serial, ['shell', 'input', 'text', escaped], { allowFail: true, timeoutMs: 12_000 });
      if (res.code !== 0) {
        const clean = redactSecretStrings(res.stderr.trim(), [passcode, escaped]);
        throw new PhoneDockError(
          'Couldn’t enter the password on the Android device',
          'unlock_failed',
          502,
          ['On some OEMs (Xiaomi/MIUI, vivo, OPPO), enable "USB debugging (Security settings)" in Developer options.'],
          clean || `adb input text exited ${res.code}`,
        );
      }
      await wait(150);
      await adbRun(serial, ['shell', 'input', 'keyevent', 'KEYCODE_ENTER'], { allowFail: true, timeoutMs: 8_000 });
    }
  } catch (e) {
    if (e instanceof PhoneDockError) {
      e.message = redactSecretStrings(e.message, [passcode]);
      if (e.detail) e.detail = redactSecretStrings(e.detail, [passcode]);
      throw e;
    }
    throw new PhoneDockError(
      'Couldn’t enter the passcode on the Android device',
      'unlock_failed',
      502,
      undefined,
      redactSecretStrings((e as Error).message ?? String(e), [passcode]),
    );
  }

  // Poll lock state briefly to give Android time to verify the credential and dismiss the keyguard.
  for (let i = 0; i < 8; i++) {
    await wait(300);
    const st = await androidLockState(serial, adbRun);
    if (st.locked === false) {
      return { unlocked: true, method: isNumericPin ? 'android_pin' : 'android_password' };
    }
  }

  return { unlocked: false, reason: 'wrong_passcode' };
}
