// Delivery and retry safety of input routes (delivery.ts), and the `expect` rules (expect.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhoneDockError } from '../core/types.ts';
import type { Ctx } from './http.ts';

process.env.PHONEDOCK_HOME = mkdtempSync(join(tmpdir(), 'pd-delivery-'));   // logAction writes under it
const { combineDelivery, deliveryOf, inputRoute, retrySafe } = await import('./delivery.ts');
const { judgeExpect, parseExpect } = await import('./expect.ts');
const { actionCount, logAction } = await import('./core.ts');

test('delivery of a failed input: own word, then what was sent before, then the error code', () => {
  const pre = new PhoneDockError('x', 'lease_conflict', 409);
  assert.equal(deliveryOf(pre, false), 'not_sent');
  assert.equal(deliveryOf(new PhoneDockError('x', 'bad_request', 400), false), 'not_sent');
  assert.equal(deliveryOf(new PhoneDockError('x', 'stale_ref', 409), false), 'not_sent');
  assert.equal(deliveryOf(new PhoneDockError('x', 'exec_failed', 500), false), 'unknown');      // adb died mid-command
  assert.equal(deliveryOf(new Error('boom'), false), 'unknown');
  assert.equal(deliveryOf(new PhoneDockError('x', 'exec_failed', 500, undefined, undefined, 'not_sent'), false), 'not_sent');   // adb said: device offline
  assert.equal(deliveryOf(pre, true), 'sent');                                                    // a later step failed
  assert.equal(deliveryOf(new PhoneDockError('x', 'delivery_unknown', 502, undefined, undefined, 'unknown'), true), 'unknown');
  assert.equal(retrySafe('not_sent'), true); assert.equal(retrySafe('sent'), false); assert.equal(retrySafe('unknown'), false);
  assert.equal(combineDelivery(['not_sent', 'not_sent']), 'not_sent');
  assert.equal(combineDelivery(['sent', 'not_sent']), 'sent');
  assert.equal(combineDelivery(['sent', 'unknown']), 'unknown');
});

const ctx = (id: string) => ({ params: { id } } as unknown as Ctx);
const run = (id: string, h: () => Promise<unknown>) => Promise.resolve(inputRoute(h)(ctx(id))).catch((e: unknown) => e);
test('inputRoute: results say sent / not_sent from the actions logged; errors carry delivery', async () => {
  const id = 'android-emulator:pdtest-delivery';
  const sent = await run(id, async () => { logAction(id, 'test', { action: 'tap', x: 1, y: 2 }); return { ok: true }; });
  assert.deepEqual(sent, { ok: true, delivery: 'sent', retrySafe: false });
  const none = await run(id, async () => ({ ok: true, found: true, scrolls: 0 }));
  assert.deepEqual(none, { ok: true, found: true, scrolls: 0, delivery: 'not_sent', retrySafe: true });
  // the first tap went in, the second failed before sending: sent (partly), not safe to resend the request
  const e1 = await run(id, async () => { logAction(id, 'test', { action: 'tap', x: 1, y: 2 }); throw new PhoneDockError('x', 'stale_ref', 409); });
  assert.equal((e1 as PhoneDockError).delivery, 'sent');
  const e2 = await run(id, async () => { throw new PhoneDockError('x', 'lease_conflict', 409); });
  assert.equal((e2 as PhoneDockError).delivery, 'not_sent');
  const e3 = await run(id, async () => { throw new TypeError('bug'); });
  assert.ok(e3 instanceof PhoneDockError); assert.equal(e3.code, 'internal'); assert.equal(e3.delivery, 'unknown');
  assert.ok((actionCount.get(id) ?? 0) >= 2);
});

test('parseExpect: one shape for every input, checked before anything is sent', () => {
  assert.deepEqual(parseExpect({ visible: 'Welcome' }), { visible: 'Welcome' });
  assert.deepEqual(parseExpect('Welcome'), { visible: 'Welcome' });
  assert.deepEqual(parseExpect({ gone: 'Loading', match: 'exact', timeoutMs: 2000 }), { gone: 'Loading', match: 'exact', timeoutMs: 2000 });
  assert.deepEqual(parseExpect({ id: 'submit' }), { id: 'submit' });
  assert.deepEqual(parseExpect({ changed: true }), { changed: true });
  assert.equal(parseExpect(undefined), undefined);
  assert.equal(parseExpect(null), undefined);
  const bad = (v: unknown, re: RegExp) => assert.throws(() => parseExpect(v), (e: PhoneDockError) => e.code === 'bad_request' && re.test(e.detail ?? ''));
  bad({ visible: 'a', gone: 'b' }, /exactly one of visible, gone, id, changed/);
  bad({}, /exactly one/);
  bad({ visibel: 'a' }, /Unknown expect key visibel/);
  bad({ visible: '' }, /non-empty string/);
  bad({ visible: 'a', match: 'fuzzy' }, /contains \| exact \| regex/);
  bad({ visible: 'a', timeoutMs: -1 }, /milliseconds/);
  bad([1], /must be an object/);
  assert.equal(parseExpect({ visible: 'a', timeoutMs: 999_999 })!.timeoutMs, 60_000);
});

test('expect outcomes: verified, screen unchanged, changed but not found', () => {
  const v = { visible: 'Welcome' };
  assert.deepEqual(judgeExpect(v, true, true, 420), { ok: true, outcome: 'verified', message: 'Verified: "Welcome" is on screen (0.4 s).' });
  assert.match(judgeExpect(v, true, false, 300, true).message, /it was already there before the input and the screen did not change/);
  assert.deepEqual(judgeExpect(v, false, false, 5000), { ok: false, outcome: 'screen_unchanged', message: 'Not verified: the screen did not change in 5.0 s; "Welcome" is not on it.' });
  assert.deepEqual(judgeExpect(v, false, true, 5000), { ok: false, outcome: 'changed_not_found', message: 'Not verified: the screen changed, but "Welcome" never appeared (5.0 s).' });
  assert.equal(judgeExpect({ gone: 'Loading' }, false, true, 5000).message, 'Not verified: the screen changed, but "Loading" is still there after 5.0 s.');
  assert.equal(judgeExpect({ gone: 'Loading' }, false, false, 5000).message, 'Not verified: the screen did not change in 5.0 s; "Loading" is still there.');
  assert.equal(judgeExpect({ id: 'submit' }, true, true, 800).message, 'Verified: id submit is on screen (0.8 s).');
  assert.equal(judgeExpect({ changed: true }, true, true, 250).message, 'Verified: the screen changed (0.3 s).');
  assert.equal(judgeExpect({ changed: true }, false, false, 5000).outcome, 'screen_unchanged');
  // no reading before the input: no claim about change
  assert.equal(judgeExpect(v, false, null, 5000).message, 'Not verified: "Welcome" never appeared (5.0 s).');
});
