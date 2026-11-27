// Per-device saved passcode store for unattended unlock.
// - Secrets live in macOS Keychain via `/usr/bin/security -i` (stdin only, hex-encoded via `-X`, never in process argv),
//   with a mode-0600 file fallback on non-macOS systems.
// - Non-secret metadata, circuit-breaker state, and in-flight pending-attempt reservations live in a shared SQLite WAL
//   database (`stateDir()/passcodes.sqlite`, mode 0600) with `BEGIN IMMEDIATE` transactions so multiple daemons sharing
//   one PHONEDOCK_HOME cannot overwrite each other or bypass a trip, revocation, or crash-interrupted attempt.
// - Passcodes are NEVER returned by any API, NEVER logged, and NEVER echoed in errors.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { run, type RunOptions } from './exec.ts';
import { stateDir } from './paths.ts';
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
  pending: { at: string; id: string } | null;
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
const DEFAULT_HOME_PATH = resolve(join(homedir(), 'Library', 'Application Support', 'PhoneDock'));

/** Validate a device passcode/PIN. Printable ASCII only (matches Android lock-screen input and iOS HID keyboard). */
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

/** Stable, parser-safe account key for Keychain (`security -i` never sees device IDs with spaces or quotes). */
export function keychainAccount(deviceId: string): string {
  return createHash('sha256').update(`phonedock-passcode:${deviceId}`).digest('hex').slice(0, 32);
}

/** Keychain service derived canonically from the resolved state directory path, regardless of whether PHONEDOCK_HOME
 *  was set explicitly to the default directory or left unset. */
export function keychainService(baseDir = stateDir()): string {
  const explicit = process.env.PHONEDOCK_PASSCODE_SERVICE?.trim();
  if (explicit && /^[A-Za-z0-9._-]+$/.test(explicit)) return explicit;
  const canonical = resolve(baseDir);
  if (canonical === DEFAULT_HOME_PATH) return 'com.phonedock.passcode';
  const suffix = createHash('sha256').update(canonical).digest('hex').slice(0, 12);
  return `com.phonedock.passcode.${suffix}`;
}

export type ExecFn = (cmd: string, args: string[], opts?: RunOptions) => Promise<ExecResult>;

/** macOS Keychain secret store using `/usr/bin/security`. Writes go via `security -i` stdin with `-X <hex>` so the
 *  passcode never appears in process argv (`ps`). Never echoes stderr or secrets in errors. */
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
        throw new PhoneDockError(
          'Couldn’t save passcode to macOS Keychain',
          'keychain_failed',
          500,
          ['Unlock your macOS login keychain and try again.'],
          `macOS Keychain write failed (exit ${r.code})`,
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
          `macOS Keychain read failed (exit ${r.code})`,
        );
      }
      const val = r.stdout.replace(/\r?\n$/, '');
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
        `macOS Keychain delete failed (exit ${r.code})`,
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

interface RawRow {
  deviceId: string;
  enabled: number;
  savedAt: string;
  storage: string;
  trippedAt: string | null;
  trippedReason: string | null;
  pendingAt: string | null;
  pendingId: string | null;
  lastUnlockAt: string | null;
  lastUnlockOk: number | null;
  lastUnlockMethod: string | null;
  lastUnlockError: string | null;
}

export interface PasscodeStoreOptions {
  dbPath?: string;
  secretStore?: SecretStore;
  now?: () => string;
  onChange?: (deviceId: string) => void;
}

const INTERRUPTED_REASON = 'Previous unlock attempt did not finish cleanly; unattended unlock paused to prevent lockout.';

export class PasscodeStore {
  private readonly dbPath: string;
  private readonly secrets: SecretStore;
  private readonly now: () => string;
  private readonly onChange?: (deviceId: string) => void;
  private db?: DatabaseSync;

  constructor(opts: PasscodeStoreOptions = {}) {
    const base = stateDir();
    this.dbPath = opts.dbPath ?? join(base, 'passcodes.sqlite');
    this.secrets = opts.secretStore ?? defaultSecretStore(base);
    this.now = opts.now ?? (() => new Date().toISOString());
    this.onChange = opts.onChange;
  }

  private database(): DatabaseSync {
    if (this.db) return this.db;
    if (this.dbPath !== ':memory:') {
      mkdirSync(dirname(this.dbPath), { recursive: true, mode: 0o700 });
    }
    const db = new DatabaseSync(this.dbPath);
    try {
      db.exec('PRAGMA busy_timeout=1000;');
      db.exec('PRAGMA journal_mode=WAL;');
      db.exec(`CREATE TABLE IF NOT EXISTS passcode_meta (
        deviceId TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        savedAt TEXT NOT NULL,
        storage TEXT NOT NULL,
        trippedAt TEXT,
        trippedReason TEXT,
        pendingAt TEXT,
        pendingId TEXT,
        lastUnlockAt TEXT,
        lastUnlockOk INTEGER,
        lastUnlockMethod TEXT,
        lastUnlockError TEXT
      )`);
      db.exec(`CREATE TABLE IF NOT EXISTS pending_secret_deletes (
        account TEXT PRIMARY KEY,
        queuedAt TEXT NOT NULL
      )`);
      if (this.dbPath !== ':memory:') {
        try { chmodSync(this.dbPath, 0o600); } catch { /* ignore */ }
      }
      this.db = db;
      return db;
    } catch (e) {
      db.close();
      throw e;
    }
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  private tx<T>(fn: (db: DatabaseSync) => T): T {
    const db = this.database();
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn(db);
      db.exec('COMMIT');
      return out;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* retain original */ }
      throw e;
    }
  }

  private mapRow(r: RawRow | undefined): PasscodeMetaRecord | undefined {
    if (!r) return undefined;
    const tripped: PasscodeTripped | null = r.trippedAt && r.trippedReason
      ? { at: r.trippedAt, reason: r.trippedReason }
      : r.pendingAt
        ? { at: r.pendingAt, reason: INTERRUPTED_REASON }
        : null;
    const lastUnlock: PasscodeUnlockOutcome | null = r.lastUnlockAt && r.lastUnlockOk !== null
      ? {
          at: r.lastUnlockAt,
          ok: r.lastUnlockOk === 1,
          ...(r.lastUnlockMethod ? { method: r.lastUnlockMethod } : {}),
          ...(r.lastUnlockError ? { error: r.lastUnlockError } : {}),
        }
      : null;
    return {
      deviceId: r.deviceId,
      enabled: r.enabled === 1 && !tripped,
      savedAt: r.savedAt,
      storage: r.storage === 'keychain' ? 'keychain' : 'file',
      tripped,
      pending: r.pendingAt && r.pendingId ? { at: r.pendingAt, id: r.pendingId } : null,
      lastUnlock,
    };
  }

  private readRow(db: DatabaseSync, deviceId: string): RawRow | undefined {
    return db.prepare('SELECT * FROM passcode_meta WHERE deviceId = ?').get(deviceId) as unknown as RawRow | undefined;
  }

  getRecord(deviceId: string): PasscodeMetaRecord | undefined {
    const db = this.database();
    return this.mapRow(this.readRow(db, deviceId));
  }

  /** Sanitized status for API / device.meta. Reads the latest shared SQLite row; never exposes the passcode. */
  status(deviceId: string, support: { supported: boolean; reason?: string }): PasscodeStatus {
    const rec = this.getRecord(deviceId);
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

  /** Fresh shared-DB check: is unattended unlock currently enabled, untripped, and with no pending unresolved attempt? */
  isAutoUnlockReady(deviceId: string): boolean {
    const rec = this.getRecord(deviceId);
    return Boolean(rec && rec.enabled && !rec.tripped && !rec.pending);
  }

  /** Retry any Keychain deletions that previously failed (best-effort). */
  async drainPendingDeletes(): Promise<void> {
    const db = this.database();
    const rows = db.prepare('SELECT account FROM pending_secret_deletes').all() as unknown as { account: string }[];
    for (const row of rows) {
      try {
        await this.secrets.del(row.account);
        db.prepare('DELETE FROM pending_secret_deletes WHERE account = ?').run(row.account);
      } catch { /* keep queued for next retry */ }
    }
  }

  /** Save or update a device's passcode. Clears any previous circuit-breaker trip or pending attempt.
   *  When updating an existing passcode without passing `enabled`, preserves the existing `enabled` setting (false if tripped). */
  async savePasscode(deviceId: string, rawPasscode: string, opts: { enabled?: boolean } = {}): Promise<PasscodeMetaRecord> {
    const passcode = validatePasscode(rawPasscode);
    const acct = keychainAccount(deviceId);
    await this.secrets.set(acct, passcode);
    const savedAt = this.now();
    const rec = this.tx((db) => {
      db.prepare('DELETE FROM pending_secret_deletes WHERE account = ?').run(acct);
      const prev = this.readRow(db, deviceId);
      const prevTripped = Boolean(prev?.trippedAt || prev?.pendingAt);
      const nextEnabled = opts.enabled !== undefined
        ? opts.enabled
        : prev
          ? (prevTripped ? false : prev.enabled === 1)
          : true;
      db.prepare(`INSERT INTO passcode_meta (
        deviceId, enabled, savedAt, storage, trippedAt, trippedReason, pendingAt, pendingId,
        lastUnlockAt, lastUnlockOk, lastUnlockMethod, lastUnlockError
      ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)
      ON CONFLICT(deviceId) DO UPDATE SET
        enabled = excluded.enabled,
        savedAt = excluded.savedAt,
        storage = excluded.storage,
        trippedAt = NULL,
        trippedReason = NULL,
        pendingAt = NULL,
        pendingId = NULL`)
        .run(
          deviceId,
          nextEnabled ? 1 : 0,
          savedAt,
          this.secrets.storageName,
          prev?.lastUnlockAt ?? null,
          prev?.lastUnlockOk ?? null,
          prev?.lastUnlockMethod ?? null,
          prev?.lastUnlockError ?? null,
        );
      return this.mapRow(this.readRow(db, deviceId))!;
    });
    this.onChange?.(deviceId);
    return rec;
  }

  /** Toggle unattended unlock on/off for a device that already has a saved passcode. */
  setEnabled(deviceId: string, enabled: boolean): PasscodeMetaRecord {
    const rec = this.tx((db) => {
      const prev = this.readRow(db, deviceId);
      if (!prev) {
        throw new PhoneDockError(
          'Save a passcode for this device first',
          'passcode_not_set',
          400,
          ['Save a passcode in PhoneDock Device Settings or run `phonedock passcode set <device>`.'],
        );
      }
      if (enabled && (prev.trippedAt || prev.pendingAt)) {
        throw new PhoneDockError(
          'Passcode unlock is paused after a failed or unfinished attempt',
          'passcode_tripped',
          409,
          ['Re-enter and save the device passcode to verify it and re-enable unattended unlock.'],
          prev.trippedReason ?? INTERRUPTED_REASON,
        );
      }
      db.prepare('UPDATE passcode_meta SET enabled = ? WHERE deviceId = ?').run(enabled ? 1 : 0, deviceId);
      return this.mapRow(this.readRow(db, deviceId))!;
    });
    this.onChange?.(deviceId);
    return rec;
  }

  /** Durably revoke the device's passcode in SQLite FIRST, queue Keychain cleanup, then delete from Keychain.
   *  Even if Keychain deletion fails or the process crashes, the device record is already revoked and cannot be inherited. */
  async remove(deviceId: string): Promise<boolean> {
    const acct = keychainAccount(deviceId);
    const at = this.now();
    const existed = this.tx((db) => {
      const prev = this.readRow(db, deviceId);
      db.prepare('DELETE FROM passcode_meta WHERE deviceId = ?').run(deviceId);
      if (prev) {
        db.prepare('INSERT OR REPLACE INTO pending_secret_deletes (account, queuedAt) VALUES (?, ?)').run(acct, at);
      }
      return Boolean(prev);
    });
    if (existed) this.onChange?.(deviceId);
    try {
      await this.secrets.del(acct);
      this.tx((db) => {
        db.prepare('DELETE FROM pending_secret_deletes WHERE account = ?').run(acct);
      });
    } catch {
      // Metadata is already durably revoked; pending_secret_deletes ensures retry later.
    }
    return existed;
  }

  /** Internal daemon-only lookup. Never return this value over HTTP/MCP/CLI. */
  async getSecret(deviceId: string): Promise<string | null> {
    const rec = this.getRecord(deviceId);
    if (!rec) return null;
    return this.secrets.get(keychainAccount(deviceId));
  }

  /** Atomically verify latest shared permission and reserve a single credential-dispatch slot BEFORE any byte leaves.
   *  Returns an attemptId that MUST be finalized via completeAttempt(), or left pending if the process crashes / reply is lost
   *  (which automatically pauses all further attempts across restarts and other daemons). */
  reserveAttempt(deviceId: string): string {
    const attemptId = randomUUID();
    const at = this.now();
    this.tx((db) => {
      const row = this.readRow(db, deviceId);
      if (!row) {
        throw new PhoneDockError(
          'No passcode is saved for this device',
          'passcode_required',
          409,
          ['Save the device passcode in PhoneDock Device Settings (Unattended Unlock), or call request_human.'],
          undefined,
          'not_sent',
        );
      }
      if (row.trippedAt || row.pendingAt) {
        throw new PhoneDockError(
          'Unattended unlock is paused after a failed or unfinished attempt',
          'passcode_tripped',
          409,
          ['Re-save the device passcode in PhoneDock Device Settings to verify it and re-enable unattended unlock, or call request_human.'],
          row.trippedReason ?? INTERRUPTED_REASON,
          'not_sent',
        );
      }
      if (row.enabled !== 1) {
        throw new PhoneDockError(
          'Unattended unlock is turned off for this device',
          'unattended_unlock_disabled',
          403,
          ['Turn on "Allow agent to unlock" in PhoneDock Device Settings, or call request_human.'],
          undefined,
          'not_sent',
        );
      }
      db.prepare('UPDATE passcode_meta SET pendingAt = ?, pendingId = ? WHERE deviceId = ?').run(at, attemptId, deviceId);
    });
    return attemptId;
  }

  /** Finalize a reserved attempt. On verified success, clears `pending` and records success.
   *  On failure/unverified dispatch, converts `pending` into a durable `tripped` state and disables `enabled`. */
  completeAttempt(
    deviceId: string,
    attemptId: string,
    outcome: { ok: boolean; method?: string; error?: string; tripReason?: string },
  ): void {
    const at = this.now();
    this.tx((db) => {
      const row = this.readRow(db, deviceId);
      if (!row || row.pendingId !== attemptId) return;
      if (outcome.ok) {
        db.prepare(`UPDATE passcode_meta
          SET pendingAt = NULL, pendingId = NULL, trippedAt = NULL, trippedReason = NULL,
              lastUnlockAt = ?, lastUnlockOk = 1, lastUnlockMethod = ?, lastUnlockError = NULL
          WHERE deviceId = ?`)
          .run(at, outcome.method ?? null, deviceId);
      } else {
        const reason = (outcome.tripReason ?? outcome.error ?? INTERRUPTED_REASON).slice(0, 300);
        db.prepare(`UPDATE passcode_meta
          SET enabled = 0, pendingAt = NULL, pendingId = NULL, trippedAt = ?, trippedReason = ?,
              lastUnlockAt = ?, lastUnlockOk = 0, lastUnlockMethod = ?, lastUnlockError = ?
          WHERE deviceId = ?`)
          .run(at, reason, at, outcome.method ?? null, (outcome.error ?? reason).slice(0, 300), deviceId);
      }
    });
    this.onChange?.(deviceId);
  }

  /** Record a non-dispatch outcome (e.g. before_first_unlock or pre-dispatch transport error) without tripping the breaker. */
  recordPreDispatchOutcome(deviceId: string, outcome: { ok: boolean; method?: string; error?: string }): void {
    const at = this.now();
    this.tx((db) => {
      const row = this.readRow(db, deviceId);
      if (!row) return;
      db.prepare(`UPDATE passcode_meta
        SET lastUnlockAt = ?, lastUnlockOk = ?, lastUnlockMethod = ?, lastUnlockError = ?
        WHERE deviceId = ?`)
        .run(at, outcome.ok ? 1 : 0, outcome.method ?? null, outcome.error ? outcome.error.slice(0, 300) : null, deviceId);
    });
    this.onChange?.(deviceId);
  }

  async onDeviceDeleted(deviceId: string): Promise<void> {
    await this.remove(deviceId);
  }
}
