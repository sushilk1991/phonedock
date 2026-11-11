import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { DeviceClaims, processIsAlive } from './device-claims.ts';
import { PhoneDockError } from '../core/types.ts';

function fixture(t: { after(fn: () => void): void }, extra: ConstructorParameters<typeof DeviceClaims>[0] = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pdtest-claims-'));
  const path = join(dir, 'claims.sqlite');
  const a = new DeviceClaims({ path, instance: 'daemon-a', ...extra });
  const b = new DeviceClaims({ path, instance: 'daemon-b', ...extra });
  t.after(() => { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); });
  return { a, b, path };
}
const conflict = (f: () => unknown) => assert.throws(f, (e: unknown) => e instanceof PhoneDockError && e.code === 'lease_conflict' && e.delivery === 'not_sent');

test('two SQLite connections coordinate device ownership, including identical owner strings', (t) => {
  const { a, b } = fixture(t);
  const first = a.acquire('fake:pdtest-phone', 'same-agent');
  conflict(() => b.acquire('fake:pdtest-phone', 'same-agent'));
  conflict(() => b.check('fake:pdtest-phone', 'same-agent'));
  assert.equal(b.view('fake:pdtest-phone')?.token, first.token);
  assert.equal(a.acquire('fake:pdtest-phone', 'same-agent').token, first.token);
  assert.equal(a.check('fake:pdtest-phone', 'same-agent', first.token)?.owner, 'same-agent');
  assert.equal(a.release('fake:pdtest-phone', 'other-agent'), false);
  assert.equal(a.release('fake:pdtest-phone', 'same-agent'), true);
  assert.equal(b.acquire('fake:pdtest-phone', 'same-agent').instance, 'daemon-b');
});

test('only an explicit human takeover may replace a live foreign daemon; old releases cannot erase it', (t) => {
  const { a, b } = fixture(t);
  const old = a.acquire('fake:pdtest-takeover', 'agent');
  conflict(() => b.acquire('fake:pdtest-takeover', 'agent', { force: true }));
  conflict(() => b.acquire('fake:pdtest-takeover', 'app:human'));
  const person = b.acquire('fake:pdtest-takeover', 'app:human', { force: true });
  assert.ok(person.generation > old.generation);
  assert.notEqual(person.token, old.token);
  assert.equal(person.expiresAt, null);
  conflict(() => a.check('fake:pdtest-takeover', 'agent', old.token));
  assert.equal(a.release('fake:pdtest-takeover', 'agent'), false);
  a.releaseAll();
  assert.equal(b.view('fake:pdtest-takeover')?.owner, 'app:human');
});

test('TTL expiration and proven process death allow reclamation; renewals preserve the acquisition token', (t) => {
  let now = 1000; const dead = new Set<number>();
  const { a, b, path } = fixture(t, { now: () => now, pidAlive: (pid) => !dead.has(pid) });
  const c = new DeviceClaims({ path, instance: 'daemon-c', pid: 9911, now: () => now, pidAlive: (pid) => !dead.has(pid) });
  t.after(() => c.close());
  const first = a.acquire('fake:pdtest-expiring', 'agent', { ttlSec: 1 });
  now += 500;
  assert.equal(a.renew('fake:pdtest-expiring', 'agent', 2).token, first.token);
  now += 1500;
  conflict(() => b.acquire('fake:pdtest-expiring', 'other'));
  now += 501;
  assert.equal(b.acquire('fake:pdtest-expiring', 'other').owner, 'other');
  c.acquire('fake:pdtest-dead', 'dead-agent'); dead.add(9911);
  assert.equal(a.acquire('fake:pdtest-dead', 'live-agent').owner, 'live-agent');
});

test('an old acquisition token cannot authorize a later acquisition by the same owner', (t) => {
  const { a } = fixture(t);
  const old = a.acquire('fake:pdtest-token', 'agent');
  a.release('fake:pdtest-token', 'agent');
  const next = a.acquire('fake:pdtest-token', 'agent');
  assert.notEqual(old.token, next.token);
  conflict(() => a.check('fake:pdtest-token', 'agent', old.token));
});

test('an explicit handoff hold keeps an agent claim until its ordinary sliding TTL is restored', (t) => {
  let now = 1000;
  const { a, b } = fixture(t, { now: () => now });
  a.acquire('fake:pdtest-handoff', 'agent', { ttlSec: 1 });
  assert.equal(a.renew('fake:pdtest-handoff', 'agent', null).expiresAt, null);
  now += 10_000;
  conflict(() => b.acquire('fake:pdtest-handoff', 'other'));
  assert.equal(a.renew('fake:pdtest-handoff', 'agent', 1).expiresAt, now + 1000);
  now += 1001;
  assert.equal(b.acquire('fake:pdtest-handoff', 'other').owner, 'other');
});

test('process liveness is conservative: only ESRCH proves death; EPERM and unknown errors stay alive', () => {
  assert.equal(processIsAlive(100, () => {}), true);
  assert.equal(processIsAlive(100, () => { throw Object.assign(new Error(), { code: 'ESRCH' }); }), false);
  for (const code of ['EPERM', 'EINVAL', undefined]) assert.equal(processIsAlive(100, () => { throw Object.assign(new Error(), { code }); }), true);
});

test('a bounded database lock failure sends no input and does not corrupt another claimant', (t) => {
  const { a, path } = fixture(t, { busyTimeoutMs: 10 });
  a.acquire('fake:pdtest-sql-busy', 'agent');
  const lock = new DatabaseSync(path);
  try {
    lock.exec('BEGIN IMMEDIATE');
    assert.throws(() => a.renew('fake:pdtest-sql-busy', 'agent'), (e: unknown) => e instanceof PhoneDockError && e.code === 'lease_store_busy' && e.delivery === 'not_sent');
  } finally { lock.exec('ROLLBACK'); lock.close(); }
  assert.equal(a.check('fake:pdtest-sql-busy', 'agent')?.owner, 'agent');
});

test('real separate Node processes respect a live owner, and a dead child claim is recoverable', (t) => {
  const { a, path } = fixture(t);
  const module = new URL('./device-claims.ts', import.meta.url).href;
  const program = `const {DeviceClaims}=await import(process.argv[1]);const c=new DeviceClaims({path:process.argv[2]});try{const r=c.acquire('fake:pdtest-process','child');console.log(JSON.stringify({owner:r.owner,pid:r.pid}));}catch(e){console.log(JSON.stringify({code:e.code,delivery:e.delivery}));}finally{c.close();}`;
  a.acquire('fake:pdtest-process', 'parent');
  const child = () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program, module, path], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout.trim());
  };
  assert.deepEqual(child(), { code: 'lease_conflict', delivery: 'not_sent' });
  a.release('fake:pdtest-process', 'parent');
  assert.equal(child().owner, 'child');
  assert.equal(a.acquire('fake:pdtest-process', 'parent').owner, 'parent');
});
