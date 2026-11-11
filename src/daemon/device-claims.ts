// Host-local ownership shared by upgraded PhoneDock daemons. SQLite transactions avoid lock-file stealing races.
// This coordinates PhoneDock instances using the same PHONEDOCK_HOME, not unrelated tools or older daemons.
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { stateDir } from '../core/paths.ts';
import { PhoneDockError } from '../core/types.ts';

export interface DeviceClaim {
  deviceId: string; owner: string; pid: number; instance: string; token: string; generation: number;
  acquiredAt: number; updatedAt: number; expiresAt: number | null; ttlSec: number | null;
}
export interface ClaimOptions { /** null holds an agent claim through a pending human handoff. */ ttlSec?: number | null; force?: boolean }
export interface DeviceClaimsOptions {
  path?: string; instance?: string; pid?: number; now?: () => number; pidAlive?: (pid: number) => boolean;
  busyTimeoutMs?: number;
}
/** Only ESRCH proves that a local process is dead; permission denial and unknown failures are conservative. */
export function processIsAlive(pid: number, probe: (pid: number, signal: number) => unknown = process.kill): boolean {
  try { probe(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
const bad = (message: string) => new PhoneDockError(message, 'bad_request', 400, undefined, undefined, 'not_sent');
function identifier(value: string, name: string, max: number): void {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw bad(`Invalid ${name}`);
}

export class DeviceClaims {
  readonly instance: string;
  readonly pid: number;
  private path?: string;
  private now: () => number;
  private pidAlive: (pid: number) => boolean;
  private busyTimeoutMs: number;
  private db?: DatabaseSync;
  private statements = new Map<string, StatementSync>();
  private closed = false;
  constructor(opts: DeviceClaimsOptions = {}) {
    this.path = opts.path; this.instance = opts.instance ?? randomUUID(); this.pid = opts.pid ?? process.pid;
    identifier(this.instance, 'daemon instance', 200);
    if (!Number.isSafeInteger(this.pid) || this.pid < 1) throw bad('Invalid daemon PID');
    this.now = opts.now ?? Date.now; this.pidAlive = opts.pidAlive ?? processIsAlive;
    this.busyTimeoutMs = opts.busyTimeoutMs ?? 500;
    if (!Number.isInteger(this.busyTimeoutMs) || this.busyTimeoutMs < 0 || this.busyTimeoutMs > 5000) throw bad('Claim busy timeout must be 0–5000 ms');
  }
  private database(): DatabaseSync {
    if (this.closed) throw new PhoneDockError('Device ownership store is closed', 'lease_store_failed', 503, undefined, undefined, 'not_sent');
    if (this.db) return this.db;
    const path = this.path ?? join(stateDir(), 'device-claims.sqlite');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path);
    try {
      db.exec(`PRAGMA busy_timeout=${this.busyTimeoutMs};`);
      db.exec('PRAGMA journal_mode=WAL;');
      db.exec(`CREATE TABLE IF NOT EXISTS device_claims (
        deviceId TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL, instance TEXT NOT NULL,
        token TEXT NOT NULL, generation INTEGER NOT NULL, acquiredAt REAL NOT NULL, updatedAt REAL NOT NULL,
        expiresAt REAL, ttlSec REAL
      )`);
      if (path !== ':memory:') chmodSync(path, 0o600);
      this.db = db; return db;
    } catch (e) { db.close(); throw e; }
  }
  private failure(e: unknown): never {
    if (e instanceof PhoneDockError) throw e;
    const x = e as { code?: string; message?: string };
    const busy = /(?:busy|locked)/i.test(`${x.code ?? ''} ${x.message ?? ''}`);
    throw new PhoneDockError(busy ? 'Device ownership is being updated by another process' : 'Could not access shared device ownership',
      busy ? 'lease_store_busy' : 'lease_store_failed', 503,
      ['Retry before sending input; no input was sent by this ownership check.'], undefined, 'not_sent');
  }
  private transaction<T>(fn: (db: DatabaseSync) => T): T {
    let db: DatabaseSync | undefined; let begun = false;
    try { db = this.database(); db.exec('BEGIN IMMEDIATE'); begun = true; const result = fn(db); db.exec('COMMIT'); return result; }
    catch (e) { if (begun) { try { db!.exec('ROLLBACK'); } catch { /* retain the original failure */ } } return this.failure(e); }
  }
  private statement(db: DatabaseSync, sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) { statement = db.prepare(sql); this.statements.set(sql, statement); }
    return statement;
  }
  private row(db: DatabaseSync, id: string): DeviceClaim | undefined {
    return this.statement(db, 'SELECT * FROM device_claims WHERE deviceId = ?').get(id) as unknown as DeviceClaim | undefined;
  }
  private active(claim: DeviceClaim | undefined): claim is DeviceClaim {
    return !!claim && (claim.expiresAt === null || claim.expiresAt > this.now()) && this.pidAlive(claim.pid);
  }
  private conflict(claim: DeviceClaim | undefined): never {
    throw new PhoneDockError(claim ? `The device is in use by ${claim.owner} in another ownership session` : 'The device ownership session ended',
      'lease_conflict', 409, ['Wait for the owner to release the device, or ask the person to take over.'],
      claim ? `Device ${claim.deviceId} is claimed by daemon PID ${claim.pid}` : undefined, 'not_sent');
  }
  private lifetime(owner: string, ttlSec?: number | null): { ttlSec: number | null; expiresAt: number | null } {
    const ttl = ttlSec === undefined ? (owner === 'app:human' ? null : 600) : ttlSec;
    if (ttl !== null && (!Number.isFinite(ttl) || ttl <= 0 || !Number.isFinite(this.now() + ttl * 1000))) throw bad('Claim TTL must be a positive number of seconds');
    return { ttlSec: ttl, expiresAt: ttl === null ? null : this.now() + ttl * 1000 };
  }
  acquire(deviceId: string, owner: string, opts: ClaimOptions = {}): DeviceClaim {
    identifier(deviceId, 'device ID', 1000); identifier(owner, 'owner', 200);
    return this.transaction((db) => {
      const prior = this.row(db, deviceId); const active = this.active(prior);
      const same = active && prior.instance === this.instance && prior.owner === owner;
      if (active && !same && !(opts.force && (prior.instance === this.instance || owner === 'app:human'))) this.conflict(prior);
      const now = this.now();
      const lifetime = this.lifetime(owner, opts.ttlSec === undefined && same ? prior.ttlSec : opts.ttlSec);
      const claim: DeviceClaim = { deviceId, owner, pid: this.pid, instance: this.instance,
        token: same ? prior.token : randomUUID(), generation: same ? prior.generation : (prior?.generation ?? 0) + 1,
        acquiredAt: same ? prior.acquiredAt : now, updatedAt: now, ...lifetime };
      this.statement(db, `INSERT INTO device_claims (deviceId,owner,pid,instance,token,generation,acquiredAt,updatedAt,expiresAt,ttlSec)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(deviceId) DO UPDATE SET
        owner=excluded.owner,pid=excluded.pid,instance=excluded.instance,token=excluded.token,generation=excluded.generation,
        acquiredAt=excluded.acquiredAt,updatedAt=excluded.updatedAt,expiresAt=excluded.expiresAt,ttlSec=excluded.ttlSec`)
        .run(claim.deviceId, claim.owner, claim.pid, claim.instance, claim.token, claim.generation, claim.acquiredAt, claim.updatedAt, claim.expiresAt, claim.ttlSec);
      return claim;
    });
  }
  renew(deviceId: string, owner: string, ttlSec?: number | null): DeviceClaim {
    identifier(deviceId, 'device ID', 1000); identifier(owner, 'owner', 200);
    return this.transaction((db) => {
      const claim = this.row(db, deviceId);
      if (!this.active(claim) || claim.instance !== this.instance || claim.owner !== owner) this.conflict(claim);
      const result = { ...claim, updatedAt: this.now(), ...this.lifetime(owner, ttlSec === undefined ? claim.ttlSec : ttlSec) };
      this.statement(db, 'UPDATE device_claims SET updatedAt=?,expiresAt=?,ttlSec=? WHERE deviceId=? AND instance=? AND token=?')
        .run(result.updatedAt, result.expiresAt, result.ttlSec, deviceId, this.instance, claim.token);
      return result;
    });
  }
  /** An unclaimed/expired device is available; a supplied acquisition token requires that exact active claim. */
  check(deviceId: string, owner: string, token?: string): DeviceClaim | undefined {
    identifier(deviceId, 'device ID', 1000); identifier(owner, 'owner', 200);
    const claim = this.view(deviceId);
    if (!claim) { if (token) this.conflict(undefined); return undefined; }
    if (claim.instance !== this.instance || claim.owner !== owner || (token && claim.token !== token)) this.conflict(claim);
    return claim;
  }
  view(deviceId: string): DeviceClaim | undefined {
    identifier(deviceId, 'device ID', 1000);
    try { const claim = this.row(this.database(), deviceId); return this.active(claim) ? claim : undefined; }
    catch (e) { return this.failure(e); }
  }
  release(deviceId: string, owner?: string): boolean {
    identifier(deviceId, 'device ID', 1000); if (owner !== undefined) identifier(owner, 'owner', 200);
    return this.transaction((db) => Number(owner === undefined
      ? this.statement(db, 'DELETE FROM device_claims WHERE deviceId=? AND instance=?').run(deviceId, this.instance).changes
      : this.statement(db, 'DELETE FROM device_claims WHERE deviceId=? AND instance=? AND owner=?').run(deviceId, this.instance, owner).changes) > 0);
  }
  releaseAll(): number {
    return this.transaction((db) => Number(this.statement(db, 'DELETE FROM device_claims WHERE instance=?').run(this.instance).changes));
  }
  /** Close the DB handle only. Shutdown should call releaseAll first; an abrupt exit leaves provably reclaimable rows. */
  close(): void { this.db?.close(); this.statements.clear(); this.db = undefined; this.closed = true; }
}
