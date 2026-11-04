// Lease lifetime (sliding TTL, stale owners) and handoff ↔ lease rules in core.ts.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PHONEDOCK_HOME = mkdtempSync(join(tmpdir(), 'pd-leases-'));   // logAction writes under it
const core = await import('./core.ts');
const { acquireLease, checkLease, releaseLease, getLease, leaseView, touchLease, ownerPid, ownerGone, setPidAlive,
  clearLeases, createHandoff, resolveHandoff, pendingHandoff, HUMAN_OWNER, DEFAULT_AGENT_LEASE_SEC } = core;

const DEV = 'android-emulator:pdtest-lease';
const AGENT = 'mcp:claude-code:4242';
const OTHER = 'mcp:codex:5151';
let dead = new Set<number>();
setPidAlive((pid) => !dead.has(pid));

beforeEach(() => {
  clearLeases(); dead = new Set();
  for (const h of core.listHandoffs('pending')) resolveHandoff(h.id, 'cancelled', 'test');
});

function conflict(fn: () => unknown): Error & { code?: string; hints?: string[]; detail?: string } {
  try { fn(); } catch (e) { return e as Error & { code?: string }; }
  assert.fail('expected lease_conflict');
}

test('ownerPid: mcp and sdk owners carry a pid; cli, app and custom owners do not', () => {
  assert.equal(ownerPid('mcp:claude-code:36623'), 36623);
  assert.equal(ownerPid('mcp:agent:812'), 812);
  assert.equal(ownerPid('sdk:4100'), 4100);
  assert.equal(ownerPid('cli:dev'), undefined);
  assert.equal(ownerPid('app:human'), undefined);
  assert.equal(ownerPid('e2e:android'), undefined);
  assert.equal(ownerPid('ci:job:42'), undefined);
  assert.equal(ownerPid('mcp:claude-code:1'), undefined);   // never pid 0/1
});

test('agent leases get a 10 min sliding TTL; app:human leases are held until handed back', () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  try {
    const l = acquireLease(DEV, AGENT);
    assert.equal(l.ttlSec, DEFAULT_AGENT_LEASE_SEC);
    assert.equal(Date.parse(l.expiresAt!), 1_000_000 + 600_000);
    const t = acquireLease('android-emulator:other', HUMAN_OWNER);
    assert.equal(t.expiresAt, null); assert.equal(t.ttlSec, undefined);
    const e = acquireLease('android-emulator:ttl', AGENT, 120);
    assert.equal(e.ttlSec, 120);
  } finally { mock.timers.reset(); }
});

test('every call by the owner renews the lease; without calls it expires and others get through', () => {
  mock.timers.enable({ apis: ['Date'], now: 0 });
  try {
    acquireLease(DEV, AGENT);
    mock.timers.tick(500_000);
    checkLease(DEV, AGENT);                       // an input call
    mock.timers.tick(500_000);                    // 1000 s after acquiring, 500 s after the last call
    assert.equal(getLease(DEV)?.owner, AGENT);
    touchLease(DEV, AGENT);                       // a read (screenshot / ui) renews too
    mock.timers.tick(599_000);
    assert.equal(getLease(DEV)?.owner, AGENT);
    touchLease(DEV, OTHER);                       // someone else's read does not
    mock.timers.tick(2_000);
    assert.equal(getLease(DEV), null);
    checkLease(DEV, OTHER);                       // no conflict any more
  } finally { mock.timers.reset(); }
});

test('a lease whose owner process exited is reclaimed by the next other owner (and shown as stale)', () => {
  acquireLease(DEV, AGENT);
  const e = conflict(() => checkLease(DEV, OTHER));   // alive: conflict
  assert.equal(e.code, 'lease_conflict');
  assert.match(e.message, /mcp:claude-code:4242/);
  assert.ok(e.hints?.some((h) => /wait/i.test(h) && /hand it back/.test(h)), String(e.hints));
  assert.doesNotMatch([e.message, ...(e.hints ?? []), e.detail ?? ''].join('\n'), /\/v1\/|force/);
  dead.add(4242);
  assert.equal(ownerGone(AGENT), true);
  assert.equal(leaseView(DEV)?.stale, true);
  checkLease(DEV, OTHER);                             // reclaimed, request goes through
  assert.equal(getLease(DEV), null);
  acquireLease(DEV, AGENT); dead.add(4242);
  const l = acquireLease(DEV, OTHER);
  assert.equal(l.owner, OTHER);                         // acquire reclaims as well…
  assert.equal(l.reclaimedFrom, AGENT);                 // …and says from whom (L3), in the response only
  assert.equal(getLease(DEV)?.reclaimedFrom, undefined);
  assert.equal(acquireLease(DEV, OTHER).reclaimedFrom, undefined);   // a renewal reclaims nothing
});

test('owners without a pid are never reclaimed as stale', () => {
  acquireLease(DEV, 'cli:dev');
  dead.add(4242);
  assert.equal(conflict(() => checkLease(DEV, AGENT)).code, 'lease_conflict');
  assert.equal(leaseView(DEV)?.stale, undefined);
});

test('release by an owner that does not hold the lease is a no-op success with a note', () => {
  acquireLease(DEV, HUMAN_OWNER);
  const r = releaseLease(DEV, AGENT);
  assert.equal(r.ok, true); assert.equal(r.released, false); assert.equal(r.heldBy, HUMAN_OWNER);
  assert.match(r.note!, /don't hold/);
  assert.equal(getLease(DEV)?.owner, HUMAN_OWNER);
  assert.equal(releaseLease(DEV, HUMAN_OWNER).released, true);
  assert.equal(releaseLease(DEV, HUMAN_OWNER).released, false);   // nothing left: still fine
});

test('handoff: the person can act without the lease; after Take Over + Done the lease goes back to the agent', () => {
  acquireLease(DEV, AGENT);
  const h = createHandoff(DEV, 'Type your name and tap Greet', AGENT);
  assert.equal(h.returnLease, true); assert.equal(h.leaseHolder, AGENT);
  checkLease(DEV, HUMAN_OWNER);                                   // the person acting on the request
  assert.equal(conflict(() => checkLease(DEV, 'cli:someone')).code, 'lease_conflict');   // only app:human
  acquireLease(DEV, HUMAN_OWNER, undefined, true);                // Take Over
  assert.equal(getLease(DEV)?.owner, HUMAN_OWNER);
  const done = resolveHandoff(h.id, 'done', HUMAN_OWNER);
  assert.equal(done.leaseReturned, true); assert.equal(done.leaseHolder, AGENT);
  assert.equal(getLease(DEV)?.owner, AGENT);
  assert.equal(getLease(DEV)?.ttlSec, DEFAULT_AGENT_LEASE_SEC);
  // the app then hands back: a no-op, the agent keeps the device
  assert.equal(releaseLease(DEV, HUMAN_OWNER).released, false);
  assert.equal(getLease(DEV)?.owner, AGENT);
  assert.equal(conflict(() => checkLease(DEV, HUMAN_OWNER)).code, 'lease_conflict');   // no handoff pending any more
});

test('the device\'s activity log records the handoff and the person\'s Take Over / Hand Back / Done / Can\'t Do It', () => {
  const dev = 'android-emulator:pdtest-activity';
  acquireLease(dev, AGENT);
  const h = createHandoff(dev, 'Type your name and tap Greet', AGENT);
  acquireLease(dev, HUMAN_OWNER, undefined, true);
  resolveHandoff(h.id, 'done', HUMAN_OWNER, 'Typed Ada');
  const h2 = createHandoff(dev, 'Approve Face ID', AGENT);
  resolveHandoff(h2.id, 'cancelled', HUMAN_OWNER, 'No Face ID enrolled');
  acquireLease(dev, HUMAN_OWNER, undefined, true);
  releaseLease(dev, HUMAN_OWNER);
  const log = core.readActions(dev, 50) as { owner: string; action: Record<string, unknown> }[];
  const seq = log.map((e) => `${e.owner} ${e.action.action}`);
  assert.deepEqual(seq, [
    `${AGENT} lease.acquire`, `${AGENT} handoff.requested`, `${HUMAN_OWNER} lease.take_over`, `${HUMAN_OWNER} handoff.done`, 'daemon lease.returned',
    `${AGENT} handoff.requested`, `${HUMAN_OWNER} handoff.cancelled`, `${HUMAN_OWNER} lease.take_over`, `${HUMAN_OWNER} lease.hand_back`,
  ]);
  assert.equal(log[1].action.reason, 'Type your name and tap Greet');
  assert.equal(log[3].action.note, 'Typed Ada');
  assert.equal(log[6].action.reason, 'No Face ID enrolled');
});

test('handoff: cancelled also returns the lease; an agent that never held it does not get one', () => {
  acquireLease(DEV, AGENT, 90);
  const h = createHandoff(DEV, 'Approve Face ID', AGENT);
  acquireLease(DEV, HUMAN_OWNER, undefined, true);
  const r = resolveHandoff(h.id, 'cancelled', HUMAN_OWNER);
  assert.equal(r.leaseReturned, true);
  assert.equal(getLease(DEV)?.ttlSec, 90);                         // its own TTL comes back with it
  clearLeases();
  const h2 = createHandoff(DEV, 'Sign in', AGENT);                 // no lease when it asked
  assert.equal(h2.returnLease, false);
  acquireLease(DEV, HUMAN_OWNER, undefined, true);
  const r2 = resolveHandoff(h2.id, 'done', HUMAN_OWNER);
  assert.equal(r2.leaseReturned, undefined); assert.equal(r2.leaseHolder, HUMAN_OWNER);
});

test('handoff: an agent that releases while waiting, or exits, does not get the lease back', () => {
  acquireLease(DEV, AGENT);
  const h = createHandoff(DEV, 'Enter the passcode', AGENT);
  acquireLease(DEV, HUMAN_OWNER, undefined, true);
  assert.equal(releaseLease(DEV, AGENT).released, false);        // it let go (no-op: the person holds it)
  assert.equal(pendingHandoff(DEV)?.returnLease, false);
  assert.equal(resolveHandoff(h.id, 'done', HUMAN_OWNER).leaseHolder, HUMAN_OWNER);
  clearLeases();
  acquireLease(DEV, AGENT);
  const h2 = createHandoff(DEV, 'Enter the passcode', AGENT);
  acquireLease(DEV, HUMAN_OWNER, undefined, true);
  dead.add(4242);
  assert.equal(resolveHandoff(h2.id, 'done', HUMAN_OWNER).leaseHolder, HUMAN_OWNER);
});

test('handoff: the requester keeps its lease while it waits, even past the TTL', () => {
  mock.timers.enable({ apis: ['Date'], now: 0 });
  try {
    acquireLease(DEV, AGENT);
    const h = createHandoff(DEV, 'Solve the CAPTCHA', AGENT, 3600);
    mock.timers.tick(DEFAULT_AGENT_LEASE_SEC * 1000 * 2);
    assert.equal(getLease(DEV)?.owner, AGENT);
    resolveHandoff(h.id, 'done', HUMAN_OWNER);
    mock.timers.tick(DEFAULT_AGENT_LEASE_SEC * 1000 + 1000);
    assert.equal(getLease(DEV), null);
  } finally { mock.timers.reset(); }
});

test('handoff: a long wait with nobody reading the lease still ends with the requester holding it (done and timeout)', () => {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  try {
    acquireLease(DEV, AGENT);
    const h = createHandoff(DEV, 'Solve the CAPTCHA', AGENT, 3600);
    mock.timers.tick(DEFAULT_AGENT_LEASE_SEC * 1000 * 3);             // no getLease/checkLease meanwhile
    const r = resolveHandoff(h.id, 'done', HUMAN_OWNER);              // the person did it without Take Over
    assert.equal(r.leaseHolder, AGENT);
    assert.equal(getLease(DEV)?.owner, AGENT);
    const h2 = createHandoff(DEV, 'Enter the 2FA code', AGENT, 900);
    mock.timers.tick(901_000);                                         // nobody answered: timeout
    assert.equal(core.getHandoff(h2.id).state, 'timeout');
    assert.equal(core.getHandoff(h2.id).leaseHolder, AGENT);
    assert.equal(getLease(DEV)?.owner, AGENT);
    mock.timers.tick(DEFAULT_AGENT_LEASE_SEC * 1000 - 1000);           // the TTL restarted at the timeout
    assert.equal(getLease(DEV)?.owner, AGENT);
  } finally { mock.timers.reset(); }
});

test('Hand Back: the device returns to the agent the person took it from, and Activity says so', () => {
  acquireLease(DEV, AGENT, 300);
  const t = acquireLease(DEV, HUMAN_OWNER, undefined, true);                       // Take Over pre-empts the agent
  assert.equal(t.preempted?.owner, AGENT);
  assert.equal(t.preempted?.ttlSec, 300);
  assert.equal(getLease(DEV)?.owner, HUMAN_OWNER);
  const r = releaseLease(DEV, HUMAN_OWNER);                       // Hand Back
  assert.equal(r.released, true); assert.equal(r.returnedTo, AGENT);
  const l = getLease(DEV);
  assert.equal(l?.owner, AGENT); assert.equal(l?.ttlSec, 300); assert.ok(l?.expiresAt);
  assert.equal(l?.preempted, undefined);
  const hb = (core.readActions(DEV, 20) as { action: { action: string; returnedTo?: string; summary?: string } }[]).filter((a) => a.action.action === 'lease.hand_back').at(-1);
  assert.equal(hb?.action.returnedTo, AGENT); assert.equal(hb?.action.summary, 'Handed back to Claude Code');
  checkLease(DEV, AGENT);                                         // the agent can carry on
  assert.equal(conflict(() => checkLease(DEV, OTHER)).code, 'lease_conflict');
});

test('Hand Back: the pre-empted agent is remembered across repeated Take Over calls', () => {
  acquireLease(DEV, AGENT);
  acquireLease(DEV, HUMAN_OWNER, undefined, true); acquireLease(DEV, HUMAN_OWNER, undefined, true);
  assert.equal(getLease(DEV)?.preempted?.owner, AGENT);
  assert.equal(releaseLease(DEV, HUMAN_OWNER).returnedTo, AGENT);
});

test('Hand Back: an agent that has quit is not given the device back; the device is released and the note says so', () => {
  acquireLease(DEV, AGENT);
  acquireLease(DEV, HUMAN_OWNER, undefined, true);
  dead.add(4242);
  const r = releaseLease(DEV, HUMAN_OWNER);
  assert.equal(r.released, true); assert.equal(r.returnedTo, undefined);
  assert.match(r.note ?? '', /Claude Code is no longer running/);
  assert.equal(getLease(DEV), null);
  const hb = (core.readActions(DEV, 20) as { action: { action: string; previousAgent?: string; summary?: string } }[]).filter((a) => a.action.action === 'lease.hand_back').at(-1);
  assert.equal(hb?.action.previousAgent, AGENT); assert.match(hb?.action.summary ?? '', /is gone, so the phone is free/);
});

test('Hand Back: with no agent before the person, the device is simply released', () => {
  acquireLease(DEV, HUMAN_OWNER, undefined, true);
  const r = releaseLease(DEV, HUMAN_OWNER);
  assert.equal(r.released, true); assert.equal(r.returnedTo, undefined); assert.equal(getLease(DEV), null);
});

test('shutting a device down ends the lease', () => {
  acquireLease(DEV, HUMAN_OWNER, undefined, true);
  core.dropLeaseOnStop(DEV);
  assert.equal(getLease(DEV), null);
});

test('ownerLabel reads owner ids as names', () => {
  assert.equal(core.ownerLabel('mcp:claude-code:4242'), 'Claude Code');
  assert.equal(core.ownerLabel('mcp:codex:1'), 'Codex');
  assert.equal(core.ownerLabel('sdk:77'), 'an SDK script');
});
