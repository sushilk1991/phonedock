// A write-ahead receipt, never a replay queue. A receipt left running by a dead daemon means delivery unknown.
// IDs are scoped to device AND owner. The request body is hashed, never stored; secrets are masked in receipts.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from '../core/paths.ts';
import { PhoneDockError, type Delivery } from '../core/types.ts';
import type { Ctx } from './http.ts';
import { inputSecretValues as secretValues, redactInputValue as mask } from '../core/secrets.ts';

const TTL_MS = 24 * 60 * 60_000;
const LIMIT = 1024;
const pending = new Map<string, Promise<unknown>>();
export interface RequestReceipt {
  requestId: string; status: 'running' | 'completed' | 'failed' | 'interrupted';
  delivery: Delivery; startedAt: string; completedAt?: string; fingerprint: string;
  result?: unknown; resultOmitted?: boolean;
  error?: { message: string; code: string; status: number; hints?: string[]; detail?: string; delivery: Delivery };
  recorderPid?: number;
}
function alive(pid?: number): boolean { if (!Number.isSafeInteger(pid) || Number(pid) <= 1) return false; try { process.kill(pid!, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } }
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const dir = () => stateDir('requests');
const file = (device: string, owner: string, id: string) => join(dir(), `${hash(JSON.stringify([device, owner, id]))}.json`);
export function checkRequestId(id: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(id) || /^\.+$/.test(id)) throw new PhoneDockError('Invalid request ID', 'bad_request', 400, undefined, undefined, 'not_sent');
  return id;
}
function read(path: string): RequestReceipt | undefined {
  try {
    const r = JSON.parse(readFileSync(path, 'utf8')) as RequestReceipt;
    if (!r || typeof r.startedAt !== 'string' || !Number.isFinite(Date.parse(r.startedAt))) return undefined;
    if (Date.now() - Date.parse(r.startedAt) > TTL_MS && !(r.status === 'running' && alive(r.recorderPid))) { unlinkSync(path); return undefined; }
    return r;
  } catch { return undefined; }
}
function prune(): void {
  const root = dir();
  const retained: { path: string; mtimeMs: number }[] = [];
  for (const name of readdirSync(root)) {
    if (!name.endsWith('.json')) continue;
    const path = join(root, name);
    let mtimeMs: number;
    try { mtimeMs = statSync(path).mtimeMs; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
    if (Date.now() - mtimeMs > TTL_MS) {
      const r = read(path);
      if (!(r?.status === 'running' && alive(r.recorderPid))) {
        try { unlinkSync(path); continue; }
        catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; /* retain files we could not remove */ }
      }
    }
    retained.push({ path, mtimeMs });
  }
  let count = retained.length;
  if (count >= LIMIT) retained.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const { path } of retained) {
    if (count < LIMIT) break;
    const r = read(path);
    if (!r || r.status !== 'running' || !alive(r.recorderPid)) { try { unlinkSync(path); count--; } catch { /* another daemon pruned it */ } }
  }
  if (count >= LIMIT) {
    throw new PhoneDockError('The input receipt store is full', 'request_store_full', 503,
      ['Receipts expire after 24 hours. Inspect recent request results before starting more input.'], undefined, 'not_sent');
  }
}
function store(path: string, r: RequestReceipt): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(r), { mode: 0o600 }); renameSync(tmp, path); }
  finally { try { unlinkSync(tmp); } catch { /* renamed */ } }
}
function replay(r: RequestReceipt): unknown {
  if (r.status === 'running' || r.status === 'interrupted') throw new PhoneDockError('This request may already have reached the device', 'request_in_progress', 409,
    ['Read the screen and inspect this request receipt; do not resend the input with a new ID blindly.'], undefined, 'unknown');
  if (r.error) { const e = r.error; throw new PhoneDockError(e.message, e.code, e.status, e.hints, e.detail, e.delivery); }
  return r.result ?? { ok: true, requestId: r.requestId, delivery: r.delivery, retrySafe: r.delivery === 'not_sent', resultOmitted: true };
}

/** Run once when a client supplied an ID. Duplicate calls join; after restart the write-ahead receipt wins. */
export async function withRequestReceipt(c: Ctx, run: () => Promise<unknown>): Promise<unknown> {
  const raw = c.req?.headers?.['x-phonedock-request-id'];
  if (raw === undefined) { await c.beforeRun?.(); return run(); } // old clients retain their response shape
  if (typeof raw !== 'string') throw new PhoneDockError('Invalid request ID', 'bad_request', 400, undefined, undefined, 'not_sent');
  const requestId = checkRequestId(raw);
  const body = c.body ? await c.body() : {};
  const path = file(c.params.id, c.owner, requestId);
  const fingerprint = hash(JSON.stringify([c.req.method, c.url?.pathname, body]));
  const prior = read(path);
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw new PhoneDockError('This request ID was used with different input', 'request_id_conflict', 409, undefined, undefined, 'not_sent');
    return pending.get(path) ?? replay(prior);
  }
  prune();
  // A new execution: wake a sleeping phone first. Before the receipt, so a wake that fails (nothing sent) isn't what
  // this request ID answers for the next 24 h.
  await c.beforeRun?.();
  const receipt: RequestReceipt = { requestId, fingerprint, status: 'running', delivery: 'unknown', startedAt: new Date().toISOString(), recorderPid: process.pid };
  try { writeFileSync(path, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 }); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      const winner = read(path);
      if (winner && winner.fingerprint !== fingerprint) throw new PhoneDockError('This request ID was used with different input', 'request_id_conflict', 409, undefined, undefined, 'not_sent');
      // A duplicate that got this far alongside it (both passed the first lookup while the wake gate ran) joins it.
      return pending.get(path) ?? replay(winner ?? receipt);
    }
    throw new PhoneDockError('Could not record input delivery before sending', 'request_store_failed', 503, undefined, undefined, 'not_sent');
  }
  const secrets = secretValues(body);
  const p = (async () => {
    try {
      const out = await run();
      const result = out && typeof out === 'object' ? { ...out, requestId } : out;
      receipt.status = 'completed'; receipt.delivery = (out as { delivery?: Delivery })?.delivery ?? 'unknown';
      const safe = mask(result, secrets);
      if (Buffer.byteLength(JSON.stringify(safe) ?? '') <= 512 * 1024) receipt.result = safe; else receipt.resultOmitted = true;
      return result;
    } catch (e) {
      const x = e instanceof PhoneDockError ? e : new PhoneDockError('Input outcome is unknown', 'internal', 500, undefined, undefined, 'unknown');
      receipt.status = 'failed'; receipt.delivery = x.delivery ?? 'unknown';
      receipt.error = mask({ message: x.message, code: x.code, status: x.status, hints: x.hints, detail: x.detail, delivery: receipt.delivery }, secrets);
      throw x;
    } finally {
      receipt.completedAt = new Date().toISOString();
      try { store(path, receipt); } catch { /* the running receipt stays unknown; never re-execute */ }
    }
  })();
  pending.set(path, p);
  try { return await p; } finally { if (pending.get(path) === p) pending.delete(path); }
}
export function requestResult(device: string, owner: string, id: string): RequestReceipt {
  const path = file(device, owner, checkRequestId(id)); const r = read(path);
  if (!r) throw new PhoneDockError('No retained receipt for this request', 'not_found', 404);
  if (r.status === 'running' && !pending.has(path) && !alive(r.recorderPid)) return { ...r, status: 'interrupted', delivery: 'unknown' };
  return r;
}
