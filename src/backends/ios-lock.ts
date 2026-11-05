// Input on a locked iPhone lands on the Lock Screen (or does nothing), and an agent that can't tell keeps tapping and
// looks broken. So pointer and text input to a real iPhone first checks whether it is locked, and refuses with
// device_locked: the agent hands the phone to the person (request_human) instead of tapping blind.
// The check (`devicectl device info lockState`, 0.6-1.1 s over Wi-Fi) must not slow every tap down:
// - the first input to a phone waits for one check;
// - after that the last answer stands, and a stale one (older than TTL_MS) is refreshed in the background for the
//   next input, so a phone that locks mid-session is caught within one input after the refresh lands;
// - a phone last seen locked is checked again before each input, so it works the moment the person unlocks it.
import { PhoneDockError } from '../core/types.ts';

export const LOCK_TTL_MS = 10_000;

/** probe: true = locked now, false = unlocked, null = unknown (never refuses). */
export type LockProbe = (udid: string) => Promise<boolean | null>;

export function lockedError(): PhoneDockError {
  return new PhoneDockError('The iPhone is locked', 'device_locked', 409,
    ['Ask the person to unlock the iPhone (request_human), then try again.'],
    'devicectl lockState: passcodeRequired. Input on a locked iPhone lands on the Lock Screen, so PhoneDock didn’t send it.');
}

export function lockGuard(probe: LockProbe, now: () => number = Date.now, ttlMs = LOCK_TTL_MS) {
  const seen = new Map<string, { checked: boolean; at: number; locked: boolean | null; pending?: Promise<boolean | null> }>();
  const check = (udid: string): Promise<boolean | null> => {
    const e = seen.get(udid) ?? { checked: false, at: 0, locked: null };
    seen.set(udid, e);
    if (!e.pending) {
      e.pending = probe(udid).catch(() => null)
        .then((v) => { e.locked = v; e.at = now(); e.checked = true; return v; })
        .finally(() => { e.pending = undefined; });
    }
    return e.pending;
  };
  return {
    /** Throws device_locked, having sent nothing, when the phone is (or was last seen) locked. */
    async refuseIfLocked(udid: string): Promise<void> {
      const e = seen.get(udid);
      let locked: boolean | null;
      if (!e?.checked) locked = await check(udid);                      // first input: one check
      else if (e.locked === true) locked = await check(udid);           // maybe unlocked since: check again
      else { locked = e.locked; if (now() - e.at > ttlMs) void check(udid); }   // stale: refresh for the next input
      if (locked === true) throw lockedError();
    },
    /** Forget what is known (tests; a phone that was disconnected). */
    reset(udid?: string) { if (udid) seen.delete(udid); else seen.clear(); },
  };
}
