// Per-device saved passcode store for unattended unlock.
// Passcodes are stored in macOS Keychain via `security -i` (stdin only, hex-encoded via `-X`, never in process argv)
// with a mode-0600 file fallback on non-macOS systems. Non-secret metadata (enabled flag, circuit-breaker tripped state,
// last unlock outcome) lives in stateDir()/passcodes.json (mode 0600).
// Passcodes are NEVER returned by any API, NEVER logged, and NEVER echoed in errors.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { run, type RunOptions } from './exec.ts';
import { stateDir } from './paths.ts';
import { redactSecretStrings } from './secrets.ts';
import { PhoneDockError, type ExecResult } from './types.ts';

export type PasscodeStorage = 'keychain' | 'file';

export interface PasscodeTripped {
  at: string;
  reason: string;
}

export interface PasscodeUnlockOutcome {
  at: string;
  ok: boolean;
  method?: string;
  error?: string;
}

export interface PasscodeMetaRecord {
  deviceId: string;
  enabled: boolean;
  savedAt: string;
  storage: PasscodeStorage;
  tripped: PasscodeTripped | null;
  lastUnlock: PasscodeUnlockOutcome | null;
}

/** Public, redacted status returned by GET /v1/devices/:id/passcode and device.meta.passcode. Never contains the secret. */
export interface PasscodeStatus {
  supported: boolean;
  reason?: string;
  hasPasscode: boolean;
  enabled: boolean;
  storage?: PasscodeStorage;
  savedAt?: string;
  tripped: PasscodeTripped | null;
  lastUnlock: PasscodeUnlockOutcome | null;
}

export interface SecretStore {
  readonly storageName: PasscodeStorage;
  set(account: string, secret: string): Promise<void>;
  get(account: string): Promise<string | null>;
  del(account: string): Promise<void>;
}

const MAX_PASSCODE_LEN = 128;

/** Validate a device passcode/PIN. Printable ASCII only (matches Android input keyevent/text and iOS HID keyboard). */
export function validatePasscode(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new PhoneDockError('Passcode must be a string', 'bad_request', 400);
  }
  if (!raw.length) {
    throw new PhoneDockError('Passcode cannot be empty', 'bad_request', 400);
  }
  if (raw.length > MAX_PASSCODE_LEN) {
    throw new PhoneDockError(`Passcode is too long (max ${MAX_PASSCODE_LEN} characters)`, 'bad_request', 400);
  }
  if (!/^[\x20-\x7e]+$/.test(raw)) {
    throw new PhoneDockError(
      'Passcode must contain printable ASCII characters only',
      'bad_request',
      400,
      ['Use digits or standard ASCII letters/symbols without newlines.'],
    );
  }
  return raw;
}

/** Stable, shell/parser-safe account key for Keychain (`security -i` never sees device IDs with spaces or quotes). */
export function keychainAccount(deviceId: string): string {
  return createHash('sha256').update(`phonedock-passcode:${deviceId}`).digest('hex').slice(0, 32);
}

/** Keychain service name. Isolated per custom PHONEDOCK_HOME so tests never touch the user's real Keychain items. */
export function keychainService(baseDir = stateDir()): string {
  const customHome = process.env.PHONEDOCK_HOME?.trim();
  const explicit = process.env.PHONEDOCK_PASSCODE_SERVICE?.trim();
  if (explicit && /^[A-Za-z0-9._-]+$/.test(explicit)) return explicit;
  if (!customHome) return 'com.phonedock.passcode';
  const suffix = createHash('sha256').update(baseDir).digest('hex').slice(0, 12);
  return `com.phonedock.passcode.${suffix}`;
}

export type ExecFn = (cmd: string, args: string[], opts?: RunOptions) => Promise<ExecResult>;

/** macOS Keychain secret store using `/usr/bin/security`. Writes go via `security -i` stdin with `-X <hex>` so the
 *  passcode never appears in process argv (`ps`). */
export function createKeychainSecretStore(service: string, execFn: ExecFn = run): SecretStore {
  if (!/^[A-Za-z0-9._-]+$/.test(service)) {
    throw new PhoneDockError('Invalid Keychain service name', 'internal', 500);
  }
  return {
    storageName: 'keychain',
    async set(account: string, secret: string): Promise<void> {
      const hex = Buffer.from(secret, 'utf8').toString('hex');
      const line = `add-generic-password -U -s ${service} -a ${account} -X ${hex}\n`;
      const r = await execFn('/usr/bin/security', ['-i'], {
        input: line,
        allowFail: true,
        timeoutMs: 15_000,
        failureMessage: 'Couldn’t save passcode to macOS Keychain',
      });
      // `security -i` can exit 0 even when a subcommand writes an error to stderr.
      const errOut = r.stderr.trim();
      if (r.code !== 0 || /\bsecurity:\s*SecKeychain|\berror\b/i.test(errOut)) {
        const clean = redactSecretStrings(errOut, [secret, hex]).slice(0, 400);
        throw new PhoneDockError(
          'Couldn’t save passcode to macOS Keychain',
          'keychain_failed',
          500,
          ['Unlock your macOS login keychain and try again.'],
          clean || `security exited ${r.code}`,
        );
      }
    },
    async get(account: string): Promise<string | null> {
      const r = await execFn('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
        allowFail: true,
        timeoutMs: 15_000,
      });
      if (r.code === 44 || /could not be found/i.test(r.stderr)) return null;
      if (r.code !== 0) {
        throw new PhoneDockError(
          'Couldn’t read passcode from macOS Keychain',
          'keychain_failed',
          500,
          ['Unlock your macOS login keychain and try again.'],
          r.stderr.trim().slice(0, 400) || `security exited ${r.code}`,
        );
      }
      const val = r.stdout.replace(/\r?\n$/, '');
      // macOS `security find-generic-password -w` prints raw bytes if printable UTF-8, or hex when stored as non-UTF-8.
      // Printable ASCII written via `-X` is returned as plain ASCII by macOS security.
      return val.length ? val : null;
    },
    async del(account: string): Promise<void> {
      const r = await execFn('/usr/bin/security', ['delete-generic-password', '-s', service, '-a', account], {
        allowFail: true,
        timeoutMs: 15_000,
      });
      if (r.code === 0 || r.code === 44 || /could not be found/i.test(r.stderr)) return;
      throw new PhoneDockError(
        'Couldn’t remove passcode from macOS Keychain',
        'keychain_failed',
        500,
        undefined,
        r.stderr.trim().slice(0, 400) || `security exited ${r.code}`,
      );
    },
  };
}

/** Mode-0600 JSON secret store fallback (used on Linux / non-macOS and unit tests). */
export function createFileSecretStore(filePath: string): SecretStore {
  const readMap = (): Record<string, string> => {
    try {
      if (!existsSync(filePath)) return {};
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
    } catch { return {}; }
  };
  const writeMap = (map: Record<string, string>): void => {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(map, null, 2) + '\n', { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch { /* ignore */ }
    renameSync(tmp, filePath);
    try { chmodSync(filePath, 0o600); } catch { /* ignore */ }
  };
  return {
    storageName: 'file',
    async set(account: string, secret: string): Promise<void> {
      const map = readMap();
      map[account] = secret;
      writeMap(map);
    },
    async get(account: string): Promise<string | null> {
      const map = readMap();
      return typeof map[account] === 'string' && map[account].length > 0 ? map[account] : null;
    },
    async del(account: string): Promise<void> {
      const map = readMap();
      if (!(account in map)) return;
      delete map[account];
      writeMap(map);
    },
  };
}

export function defaultSecretStore(baseDir = stateDir()): SecretStore {
  if (process.platform === 'darwin' && existsSync('/usr/bin/security')) {
    return createKeychainSecretStore(keychainService(baseDir));
  }
  return createFileSecretStore(join(baseDir, 'passcodes.secrets.json'));
}

interface StoredMetaFile {
  v: 1;
  devices: Record<string, PasscodeMetaRecord>;
}

export interface PasscodeStoreOptions {
  metaPath?: string;
  secretStore?: SecretStore;
  now?: () => string;
  onChange?: (deviceId: string) => void;
}

export class PasscodeStore {
  private readonly metaPath: string;
  private readonly secrets: SecretStore;
  private readonly now: () => string;
  private readonly onChange?: (deviceId: string) => void;
  private records: Record<string, PasscodeMetaRecord>;

  constructor(opts: PasscodeStoreOptions = {}) {
    const base = stateDir();
    this.metaPath = opts.metaPath ?? join(base, 'passcodes.json');
    this.secrets = opts.secretStore ?? defaultSecretStore(base);
    this.now = opts.now ?? (() => new Date().toISOString());
    this.onChange = opts.onChange;
    this.records = this.load();
  }

  private load(): Record<string, PasscodeMetaRecord> {
    try {
      if (!existsSync(this.metaPath)) return {};
      const parsed = JSON.parse(readFileSync(this.metaPath, 'utf8')) as Partial<StoredMetaFile>;
      if (parsed?.v === 1 && parsed.devices && typeof parsed.devices === 'object') {
        const out: Record<string, PasscodeMetaRecord> = {};
        for (const [id, r] of Object.entries(parsed.devices)) {
          if (!r || typeof r !== 'object') continue;
          out[id] = {
            deviceId: id,
            enabled: Boolean(r.enabled),
            savedAt: typeof r.savedAt === 'string' ? r.savedAt : this.now(),
            storage: r.storage === 'keychain' ? 'keychain' : 'file',
            tripped: r.tripped && typeof r.tripped.at === 'string' && typeof r.tripped.reason === 'string'
              ? { at: r.tripped.at, reason: r.tripped.reason } : null,
            lastUnlock: r.lastUnlock && typeof r.lastUnlock.at === 'string' && typeof r.lastUnlock.ok === 'boolean'
              ? {
                  at: r.lastUnlock.at,
                  ok: r.lastUnlock.ok,
                  ...(typeof r.lastUnlock.method === 'string' ? { method: r.lastUnlock.method } : {}),
                  ...(typeof r.lastUnlock.error === 'string' ? { error: r.lastUnlock.error } : {}),
                }
              : null,
          };
        }
        return out;
      }
    } catch { /* ignore corrupt file */ }
    return {};
  }

  private persist(): void {
    mkdirSync(dirname(this.metaPath), { recursive: true, mode: 0o700 });
    const tmp = `${this.metaPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const payload: StoredMetaFile = { v: 1, devices: this.records };
    writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch { /* ignore */ }
    renameSync(tmp, this.metaPath);
    try { chmodSync(this.metaPath, 0o600); } catch { /* ignore */ }
  }

  /** Sanitized status for API / device.meta. Never exposes the passcode. */
  status(deviceId: string, support: { supported: boolean; reason?: string }): PasscodeStatus {
    const rec = this.records[deviceId];
    return {
      supported: support.supported,
      ...(support.reason ? { reason: support.reason } : {}),
      hasPasscode: Boolean(rec),
      enabled: Boolean(rec?.enabled && !rec?.tripped),
      ...(rec ? { storage: rec.storage, savedAt: rec.savedAt } : {}),
      tripped: rec?.tripped ?? null,
      lastUnlock: rec?.lastUnlock ?? null,
    };
  }

  /** Fast check: should PhoneDock auto-unlock this device when an input sees it locked? */
  isAutoUnlockReady(deviceId: string): boolean {
    const rec = this.records[deviceId];
    return Boolean(rec && rec.enabled && !rec.tripped);
  }

  /** Save or update a device's passcode. Clears any previous circuit-breaker trip. */
  async savePasscode(deviceId: string, rawPasscode: string, opts: { enabled?: boolean } = {}): Promise<PasscodeMetaRecord> {
    const passcode = validatePasscode(rawPasscode);
    const acct = keychainAccount(deviceId);
    await this.secrets.set(acct, passcode);
    const prev = this.records[deviceId];
    const rec: PasscodeMetaRecord = {
      deviceId,
      enabled: opts.enabled ?? true,
      savedAt: this.now(),
      storage: this.secrets.storageName,
      tripped: null,
      lastUnlock: prev?.lastUnlock ?? null,
    };
    this.records[deviceId] = rec;
    this.persist();
    this.onChange?.(deviceId);
    return rec;
  }

  /** Toggle unattended unlock on/off for a device that already has a saved passcode. */
  setEnabled(deviceId: string, enabled: boolean): PasscodeMetaRecord {
    const rec = this.records[deviceId];
    if (!rec) {
      throw new PhoneDockError(
        'Save a passcode for this device first',
        'passcode_not_set',
        400,
        ['Save a passcode in PhoneDock Device Settings or run `phonedock passcode set <device>`.'],
      );
    }
    if (enabled && rec.tripped) {
      throw new PhoneDockError(
        'Passcode unlock is paused after a failed attempt',
        'passcode_tripped',
        409,
        ['Re-enter and save the device passcode to verify it and re-enable unattended unlock.'],
        rec.tripped.reason,
      );
    }
    rec.enabled = enabled;
    this.persist();
    this.onChange?.(deviceId);
    return rec;
  }

  /** Delete saved passcode from Keychain and remove metadata. */
  async remove(deviceId: string): Promise<boolean> {
    const existed = Boolean(this.records[deviceId]);
    await this.secrets.del(keychainAccount(deviceId));
    if (existed) {
      delete this.records[deviceId];
      this.persist();
      this.onChange?.(deviceId);
    }
    return existed;
  }

  /** Internal daemon-only lookup. Never return this value over HTTP/MCP/CLI. */
  async getSecret(deviceId: string): Promise<string | null> {
    const rec = this.records[deviceId];
    if (!rec) return null;
    return this.secrets.get(keychainAccount(deviceId));
  }

  getRecord(deviceId: string): PasscodeMetaRecord | undefined {
    return this.records[deviceId];
  }

  /** Record unlock outcome. When `trip: true`, immediately trips the 1-failure circuit breaker and disables auto-unlock. */
  recordOutcome(deviceId: string, outcome: { ok: boolean; method?: string; error?: string; trip?: boolean; tripReason?: string }): void {
    const rec = this.records[deviceId];
    if (!rec) return;
    const at = this.now();
    rec.lastUnlock = {
      at,
      ok: outcome.ok,
      ...(outcome.method ? { method: outcome.method } : {}),
      ...(outcome.error ? { error: outcome.error.slice(0, 300) } : {}),
    };
    if (outcome.ok) {
      rec.tripped = null;
    } else if (outcome.trip) {
      rec.tripped = {
        at,
        reason: (outcome.tripReason ?? outcome.error ?? 'Device stayed locked after entering the saved passcode').slice(0, 300),
      };
      rec.enabled = false;
    }
    this.persist();
    this.onChange?.(deviceId);
  }

  async onDeviceDeleted(deviceId: string): Promise<void> {
    await this.remove(deviceId).catch(() => undefined);
  }
}
