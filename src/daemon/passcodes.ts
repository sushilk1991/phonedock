// Daemon-side unattended passcode unlock orchestration.
// - Backed by PasscodeStore (Keychain + shared SQLite WAL metadata with atomic pending-attempt reservation).
// - Enforces the strict 1-failure / 1-ambiguous-attempt circuit breaker across crashes and multiple daemons.
// - Never returns, logs, or leaks raw exception stacks or credentials.
import { PasscodeStore, type PasscodeStatus, type PasscodeStoreOptions } from '../core/passcode-store.ts';
import { PhoneDockError, type Backend, type Device, type LockStateInfo, type UnlockResult } from '../core/types.ts';

export interface PasscodeDeps {
  emitEvent?: (event: string, data: unknown) => void;
  logAction?: (deviceId: string, owner: string, action: Record<string, unknown>) => void;
  invalidateDevices?: () => void;
  clearUiCache?: (deviceId: string) => void;
  getDevice: (id: string) => Promise<Device>;
  getBackend: (backendId: string) => Backend;
  splitId: (id: string) => { backend: string; nativeId: string };
  checkLease: (deviceId: string, owner: string) => void;
  storeOpts?: PasscodeStoreOptions;
}

export interface UnlockResponse extends UnlockResult {
  ok: true;
  deviceId: string;
}

export function passcodeSupportForDevice(
  d: Pick<Device, 'backend' | 'platform' | 'kind' | 'capabilities' | 'osVersion'>,
): { supported: boolean; reason?: string } {
  if (d.backend === 'ios-simulator') {
    return { supported: false, reason: 'iOS simulators do not have a lock screen passcode.' };
  }
  if (d.backend === 'ios-device') {
    const major = Number.parseInt(String(d.osVersion ?? '').split('.')[0], 10) || 0;
    if (d.capabilities.includes('unlock') || major >= 27) return { supported: true };
    return {
      supported: false,
      reason: 'iOS 18–26 blocks WebDriverAgent from entering passcodes. Turn off the passcode on this iPhone, or use an iPhone on iOS 27+.',
    };
  }
  if (d.backend === 'android-device' || d.backend === 'android-emulator') {
    return { supported: true };
  }
  if (d.capabilities.includes('unlock')) return { supported: true };
  return { supported: false, reason: `Unattended unlock is not supported on ${d.backend}.` };
}

const ANDROID_LOCK_TTL_MS = 1_500;

/** Convert any thrown error in a credential path into a safe allowlisted PhoneDockError (never exposing raw stderr/stacks). */
function safeCredentialError(e: unknown, fallbackMessage: string, fallbackCode: string, fallbackStatus: number, delivery: 'not_sent' | 'unknown'): PhoneDockError {
  if (e instanceof PhoneDockError) {
    return new PhoneDockError(e.message, e.code, e.status, e.hints, e.detail, e.delivery ?? delivery);
  }
  return new PhoneDockError(fallbackMessage, fallbackCode, fallbackStatus, undefined, undefined, delivery);
}

export class PasscodeManager {
  readonly store: PasscodeStore;
  private readonly deps: PasscodeDeps;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly androidLockCache = new Map<string, { at: number; locked: boolean | null; pending?: Promise<boolean | null> }>();

  constructor(deps: PasscodeDeps) {
    this.deps = deps;
    this.store = new PasscodeStore({
      ...deps.storeOpts,
      onChange: (deviceId) => {
        deps.storeOpts?.onChange?.(deviceId);
        deps.invalidateDevices?.();
        deps.emitEvent?.('passcode', { deviceId });
      },
    });
    void this.store.drainPendingDeletes().catch(() => undefined);
  }

  /** Serialize unlock & passcode mutations per device within this daemon (SQLite serializes across daemons). */
  private withLock<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(deviceId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.then(() => undefined, () => undefined);
    this.locks.set(deviceId, tail);
    void tail.finally(() => {
      if (this.locks.get(deviceId) === tail) this.locks.delete(deviceId);
    });
    return next;
  }

  /** Redacted device metadata attached onto Device.meta.passcode. */
  deviceMeta(d: Pick<Device, 'id' | 'backend' | 'platform' | 'kind' | 'capabilities' | 'osVersion'>): PasscodeStatus {
    return this.store.status(d.id, passcodeSupportForDevice(d));
  }

  async status(deviceId: string): Promise<PasscodeStatus> {
    const d = await this.deps.getDevice(deviceId);
    return this.store.status(d.id, passcodeSupportForDevice(d));
  }

  isAutoUnlockReady(deviceId: string): boolean {
    return this.store.isAutoUnlockReady(deviceId);
  }

  /** Save/update passcode and/or toggle unattended unlock. Agents (`mcp:*`) are blocked by routes-passcode.ts. */
  async configure(
    deviceId: string,
    body: { passcode?: unknown; enabled?: unknown },
    owner: string,
  ): Promise<PasscodeStatus> {
    return this.withLock(deviceId, async () => {
      try {
        const d = await this.deps.getDevice(deviceId);
        const support = passcodeSupportForDevice(d);
        if (!support.supported) {
          throw new PhoneDockError(
            'Unattended passcode unlock is not supported on this device',
            'not_supported',
            501,
            support.reason ? [support.reason] : undefined,
          );
        }
        const hasPasscodeInput = body.passcode !== undefined;
        const hasEnabledInput = body.enabled !== undefined;
        if (!hasPasscodeInput && !hasEnabledInput) {
          throw new PhoneDockError('Provide passcode and/or enabled', 'bad_request', 400);
        }
        if (hasEnabledInput && typeof body.enabled !== 'boolean') {
          throw new PhoneDockError('enabled must be a boolean', 'bad_request', 400);
        }
        if (hasPasscodeInput) {
          const rec = await this.store.savePasscode(
            deviceId,
            body.passcode as string,
            hasEnabledInput ? { enabled: body.enabled as boolean } : {},
          );
          this.deps.logAction?.(deviceId, owner, { action: 'device.passcode_saved', enabled: rec.enabled });
        } else if (typeof body.enabled === 'boolean') {
          this.store.setEnabled(deviceId, body.enabled);
          this.deps.logAction?.(deviceId, owner, { action: 'device.passcode_toggled', enabled: body.enabled });
        }
        return this.store.status(deviceId, support);
      } catch (e) {
        throw safeCredentialError(e, 'Couldn’t save passcode configuration', 'passcode_config_failed', 500, 'not_sent');
      }
    });
  }

  async remove(deviceId: string, owner: string): Promise<{ ok: true; removed: boolean }> {
    return this.withLock(deviceId, async () => {
      const removed = await this.store.remove(deviceId);
      this.androidLockCache.delete(deviceId);
      if (removed) this.deps.logAction?.(deviceId, owner, { action: 'device.passcode_removed' });
      return { ok: true, removed };
    });
  }

  /** Durably revoke the credential under the per-device lock BEFORE destroying a device so a replacement
   *  same-named AVD can never inherit the old credential. */
  async revokeBeforeDelete(deviceId: string): Promise<void> {
    await this.withLock(deviceId, async () => {
      this.androidLockCache.delete(deviceId);
      await this.store.remove(deviceId);
    });
  }

  invalidateLockCache(deviceId: string): void {
    this.androidLockCache.delete(deviceId);
  }

  /** Lightweight cached lock probe for Android devices when unattended unlock is active. Never runs when disabled. */
  async ensureUnlockedBeforeInput(deviceId: string, owner: string): Promise<void> {
    if (!this.isAutoUnlockReady(deviceId)) return;
    const { backend, nativeId } = this.deps.splitId(deviceId);
    if (backend !== 'android-device' && backend !== 'android-emulator') return;
    const b = this.deps.getBackend(backend);
    if (!b.lockState || !b.unlock) return;

    const now = Date.now();
    const cached = this.androidLockCache.get(deviceId);
    const probe = (): Promise<boolean | null> => {
      const entry = this.androidLockCache.get(deviceId) ?? { at: 0, locked: null };
      this.androidLockCache.set(deviceId, entry);
      if (!entry.pending) {
        entry.pending = b.lockState!(nativeId)
          .then((st) => st.locked)
          .catch(() => null)
          .then((v) => { entry.locked = v; entry.at = Date.now(); return v; })
          .finally(() => { entry.pending = undefined; });
      }
      return entry.pending;
    };

    let locked: boolean | null;
    if (!cached || cached.locked === true || now - cached.at > ANDROID_LOCK_TTL_MS) {
      locked = await probe();
    } else {
      locked = cached.locked;
    }

    if (locked === true) {
      await this.unlock(deviceId, owner, { auto: true, skipLeaseCheck: true });
    }
  }

  /** Unlock a device using its saved Keychain passcode (if credentials are required).
   *  Enforces lease, opt-in toggle, BFU safety, ownership fence, and atomic 1-failure / 1-ambiguous-attempt breaker. */
  async unlock(
    deviceId: string,
    owner: string,
    opts: { auto?: boolean; skipLeaseCheck?: boolean; assertOwnership?: () => void } = {},
  ): Promise<UnlockResponse> {
    return this.withLock(deviceId, async () => {
      if (!opts.skipLeaseCheck) this.deps.checkLease(deviceId, owner);
      opts.assertOwnership?.();
      const d = await this.deps.getDevice(deviceId);
      const support = passcodeSupportForDevice(d);
      const { backend, nativeId } = this.deps.splitId(deviceId);
      const b = this.deps.getBackend(backend);

      if (!support.supported || typeof b.unlock !== 'function') {
        throw new PhoneDockError(
          'Unattended unlock is not supported on this device',
          'not_supported',
          501,
          support.reason ? [support.reason] : undefined,
          undefined,
          'not_sent',
        );
      }

      if (d.state !== 'running') {
        throw new PhoneDockError(
          `Device "${d.name}" is ${d.state}`,
          'not_running',
          409,
          ['Start or connect the device first.'],
          undefined,
          'not_sent',
        );
      }

      // Probe current lock state first so already-unlocked or swipe-only devices work without touching Keychain.
      let state: LockStateInfo | undefined;
      if (typeof b.lockState === 'function') {
        state = await b.lockState(nativeId).catch(() => undefined);
      }

      if (state?.unlockedSinceBoot === false) {
        this.store.recordPreDispatchOutcome(deviceId, { ok: false, error: 'Device has not been unlocked since reboot' });
        throw new PhoneDockError(
          'The device must be unlocked manually once after reboot',
          'before_first_unlock',
          409,
          ['Enter the passcode directly on the device once (request_human), then unattended unlock will work for future locks.'],
          undefined,
          'not_sent',
        );
      }

      if (state?.locked === false) {
        const res = await b.unlock(nativeId);
        this.androidLockCache.set(deviceId, { at: Date.now(), locked: false });
        return { ok: true, deviceId, ...res };
      }

      // Swipe-only or unknown-security confirmed keyguard on Android: try credential-free dismissal first.
      if (state?.locked === true && (state.secure === false || state.secure === null) && (backend === 'android-device' || backend === 'android-emulator')) {
        try {
          const res = await b.unlock(nativeId, undefined);
          if (res.unlocked) {
            this.androidLockCache.set(deviceId, { at: Date.now(), locked: false });
            this.deps.clearUiCache?.(deviceId);
            this.deps.logAction?.(deviceId, owner, { action: 'device.unlock', ok: true, method: res.method ?? 'dismiss_keyguard' });
            return { ok: true, deviceId, ...res };
          }
        } catch (e) {
          // If backend reported passcode_required, continue to saved-passcode path below.
          if (!(e instanceof PhoneDockError && e.code === 'passcode_required')) {
            throw safeCredentialError(e, 'Couldn’t dismiss the lock screen', 'unlock_failed', 502, 'not_sent');
          }
        }
      }

      // Credentials required: validate latest shared SQLite state BEFORE reading Keychain.
      const rec = this.store.getRecord(deviceId);
      if (!rec) {
        throw new PhoneDockError(
          'No passcode is saved for this device',
          'passcode_required',
          409,
          ['Save the device passcode in PhoneDock Device Settings (Unattended Unlock), or call request_human to have the user unlock it.'],
          undefined,
          'not_sent',
        );
      }
      if (rec.tripped || rec.pending) {
        throw new PhoneDockError(
          'Unattended unlock is paused after a failed or unfinished attempt',
          'passcode_tripped',
          409,
          ['Re-save the device passcode in PhoneDock Device Settings to verify it and re-enable unattended unlock, or call request_human.'],
          rec.tripped?.reason,
          'not_sent',
        );
      }
      if (!rec.enabled) {
        throw new PhoneDockError(
          'Unattended unlock is turned off for this device',
          'unattended_unlock_disabled',
          403,
          ['Turn on "Allow agent to unlock" in PhoneDock Device Settings, or call request_human.'],
          undefined,
          'not_sent',
        );
      }

      let secret: string | null;
      try {
        secret = await this.store.getSecret(deviceId);
      } catch (e) {
        throw safeCredentialError(e, 'Couldn’t read passcode from Keychain', 'keychain_failed', 500, 'not_sent');
      }
      if (!secret) {
        throw new PhoneDockError(
          'Saved passcode is missing from Keychain',
          'passcode_missing',
          409,
          ['Re-save the passcode in PhoneDock Device Settings (Unattended Unlock).'],
          undefined,
          'not_sent',
        );
      }

      // Reserve the one-shot attempt atomically inside SQLite right before the first credential byte leaves,
      // re-checking ownership and shared permission state at the dispatch boundary.
      let attemptId: string | undefined;
      let res: UnlockResult;
      try {
        res = await b.unlock(nativeId, secret, {
          beforeDispatch: () => {
            if (!opts.skipLeaseCheck) this.deps.checkLease(deviceId, owner);
            opts.assertOwnership?.();
            attemptId = this.store.reserveAttempt(deviceId);
          },
        });
      } catch (e) {
        const delivery = attemptId ? 'unknown' : 'not_sent';
        const safe = safeCredentialError(e, 'Couldn’t complete the unlock operation', 'unlock_failed', 502, delivery);
        if (attemptId) {
          // Credential bytes may have left the host: keep the device paused across restarts/daemons.
          this.store.completeAttempt(deviceId, attemptId, {
            ok: false,
            error: safe.message,
            tripReason: 'Unlock attempt ended unexpectedly after credential dispatch; unattended unlock paused to prevent lockout.',
          });
          this.deps.logAction?.(deviceId, owner, { action: 'device.unlock_failed', reason: 'unlock_unverified', tripped: true });
        } else {
          this.store.recordPreDispatchOutcome(deviceId, { ok: false, error: safe.message });
          this.deps.logAction?.(deviceId, owner, { action: 'device.unlock_failed', error: safe.message });
        }
        throw safe;
      }

      if (res.unlocked) {
        if (attemptId) {
          this.store.completeAttempt(deviceId, attemptId, { ok: true, method: res.method });
        } else {
          this.store.recordPreDispatchOutcome(deviceId, { ok: true, method: res.method });
        }
        this.androidLockCache.set(deviceId, { at: Date.now(), locked: false });
        this.deps.clearUiCache?.(deviceId);
        this.deps.logAction?.(deviceId, owner, { action: 'device.unlock', ok: true, method: res.method ?? 'passcode', ...(opts.auto ? { auto: true } : {}) });
        return { ok: true, deviceId, ...res };
      }

      if (res.reason === 'before_first_unlock' && !attemptId) {
        this.store.recordPreDispatchOutcome(deviceId, { ok: false, error: 'Before first unlock after reboot' });
        throw new PhoneDockError(
          'The device must be unlocked manually once after reboot',
          'before_first_unlock',
          409,
          ['Unlock the device manually once, then unattended unlock will work for future locks.'],
          undefined,
          'not_sent',
        );
      }

      // Credential was dispatched and either stayed locked (wrong_passcode) or could not be verified (unlock_unverified).
      const unverified = res.reason === 'unlock_unverified';
      const tripReason = unverified
        ? 'Unlock status could not be confirmed after credential dispatch; unattended unlock paused to prevent lockout.'
        : 'Device remained locked after entering the saved passcode; unattended unlock paused to prevent lockout.';
      if (attemptId) {
        this.store.completeAttempt(deviceId, attemptId, { ok: false, error: tripReason, tripReason });
      }
      this.androidLockCache.set(deviceId, { at: Date.now(), locked: true });
      this.deps.logAction?.(deviceId, owner, { action: 'device.unlock_failed', reason: res.reason ?? 'wrong_passcode', tripped: true });
      throw new PhoneDockError(
        unverified
          ? 'Couldn’t confirm device unlocked — unattended unlock paused'
          : 'Saved passcode did not unlock the device — unattended unlock paused',
        'passcode_tripped',
        409,
        ['Check the device and re-save the passcode in PhoneDock Device Settings to re-enable unattended unlock, or call request_human.'],
        tripReason,
        unverified ? 'unknown' : 'sent',
      );
    });
  }
}

let singleton: PasscodeManager | undefined;

export function initPasscodes(deps: PasscodeDeps): PasscodeManager {
  singleton = new PasscodeManager(deps);
  return singleton;
}

export function passcodeManager(): PasscodeManager {
  if (!singleton) {
    throw new PhoneDockError('Passcode manager is not initialized', 'internal', 500);
  }
  return singleton;
}

export function maybePasscodeManager(): PasscodeManager | undefined {
  return singleton;
}

export function setPasscodeManagerForTests(mgr?: PasscodeManager): void {
  singleton = mgr;
}
