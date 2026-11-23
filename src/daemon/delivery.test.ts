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

test('delivery belongs to the request, never a concurrent action or lease event', async () => {
  const id = 'fake:pdtest-delivery-race';
  let resume!: () => void;
  const gate = new Promise<void>((r) => { resume = r; });
  const pending = run(id, async () => { await gate; throw new PhoneDockError('No input', 'bad_request', 400); });
  await Promise.resolve();
  logAction(id, 'other', { action: 'tap', x: 1, y: 2 });
  logAction(id, 'test', { action: 'lease.acquire' });
  resume();
  assert.equal((await pending as PhoneDockError).delivery, 'not_sent');
});

test('input requests serialize per device, while independent devices proceed', async () => {
  const calls: string[] = [];
  let resume!: () => void;
  const gate = new Promise<void>((r) => { resume = r; });
  const a = run('fake:pdtest-queue', async () => { calls.push('first'); await gate; calls.push('done'); return {}; });
  await new Promise((r) => setImmediate(r));
  const b = run('fake:pdtest-queue', async () => { calls.push('second'); return {}; });
  await run('fake:pdtest-independent', async () => { calls.push('independent'); return {}; });
  assert.deepEqual(calls, ['first', 'independent']);
  resume(); await Promise.all([a, b]);
  assert.deepEqual(calls, ['first', 'independent', 'done', 'second']);
});

test('backend validation failures stay not_sent; transport failures stay unknown', async () => {
  const { guardedBackendCall } = await import('./execution.ts');
  const id = 'fake:pdtest-preflight';
  const fail = (error: Error) => run(id, async () => guardedBackendCall('fake', 'tap', ['pdtest-preflight'], () => { throw error; }));
  assert.equal((await fail(new PhoneDockError('Unavailable', 'not_supported', 501)) as PhoneDockError).delivery, 'not_sent');
  assert.equal((await fail(new Error('Connection reset')) as PhoneDockError).delivery, 'unknown');
});

test('human takeover fences the remaining primitives of an input batch', async () => {
  const core = await import('./core.ts');
  const { router } = await import('./routes.ts');
  const { instrumentBackend } = await import('./metrics.ts');
  const id = 'fake-takeover:pdtest-batch'; let taps = 0;
  const backend = instrumentBackend({ id: 'fake-takeover', platform: 'ios',
    async tap() { if (++taps === 1) core.acquireLease(id, core.HUMAN_OWNER, undefined, true); },
  }, 'fake-takeover');
  core.backends.push(backend as never);
  core.acquireLease(id, 'test-agent');
  const route = router.match('POST', `/v1/devices/${id}/input`);
  assert.ok(route && route !== 'method');
  try {
    await assert.rejects(Promise.resolve(route.h({ params: { id }, owner: 'test-agent',
      body: async () => ({ actions: [{ action: 'tap', x: 1, y: 2 }, { action: 'tap', x: 3, y: 4 }] }), q: () => undefined,
    } as unknown as Ctx)), (e: PhoneDockError) => e.code === 'lease_conflict' && e.delivery === 'sent');
    assert.equal(taps, 1);
  } finally { core.clearLeases(); core.backends.splice(core.backends.indexOf(backend as never), 1); }
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

test('inputRoute returnUi + settleMs: validates options, reuses expect tree, sets screenHash/prompt, scrubs secrets without blanking UI, and handles capture failure', async () => {
  const core = await import('./core.ts');
  const { router } = await import('./routes.ts');
  const { instrumentBackend } = await import('./metrics.ts');
  const id = 'fake-obs:pdtest-obs';
  let uiReads = 0;
  let failUi = false;
  let label = 'Welcome Home';
  const sampleTree = () => ({
    source: 'accessibility' as const,
    screen: { width: 1080, height: 2400 },
    capturedAt: new Date().toISOString(),
    root: [
      { ref: 'e1', type: 'Button', text: label, clickable: true, bounds: { x: 10, y: 100, width: 200, height: 60 } },
      { ref: 'e2', type: 'Text', text: 'Secret: secret-token-9988', bounds: { x: 10, y: 200, width: 300, height: 60 } },
    ],
  });
  const backend = instrumentBackend({
    id: 'fake-obs',
    platform: 'android',
    async tap() { label = 'Welcome Home'; },
    async launchApp() {},
    async foregroundApp() { return { id: 'com.example.app' }; },
    async uiTree() {
      uiReads++;
      if (failUi) throw new Error('tree failed');
      return sampleTree();
    },
  }, 'fake-obs');
  core.backends.push(backend as never);
  const inputRouteMatch = router.match('POST', `/v1/devices/${id}/input`);
  const launchRouteMatch = router.match('POST', `/v1/devices/${id}/apps/com.example.app/launch`);
  assert.ok(inputRouteMatch && inputRouteMatch !== 'method');
  assert.ok(launchRouteMatch && launchRouteMatch !== 'method');
  const callInput = (body: unknown) => Promise.resolve(inputRouteMatch.h({
    params: inputRouteMatch.params, owner: 'mcp:test:1', body: async () => body, q: () => undefined,
  } as unknown as Ctx));
  const callLaunch = (body: unknown) => Promise.resolve(launchRouteMatch.h({
    params: launchRouteMatch.params, owner: 'mcp:test:1', body: async () => body, q: () => undefined,
  } as unknown as Ctx));

  try {
    // 1) Invalid returnUi / settleMs rejected with 400 bad_request, delivery=not_sent
    for (const bad of [{ action: 'tap', x: 1, y: 2, returnUi: 'yes' }, { action: 'tap', x: 1, y: 2, settleMs: -1 }, { action: 'tap', x: 1, y: 2, settleMs: 10001 }, { action: 'tap', x: 1, y: 2, settleMs: 1.5 }]) {
      await assert.rejects(callInput(bad), (e: unknown) => e instanceof PhoneDockError && e.status === 400 && e.code === 'bad_request' && e.delivery === 'not_sent');
    }

    // 2) returnUi with settleMs waits and attaches screenHash, snapshotId, prompt
    uiReads = 0;
    const t0 = Date.now();
    const r1 = await callInput({ action: 'tap', x: 10, y: 20, returnUi: true, settleMs: 120 }) as { ui?: { screenHash?: string; snapshotId?: string; prompt?: unknown }; delivery?: string };
    assert.ok(Date.now() - t0 >= 110, 'expected settleMs delay');
    assert.equal(r1.delivery, 'sent');
    assert.equal(uiReads, 1);
    assert.match(r1.ui?.screenHash ?? '', /^[0-9a-f]{16}$/);
    assert.ok(r1.ui?.snapshotId);
    assert.equal(r1.ui?.prompt, null);

    // 3) returnUi with expect reuses the fresh expect tree with zero extra uiTree reads and no extra settle wait
    label = 'Before Tap';
    await callInput({ action: 'tap', x: 1, y: 1 }); // puts 'Welcome Home' on screen after tap; seed pre-tap cache below
    label = 'Before Tap';
    core.uiCache.set(id, { ...sampleTree(), actionGeneration: core.actionCount.get(id) ?? 0 });
    uiReads = 0;
    const tExpect = Date.now();
    const r2 = await callInput({ action: 'tap', x: 10, y: 20, expect: { visible: 'Welcome Home', timeoutMs: 2000 }, returnUi: true, settleMs: 500 }) as { ui?: { screenHash?: string }; expect?: { ok: boolean } };
    assert.equal(r2.expect?.ok, true);
    assert.equal(uiReads, 1, `expected single post-action uiTree read reused by returnUi, got ${uiReads}`);
    assert.ok(Date.now() - tExpect < 450, 'must not sleep settleMs when expect already waited');
    assert.equal(r2.ui?.screenHash, r1.ui?.screenHash);

    // 4) Secret launch with returnUi redacts secret substrings WITHOUT blanking unrelated UI labels
    const r3 = await callLaunch({ args: { token: 'secret-token-9988' }, returnUi: true, settleMs: 0 }) as { ui?: { root: { text?: string }[] } };
    assert.equal(r3.ui?.root[0].text, 'Welcome Home');
    assert.equal(r3.ui?.root[1].text, 'Secret: •••');

    // 5) Capture failure never fails an already-sent action; sets observationUnavailable: true
    failUi = true;
    const r4 = await callInput({ action: 'tap', x: 10, y: 20, returnUi: true, settleMs: 0 }) as { ok?: boolean; delivery?: string; observationUnavailable?: boolean; ui?: unknown };
    assert.equal(r4.ok, true);
    assert.equal(r4.delivery, 'sent');
    assert.equal(r4.observationUnavailable, true);
    assert.equal(r4.ui, undefined);
  } finally {
    failUi = false;
    core.clearLaunchSecrets(id);
    core.backends.splice(core.backends.indexOf(backend as never), 1);
  }
});

test('inputRoute returnUi OCR fallback registers uiCache + snapshot so tap(ref) works immediately', async () => {
  const core = await import('./core.ts');
  const { router } = await import('./routes.ts');
  const { instrumentBackend } = await import('./metrics.ts');
  const { setOcrTreeReaderForTests } = await import('./delivery.ts');
  const id = 'fake-ocr:pdtest-ocr';
  const taps: { x: number; y: number }[] = [];

  const backend = instrumentBackend({
    id: 'fake-ocr',
    platform: 'ios',
    async tap(_nid: string, x: number, y: number) { taps.push({ x, y }); },
    async screenshot() { return Buffer.from([0x89, 0x50, 0x4e, 0x47]); },
    // No uiTree -> triggers OCR fallback in withUiObservation
  }, 'fake-ocr');
  core.backends.push(backend as never);
  const inputRouteMatch = router.match('POST', `/v1/devices/${id}/input`);
  assert.ok(inputRouteMatch && inputRouteMatch !== 'method');
  const callInput = (body: unknown) => Promise.resolve(inputRouteMatch.h({
    params: inputRouteMatch.params, owner: 'mcp:test:1', body: async () => body, q: () => undefined,
  } as unknown as Ctx));

  // Seed an older snapshot in uiCache so we verify OCR replaces it rather than binding to the old tree
  core.uiCache.set(id, {
    source: 'accessibility',
    screen: { width: 1000, height: 2000 },
    capturedAt: new Date(Date.now() - 60_000).toISOString(),
    snapshotId: 'old-snap',
    root: [{ ref: 'e1', type: 'Button', text: 'Stale Button', bounds: { x: 10, y: 10, width: 40, height: 40 } }],
  });

  setOcrTreeReaderForTests(async () => ({
    source: 'ocr',
    screen: { width: 1000, height: 2000 },
    capturedAt: new Date().toISOString(),
    root: [{ ref: 'e1', type: 'Text', text: 'Continue', bounds: { x: 400, y: 900, width: 200, height: 80 } }],
  }));

  try {
    const obs = await callInput({ action: 'tap', x: 5, y: 5, returnUi: true, settleMs: 0 }) as {
      delivery?: string;
      ui?: { source: string; snapshotId?: string; screenHash?: string; root: { ref: string; text?: string }[] };
    };
    assert.equal(obs.delivery, 'sent');
    assert.equal(obs.ui?.source, 'ocr');
    assert.ok(obs.ui?.snapshotId && obs.ui.snapshotId !== 'old-snap', 'OCR fallback must register a fresh snapshotId');
    assert.match(obs.ui?.screenHash ?? '', /^[0-9a-f]{16}$/);
    assert.equal(core.uiCache.get(id)?.snapshotId, obs.ui.snapshotId);

    // Immediate tap(ref="e1", snapshotId) must succeed and hit the OCR element's center (500, 940), NOT stale_ref or old-snap (30, 30)
    taps.length = 0;
    const tapRes = await callInput({ action: 'tap', ref: 'e1', snapshotId: obs.ui.snapshotId }) as {
      delivery?: string;
      resolved?: { ref: string; x: number; y: number };
    };
    assert.equal(tapRes.delivery, 'sent');
    assert.deepEqual(taps, [{ x: 500, y: 940 }]);
    assert.equal(tapRes.resolved?.x, 500);
    assert.equal(tapRes.resolved?.y, 940);
  } finally {
    setOcrTreeReaderForTests(undefined);
    core.uiCache.delete(id);
    core.backends.splice(core.backends.indexOf(backend as never), 1);
  }
});
