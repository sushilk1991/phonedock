import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lockGuard } from './ios-lock.ts';

function fake(states: (boolean | null | Error)[]) {
  let i = 0; let calls = 0;
  const probe = async () => { calls++; const s = states[Math.min(i++, states.length - 1)]; if (s instanceof Error) throw s; return s; };
  return { probe, calls: () => calls };
}

test('first input checks once; an unlocked phone is not checked again within the TTL', async () => {
  let t = 0; const f = fake([false]);
  const g = lockGuard(f.probe, () => t, 10_000);
  await g.refuseIfLocked('u'); t = 5000; await g.refuseIfLocked('u');
  assert.equal(f.calls(), 1);
});

test('a locked phone is refused with device_locked and nothing else happens', async () => {
  const f = fake([true]);
  const g = lockGuard(f.probe, () => 0);
  await assert.rejects(g.refuseIfLocked('u'), (e: any) => e.code === 'device_locked' && e.status === 409);
});

test('a phone last seen locked is checked again before each input, so it works once unlocked', async () => {
  const f = fake([true, false]);
  const g = lockGuard(f.probe, () => 0);
  await assert.rejects(g.refuseIfLocked('u'));
  await g.refuseIfLocked('u');
  assert.equal(f.calls(), 2);
});

test('a stale unlocked answer is refreshed in the background; the next input sees the lock', async () => {
  let t = 0; const f = fake([false, true]);
  const g = lockGuard(f.probe, () => t, 10_000);
  await g.refuseIfLocked('u');
  t = 11_000;
  await g.refuseIfLocked('u');                 // passes on the old answer, starts a refresh
  await new Promise((r) => setImmediate(r));
  await assert.rejects(g.refuseIfLocked('u'), (e: any) => e.code === 'device_locked');
});

test('an unknown lock state (probe failed or null) never refuses', async () => {
  const g1 = lockGuard(fake([new Error('devicectl failed')]).probe, () => 0);
  await g1.refuseIfLocked('u');
  const g2 = lockGuard(fake([null]).probe, () => 0);
  await g2.refuseIfLocked('u');
});

test('phones are tracked separately', async () => {
  const seen: string[] = [];
  const g = lockGuard(async (u) => { seen.push(u); return u === 'locked'; }, () => 0);
  await g.refuseIfLocked('free');
  await assert.rejects(g.refuseIfLocked('locked'));
  assert.deepEqual(seen, ['free', 'locked']);
});
