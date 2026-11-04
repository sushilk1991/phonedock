import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fallbackFrame, waitForStreamFrame, type FallbackFrame } from './core.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type S = { fallback?: FallbackFrame; fallbackPending?: Promise<FallbackFrame>; fallbackCaptures: number };

test('fallbackFrame: concurrent callers share one capture', async () => {
  const s: S = { fallbackCaptures: 0 };
  let calls = 0;
  const capture = async () => { calls++; await sleep(20); return { data: Buffer.from('jpeg-1'), headers: { 'X-Image-Width': 1 } }; };
  const all = await Promise.all(Array.from({ length: 10 }, () => fallbackFrame(s, capture)));
  assert.equal(calls, 1);
  assert.equal(s.fallbackCaptures, 1);
  assert.ok(all.every((f) => f === all[0]));
  assert.match(all[0].etag, /^"[0-9a-f]{32}"$/);
  assert.equal(s.fallbackPending, undefined);
});

test('fallbackFrame: at most one capture per interval; in-flight refresh serves the previous frame', async () => {
  const s: S = { fallbackCaptures: 0 };
  let n = 0;
  const capture = async () => { n++; await sleep(10); return { data: Buffer.from(`jpeg-${n}`), headers: {} }; };
  const a = await fallbackFrame(s, capture, 1000);
  const b = await fallbackFrame(s, capture, 1000);            // within the interval: cached
  assert.equal(n, 1); assert.equal(b, a);
  const t = a.at + 1500;
  const c = await fallbackFrame(s, capture, 1000, t);         // stale: refresh starts, caller gets the old frame now
  assert.equal(c, a); assert.equal(n, 2);
  const d = await fallbackFrame(s, capture, 1000, t);         // still in flight: no second capture
  assert.equal(d, a); assert.equal(n, 2);
  await s.fallbackPending;
  assert.notEqual(s.fallback, a);
  assert.notEqual(s.fallback!.etag, a.etag);                   // new bytes → new ETag
});

test('fallbackFrame: identical bytes keep the ETag (polls keep getting 304)', async () => {
  const s: S = { fallbackCaptures: 0 };
  const capture = async () => ({ data: Buffer.from('same'), headers: {} });
  const a = await fallbackFrame(s, capture, 0);
  await sleep(2);
  await fallbackFrame(s, capture, 0);
  await s.fallbackPending;
  assert.equal(s.fallback!.etag, a.etag);
  assert.equal(s.fallbackCaptures, 2);
});

test('fallbackFrame: a failed first capture rejects and the next call retries', async () => {
  const s: S = { fallbackCaptures: 0 };
  let n = 0;
  const capture = async () => { if (++n === 1) throw new Error('boom'); return { data: Buffer.from('ok'), headers: {} }; };
  await assert.rejects(fallbackFrame(s, capture), /boom/);
  const f = await fallbackFrame(s, capture);
  assert.equal(f.data.toString(), 'ok');
});

test('waitForStreamFrame: resolves on the next frame, on timeout, or on abort, and cleans up its listener', async () => {
  const s = { latest: undefined as Buffer | undefined, listeners: new Set<(j: Buffer) => void>() };
  const p = waitForStreamFrame(s, 1000);
  assert.equal(s.listeners.size, 1);
  for (const l of [...s.listeners]) l(Buffer.from('x'));
  assert.equal(await p, true);
  assert.equal(s.listeners.size, 0);
  assert.equal(await waitForStreamFrame(s, 5), false);
  assert.equal(s.listeners.size, 0);
  const ac = new AbortController();
  const q = waitForStreamFrame(s, 10_000, ac.signal);
  ac.abort();
  assert.equal(await q, false);
  assert.equal(s.listeners.size, 0);
  s.latest = Buffer.from('y');
  assert.equal(await waitForStreamFrame(s, 0), true);
});
