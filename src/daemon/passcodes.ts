// Daemon-side unattended passcode unlock orchestration.
// - Wraps PasscodeStore (Keychain + 0600 metadata) with per-device serialized unlock locks.
// - Enforces the strict 1-failure circuit breaker so a changed passcode can never trigger device lockout/wipe.
// - Provides lightweight cached lock-state checks for Android devices ONLY when unattended unlock is active.
// - Never returns, logs, or leaks the passcode.
import { PasscodeStore, type PasscodeStatus, type PasscodeStoreOptions } from '../core/passcode-store.ts';
import { redactSecretStrings } from '../core/secrets.ts';
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
    if (d.capabilities.includes('unlock')) return { supported: true };
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
  }

  /** Serialize unlock & passcode mutations per device so concurrent requests never double-submit a passcode. */
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
        const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;
        await this.store.savePasscode(deviceId, body.passcode as string, { enabled });
        this.deps.logAction?.(deviceId, owner, { action: 'device.passcode_saved', enabled });
      } else if (typeof body.enabled === 'boolean') {
        this.store.setEnabled(deviceId, body.enabled);
        this.deps.logAction?.(deviceId, owner, { action: 'device.passcode_toggled', enabled: body.enabled });
      }
      return this.store.status(deviceId, support);
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

  async onDeviceDeleted(deviceId: string): Promise<void> {
    this.androidLockCache.delete(deviceId);
    await this.store.onDeviceDeleted(deviceId);
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
   *  Enforces lease, opt-in toggle, BFU safety, and 1-failure circuit breaker. */
  async unlock(
    deviceId: string,
    owner: string,
    opts: { auto?: boolean; skipLeaseCheck?: boolean } = {},
  ): Promise<UnlockResponse> {
    return this.withLock(deviceId, async () => {
      if (!opts.skipLeaseCheck) this.deps.checkLease(deviceId, owner);
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
        );
      }

      if (d.state !== 'running') {
        throw new PhoneDockError(
          `Device "${d.name}" is ${d.state}`,
          'not_running',
          409,
          ['Start or connect the device first.'],
        );
      }

      // Probe current lock state first so already-unlocked or swipe-only devices work smoothly.
      let state: LockStateInfo | undefined;
      if (typeof b.lockState === 'function') {
        state = await b.lockState(nativeId).catch(() => undefined);
      }

      if (state?.unlockedSinceBoot === false) {
        this.store.recordOutcome(deviceId, { ok: false, error: 'Device has not been unlocked since reboot', trip: false });
        throw new PhoneDockError(
          'The device must be unlocked manually once after reboot',
          'before_first_unlock',
          409,
          ['Enter the passcode directly on the device once (request_human), then unattended unlock will work for future locks.'],
        );
      }

      if (state?.locked === false) {
        const res = await b.unlock(nativeId);
        this.androidLockCache.set(deviceId, { at: Date.now(), locked: false });
        return { ok: true, deviceId, ...res };
      }

      // Swipe-only lock screen on Android: unlock without touching any saved passcode.
      if (state?.locked === true && state.secure === false) {
        const res = await b.unlock(nativeId);
        if (res.unlocked) {
          this.androidLockCache.set(deviceId, { at: Date.now(), locked: false });
          this.deps.clearUiCache?.(deviceId);
          this.deps.logAction?.(deviceId, owner, { action: 'device.unlock', ok: true, method: res.method ?? 'dismiss_keyguard' });
          return { ok: true, deviceId, ...res };
        }
      }

      // Credentials required (or security unknown while locked): check saved passcode, opt-in toggle, and circuit breaker.
      const rec = this.store.getRecord(deviceId);
      if (!rec) {
        throw new PhoneDockError(
          'No passcode is saved for this device',
          'passcode_required',
          409,
          ['Save the device passcode in PhoneDock Device Settings (Unattended Unlock), or call request_human to have the user unlock it.'],
        );
      }
      if (rec.tripped) {
        throw new PhoneDockError(
          'Unattended unlock is paused after a failed attempt',
          'passcode_tripped',
          409,
          ['Re-save the device passcode in PhoneDock Device Settings to verify it and re-enable unattended unlock, or call request_human.'],
          rec.tripped.reason,
        );
      }
      const isHumanApp = owner === 'app:human';
      if (!rec.enabled && (opts.auto || !isHumanApp)) {
        throw new PhoneDockError(
          'Unattended unlock is turned off for this device',
          'unattended_unlock_disabled',
          403,
          ['Turn on "Allow agent to unlock" in PhoneDock Device Settings, or call request_human.'],
        );
      }

      const secret = await this.store.getSecret(deviceId);
      if (!secret) {
        throw new PhoneDockError(
          'Saved passcode is missing from Keychain',
          'passcode_missing',
          409,
          ['Re-save the passcode in PhoneDock Device Settings (Unattended Unlock).'],
        );
      }

      let res: UnlockResult;
      try {
        res = await b.unlock(nativeId, secret);
      } catch (e) {
        const cleanMsg = redactSecretStrings(e instanceof Error ? e.message : String(e), [secret]);
        if (e instanceof PhoneDockError) {
          e.message = cleanMsg;
          if (e.detail) e.detail = redactSecretStrings(e.detail, [secret]);
          if (e.hints) e.hints = e.hints.map((h) => redactSecretStrings(h, [secret]));
        }
        // Channel/transport errors do NOT trip the wrong-passcode breaker.
        this.store.recordOutcome(deviceId, { ok: false, error: cleanMsg, trip: false });
        this.deps.logAction?.(deviceId, owner, { action: 'device.unlock_failed', error: cleanMsg });
        throw e;
      }

      if (res.unlocked) {
        this.store.recordOutcome(deviceId, { ok: true, method: res.method });
        this.androidLockCache.set(deviceId, { at: Date.now(), locked: false });
        this.deps.clearUiCache?.(deviceId);
        this.deps.logAction?.(deviceId, owner, { action: 'device.unlock', ok: true, method: res.method ?? 'passcode', ...(opts.auto ? { auto: true } : {}) });
        return { ok: true, deviceId, ...res };
      }

      if (res.reason === 'before_first_unlock') {
        this.store.recordOutcome(deviceId, { ok: false, error: 'Before first unlock after reboot', trip: false });
        throw new PhoneDockError(
          'The device must be unlocked manually once after reboot',
          'before_first_unlock',
          409,
          ['Unlock the device manually once, then unattended unlock will work for future locks.'],
        );
      }

      // Keystrokes were entered and the device stayed locked: TRIP THE 1-FAILURE CIRCUIT BREAKER immediately.
      const tripReason = 'Device remained locked after entering the saved passcode; unattended unlock paused to prevent lockout.';
      this.store.recordOutcome(deviceId, { ok: false, error: tripReason, trip: true, tripReason });
      this.androidLockCache.set(deviceId, { at: Date.now(), locked: true });
      this.deps.logAction?.(deviceId, owner, { action: 'device.unlock_failed', reason: res.reason ?? 'wrong_passcode', tripped: true });
      throw new PhoneDockError(
        'Saved passcode did not unlock the device — unattended unlock paused',
        'passcode_tripped',
        409,
        ['Check the passcode and re-save it in PhoneDock Device Settings to re-enable unattended unlock, or call request_human.'],
        tripReason,
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
