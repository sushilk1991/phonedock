// Android lock-state detection and unattended unlock over adb (real Android phones and Android emulators).
// Security invariants:
// - Credentials are NEVER placed in host process argv: PIN and password input go strictly over `adb -s <serial> shell sh -s` stdin.
// - Literal `%s` inside passwords is split across `input text` calls so Android's InputShellCommand does not turn it into a space.
// - Checks foreground user (`am get-current-user`) for both AFU (`sys.user.<id>.ce_available`) and `dumpsys trust` scoping.
// - Re-verifies the lock screen is still active and awake immediately before calling `beforeDispatch` / typing.
// - Never echoes raw stderr, command args, or credential text in errors.
import { sleep } from '../core/exec.ts';
import { PhoneDockError, type ExecResult, type LockStateInfo, type UnlockResult } from '../core/types.ts';
import * as A from './android-common.ts';

export type AdbRunner = (
  serial: string,
  args: string[],
  opts?: { allowFail?: boolean; timeoutMs?: number; input?: string | Buffer },
) => Promise<ExecResult>;

export interface AndroidUnlockDeps {
  adb?: AdbRunner;
  screenSize?: (serial: string) => Promise<{ width: number; height: number }>;
  wait?: (ms: number) => Promise<void>;
  beforeDispatch?: () => void | Promise<void>;
}

/** Extract only the `dumpsys trust` lines belonging to `userId` so a locked work profile (e.g. user 10)
 *  never overrides an unlocked foreground user (e.g. user 0). */
function trustSectionForUser(trustDump: string, userId: string): string {
  if (!trustDump.trim()) return '';
  const lines = trustDump.split('\n');
  const headerRe = new RegExp(`^\\s*User\\s+"?[^"]*"?\\s*\\(id=${userId}\\b|^\\s*User\\s+${userId}\\b`, 'i');
  const anyUserRe = /^\s*User\s+/i;
  const scoped: string[] = [];
  let inTarget = false;
  let sawAnyUser = false;
  for (const line of lines) {
    if (anyUserRe.test(line)) {
      sawAnyUser = true;
      inTarget = headerRe.test(line);
      if (inTarget) scoped.push(line);
      continue;
    }
    if (inTarget) scoped.push(line);
  }
  return sawAnyUser ? scoped.join('\n') : trustDump;
}

/** Parse Android lock/screen/security state from `dumpsys window policy`, `dumpsys power`, `dumpsys trust`,
 *  and `getprop sys.user.<uid>.ce_available`. Pure function for unit tests. */
export function parseAndroidLockState(input: {
  window?: string;
  power?: string;
  trust?: string;
  ceAvailable?: string;
  userId?: string;
}): LockStateInfo {
  const win = input.window ?? '';
  const pwr = input.power ?? '';
  const uid = (input.userId ?? '0').trim() || '0';
  const trust = trustSectionForUser(input.trust ?? '', uid);
  const ce = (input.ceAvailable ?? '').trim().toLowerCase();

  let screenOn: boolean | null = null;
  if (/mWakefulness=Awake\b/i.test(pwr) || /Display Power:\s*state=ON\b/i.test(pwr) || /mInteractive=true\b/i.test(pwr)) {
    screenOn = true;
  } else if (/mWakefulness=(?:Asleep|Dozing)\b/i.test(pwr) || /Display Power:\s*state=OFF\b/i.test(pwr) || /mInteractive=false\b/i.test(pwr)) {
    screenOn = false;
  }

  let unlockedSinceBoot: boolean | null = null;
  if (ce === 'true' || ce === '1') unlockedSinceBoot = true;
  else if (ce === 'false' || ce === '0') unlockedSinceBoot = false;

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

  let secure: boolean | null = null;
  if (/\bmIsSecure=true\b/i.test(win) || /\bisKeyguardSecure=true\b/i.test(win) || /\bsecure=true\b/i.test(win) || /\bdeviceLocked=1\b/i.test(trust)) {
    secure = true;
  } else if (/\bmIsSecure=false\b/i.test(win) || /\bisKeyguardSecure=false\b/i.test(win) || /\bsecure=false\b/i.test(win)) {
    secure = false;
  }

  return { locked, unlockedSinceBoot, secure, screenOn };
}

/** Query the current Android foreground user's lock state in a single shell round-trip. */
export async function androidLockState(serial: string, adbRun: AdbRunner = A.adb): Promise<LockStateInfo> {
  const script = [
    'UID=$(am get-current-user 2>/dev/null | tr -dc "0-9")',
    '[ -n "$UID" ] || UID=0',
    'echo "===UID==="',
    'echo "$UID"',
    'echo "===CE==="',
    'getprop "sys.user.${UID}.ce_available"',
    'echo "===PWR==="',
    'dumpsys power | grep -E "mWakefulness=|Display Power:|mInteractive=" | head -n 10',
    'echo "===WIN==="',
    'dumpsys window policy | grep -E "mShowingLockscreen|isStatusBarKeyguard|mDreamingLockscreen|showing=|mIsSecure|isKeyguardSecure|secure=" | head -n 20',
    'echo "===TRUST==="',
    'dumpsys trust | grep -E "User |deviceLocked=|locked=" | head -n 40',
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
    userId: section('UID', 'CE') || '0',
    ceAvailable: section('CE', 'PWR'),
    power: section('PWR', 'WIN'),
    window: section('WIN', 'TRUST'),
    trust: section('TRUST'),
  });
}

/** Split an alphanumeric password into chunks so no chunk contains literal `%s` (which Android's `input text`
 *  rewrites into a space). Each chunk is then shell-quoted and sent as its own `input text` line over `sh -s` stdin. */
export function buildAndroidCredentialScript(passcode: string): string {
  if (/^\d+$/.test(passcode)) {
    const keys = [...passcode].map((d) => `KEYCODE_${d}`).join(' ');
    return `input keyevent ${keys} KEYCODE_ENTER\n`;
  }
  const chunks: string[] = [];
  let cur = '';
  for (let i = 0; i < passcode.length; i++) {
    const ch = passcode[i];
    if (ch === 's' && cur.endsWith('%')) {
      chunks.push(cur);
      cur = 's';
    } else {
      cur += ch;
    }
  }
  if (cur.length) chunks.push(cur);
  const lines = chunks.map((chunk) => `input text ${A.shQuote(chunk.replace(/ /g, '%s'))}`);
  lines.push('input keyevent KEYCODE_ENTER');
  return lines.join(' && ') + '\n';
}

/** Unlock an Android phone or emulator.
 *  - Requires affirmative AFU (`unlockedSinceBoot === true`) before entering credentials.
 *  - Re-verifies the lock screen is still showing and awake right before calling `beforeDispatch` and sending credentials.
 *  - Sends credentials strictly over `adb -s <serial> shell sh -s` stdin (zero credentials in host argv).
 *  - Never retries a failed credential and never echoes secrets or raw stderr in errors. */
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

  // Try credential-free keyguard dismissal first (handles swipe-only locks and Smart Lock / face-unlock-on-wake).
  await adbRun(serial, ['shell', 'wm', 'dismiss-keyguard'], { allowFail: true, timeoutMs: 8_000 });
  await wait(350);
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

  // Re-verify lock state immediately before dispatch: never type credentials into an unlocked app or an asleep/unknown screen.
  const preDispatch = await androidLockState(serial, adbRun);
  if (preDispatch.locked === false) {
    return { unlocked: true, method: 'swipe_unlock' };
  }

  if (!passcode) {
    if (preDispatch.secure === false) {
      return { unlocked: false, reason: 'still_locked' };
    }
    throw new PhoneDockError(
      'The Android device is locked and requires a passcode',
      'passcode_required',
      409,
      ['Save a passcode in PhoneDock Device Settings (Unattended Unlock) or unlock the phone manually.'],
      undefined,
      'not_sent',
    );
  }

  if (preDispatch.unlockedSinceBoot !== true) {
    return { unlocked: false, reason: 'before_first_unlock' };
  }
  if (preDispatch.locked !== true || preDispatch.screenOn === false) {
    throw new PhoneDockError(
      'Couldn’t confirm the Android lock screen is ready for passcode entry',
      'unlock_failed',
      502,
      ['Wake the device and try again, or unlock it manually.'],
      'Lock-screen state was uncertain before credential dispatch.',
      'not_sent',
    );
  }

  // Atomically reserve the one-shot attempt BEFORE any credential byte leaves the host.
  await deps.beforeDispatch?.();

  const isNumericPin = /^\d+$/.test(passcode);
  const script = buildAndroidCredentialScript(passcode);
  let dispatchFailed = false;
  try {
    const res = await adbRun(serial, ['shell', 'sh', '-s'], {
      input: script,
      allowFail: true,
      timeoutMs: 12_000,
    });
    if (res.code !== 0) dispatchFailed = true;
  } catch {
    dispatchFailed = true;
  }

  // Poll lock state to confirm whether the credential unlocked the device.
  let sawLocked = false;
  for (let i = 0; i < 8; i++) {
    await wait(300);
    const st = await androidLockState(serial, adbRun).catch(() => ({ locked: null } as LockStateInfo));
    if (st.locked === false) {
      return { unlocked: true, method: isNumericPin ? 'android_pin' : 'android_password' };
    }
    if (st.locked === true) sawLocked = true;
  }

  if (dispatchFailed || !sawLocked) {
    return { unlocked: false, reason: 'unlock_unverified' };
  }
  return { unlocked: false, reason: 'wrong_passcode' };
}
