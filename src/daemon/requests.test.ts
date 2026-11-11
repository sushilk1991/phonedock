import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Ctx } from './http.ts';
process.env.PHONEDOCK_HOME = mkdtempSync(join(tmpdir(), 'pd-requests-'));
const { inputRoute } = await import('./delivery.ts');
const { logAction } = await import('./core.ts');
const { backends } = await import('./core.ts');
backends.push({ id: 'fake' } as never);
const { router } = await import('./routes.ts');
const { withRequestReceipt } = await import('./requests.ts');
const ctx = (body: unknown, requestId = 'same-request', owner = 'test') => ({
  params: { id: 'fake:pdtest-recovery' }, owner, req: { method: 'POST', headers: { 'x-phonedock-request-id': requestId } },
  url: new URL('http://localhost/v1/devices/fake/input'), body: async () => body,
} as unknown as Ctx);
test('request IDs recover results without repeating input and reject different payloads', async () => {
  let calls = 0;
  const route = inputRoute(async (c) => { calls++; logAction(c.params.id, c.owner, { action: 'tap' }); return { ok: true }; });
  const a = await route(ctx({ action: 'tap', x: 1 }));
  assert.deepEqual(await route(ctx({ action: 'tap', x: 1 })), a);
  assert.equal(calls, 1);
  await assert.rejects(Promise.resolve(route(ctx({ action: 'tap', x: 2 }))), (e: any) => e.code === 'request_id_conflict' && e.delivery === 'not_sent');
  const read = router.match('GET', '/v1/devices/fake%3Apdtest-recovery/requests/same-request');
  assert.ok(read && read !== 'method');
  const out = await read.h({ ...ctx({}), params: read.params } as Ctx) as any;
  assert.equal(out.status, 'completed'); assert.equal(out.delivery, 'sent'); assert.equal(out.requestId, 'same-request');
  await assert.rejects(Promise.resolve(read.h({ ...ctx({}, 'same-request', 'other'), params: read.params } as Ctx)), (e: any) => e.code === 'not_found');
});
test('concurrent identical requests join one execution and failures stay recoverable', async () => {
  let calls = 0;
  const route = inputRoute(async () => { calls++; await new Promise((r) => setTimeout(r, 5)); throw new Error('lost acknowledgement'); });
  const out = await Promise.allSettled([route(ctx({}, 'lost-reply')), route(ctx({}, 'lost-reply'))]);
  assert.equal(calls, 1);
  assert.ok(out.every((r) => r.status === 'rejected' && r.reason.delivery === 'unknown'));
});

test('secret request values are absent from durable results and errors', async () => {
  const secret = 'pdtest-secret-é-7391';
  const route = inputRoute(async () => ({ ok: true, finalValue: secret, element: { text: secret }, warnings: [`Echo ${secret}`] }));
  await route(ctx({ action: 'type', text: secret, secret: true }, 'secret-receipt'));
  const dir = join(process.env.PHONEDOCK_HOME!, 'requests');
  const receipts = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
  assert.ok(!receipts.includes(secret));
});

test('separate daemon processes reserve one receipt before executing duplicate input', async () => {
  const calls = join(process.env.PHONEDOCK_HOME!, 'cross-process-calls');
  const source = `import { withRequestReceipt } from ${JSON.stringify(new URL('./requests.ts', import.meta.url).href)};
    import { appendFileSync } from 'node:fs';
    const c = { params: { id: 'fake:pdtest-recovery' }, owner: 'test', req: { method: 'POST', headers: { 'x-phonedock-request-id': 'cross-process' } }, url: new URL('http://localhost/v1/devices/fake/input'), body: async () => ({ action: 'tap' }) };
    try { await withRequestReceipt(c, async () => { appendFileSync(${JSON.stringify(calls)}, 'tap\\n'); await new Promise(r => setTimeout(r, 100)); return { ok: true, delivery: 'sent' }; }); }
    catch (e) { if (e.code !== 'request_in_progress' || e.delivery !== 'unknown') throw e; }`;
  await Promise.all(Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = ''; child.stderr.on('data', (d) => { error += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Receipt child timed out')); }, 10_000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(error)); });
  })));
  assert.equal(readFileSync(calls, 'utf8'), 'tap\n');
  await withRequestReceipt(ctx({ action: 'tap' }, 'cross-process'), async () => { throw new Error('Duplicate executed after child exit'); });
});

test('an owner can recover its receipt after a foreign daemon takes over the device', async () => {
  const core = await import('./core.ts');
  const { DeviceClaims } = await import('./device-claims.ts');
  const id = 'fake:pdtest-recovery';
  core.acquireLease(id, 'test');
  const foreign = new DeviceClaims({ path: join(process.env.PHONEDOCK_HOME!, 'device-claims.sqlite'), instance: 'foreign-receipt-reader' });
  try {
    await inputRoute(async () => ({ ok: true }))(ctx({}, 'preempted-receipt'));
    foreign.acquire(id, 'app:human', { force: true });
    const route = router.match('GET', `/v1/devices/${id}/requests/preempted-receipt`);
    assert.ok(route && route !== 'method');
    const receipt = await route.h({ ...ctx({}), params: route.params } as Ctx) as any;
    assert.equal(receipt.requestId, 'preempted-receipt');
    assert.equal(receipt.status, 'completed');
    assert.equal(foreign.view(id)?.owner, 'app:human');
  } finally { core.clearLeases(); foreign.releaseAll(); foreign.close(); }
});

test('receipt pruning expires old files, evicts the oldest completed receipt, and protects live input', async () => {
  const dir = join(process.env.PHONEDOCK_HOME!, 'requests');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
  try {
    const now = Date.now();
    const receipt = { requestId: 'retained', status: 'completed', delivery: 'sent', startedAt: new Date(now).toISOString(), fingerprint: 'test', recorderPid: process.pid };
    for (let i = 0; i < 1024; i++) {
      const path = join(dir, `receipt-${i}.json`);
      writeFileSync(path, JSON.stringify({ ...receipt, ...(i === 0 ? { status: 'running' } : {}) }));
      const at = new Date(now - 10_000 + i); utimesSync(path, at, at);
    }
    const expired = join(dir, 'expired.json');
    const old = new Date(now - 25 * 60 * 60_000);
    writeFileSync(expired, JSON.stringify({ ...receipt, startedAt: old.toISOString() })); utimesSync(expired, old, old);
    const liveOld = join(dir, 'live-old.json');
    writeFileSync(liveOld, JSON.stringify({ ...receipt, status: 'running', startedAt: old.toISOString() })); utimesSync(liveOld, old, old);

    await withRequestReceipt(ctx({}, 'after-pruning'), async () => ({ ok: true, delivery: 'sent' }));
    assert.equal(existsSync(expired), false);
    assert.equal(existsSync(liveOld), true);
    assert.equal(existsSync(join(dir, 'receipt-0.json')), true);
    assert.equal(existsSync(join(dir, 'receipt-1.json')), false);
    assert.equal(existsSync(join(dir, 'receipt-2.json')), false);
    assert.equal(existsSync(join(dir, 'receipt-3.json')), true);
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.json')).length, 1024);

    for (const name of readdirSync(dir)) writeFileSync(join(dir, name), JSON.stringify({ ...receipt, status: 'running' }));
    let calls = 0;
    await assert.rejects(withRequestReceipt(ctx({}, 'full-store'), async () => { calls++; }),
      (e: any) => e.code === 'request_store_full' && e.delivery === 'not_sent');
    assert.equal(calls, 0);
    assert.equal(readdirSync(dir).length, 1024);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
