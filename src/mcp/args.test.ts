// MCP arguments: aliases, unknown names, and `expect` on input tools (pure + over an in-memory transport).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Device, ExpectReport, PhoneDockClient } from '../sdk/client.ts';
import { PhoneDockApiError } from '../sdk/client.ts';
import { createMcpServer } from './server.ts';
import { closestArg, expectLine, normalizeArgs, toExpect } from './args.ts';

const SWIPE = ['device', 'direction', 'distance', 'x1', 'y1', 'x2', 'y2', 'duration_ms', 'coordinate_space', 'return_screenshot', 'settle_ms', 'expect'];

test('swipe aliases become x1/y1/x2/y2', () => {
  assert.deepEqual(normalizeArgs('swipe', { from_x: 1, from_y: 2, to_x: 3, to_y: 4 }, SWIPE), { x1: 1, y1: 2, x2: 3, y2: 4 });
  assert.deepEqual(normalizeArgs('swipe', { start_x: 1, start_y: 2, end_x: 3, end_y: 4, duration_ms: 500 }, SWIPE), { x1: 1, y1: 2, x2: 3, y2: 4, duration_ms: 500 });
  assert.deepEqual(normalizeArgs('swipe', { x1: 5, from_x: 5 }, SWIPE), { x1: 5 });              // the same value twice is fine
  assert.throws(() => normalizeArgs('swipe', { x1: 5, from_x: 6 }, SWIPE), /from_x is another name for x1; pass one of them, not both/);
  assert.throws(() => normalizeArgs('tap', { from_x: 1 }, ['x', 'y']), /tap has no argument named from_x/);   // aliases are per tool
});

test('unknown arguments are named, with a guess and the valid list', () => {
  assert.throws(() => normalizeArgs('swipe', { direction: 'up', duraton_ms: 300, foo: 1 }, SWIPE),
    (e: Error) => /^swipe has no arguments named duraton_ms \(did you mean duration_ms\?\), foo\. Valid arguments: device, direction, distance, x1, y1, x2, y2, duration_ms, coordinate_space, return_screenshot, settle_ms, expect\.$/.test(e.message));
  // another spelling of a valid name or alias is that name
  assert.deepEqual(normalizeArgs('swipe', { durationMs: 300, fromX: 1, FROM_Y: 2, toX: 3, toY: 4 }, SWIPE), { duration_ms: 300, x1: 1, y1: 2, x2: 3, y2: 4 });
  assert.deepEqual(normalizeArgs('tap', { elementId: 'ok' }, ['element_id', 'text']), { element_id: 'ok' });
  assert.equal(closestArg('elementId', ['element_id', 'text']), 'element_id');
  assert.equal(closestArg('txt', ['text', 'ref']), 'text');
  assert.equal(closestArg('zzz', ['text', 'ref']), undefined);
  assert.deepEqual(normalizeArgs('get_ui', undefined, ['device']), {});
});

test('expect: MCP shape → daemon shape, and the result line', () => {
  assert.deepEqual(toExpect({ visible: 'Welcome', timeout_ms: 2000 }), { visible: 'Welcome', timeoutMs: 2000 });
  assert.deepEqual(toExpect({ changed: true }), { changed: true });
  assert.equal(toExpect(undefined), undefined);
  assert.throws(() => toExpect({ visible: 'a', gone: 'b' }), /exactly one of visible, gone, id or changed/);
  assert.throws(() => toExpect({ match: 'exact' }), /exactly one/);
  const ok: ExpectReport = { ok: true, outcome: 'verified', expected: '"Welcome" visible', message: 'Verified: "Welcome" is on screen (0.4 s).', elapsedMs: 400, polls: 2, changed: true };
  assert.deepEqual(expectLine(ok, 'tap'), { line: 'Verified: "Welcome" is on screen (0.4 s).', failed: false });
  const bad: ExpectReport = { ok: false, outcome: 'screen_unchanged', expected: '"Welcome" visible', message: 'Not verified: the screen did not change in 5.0 s; "Welcome" is not on it.', elapsedMs: 5000, polls: 12, changed: false, summary: 'Settings: Network, Apps' };
  assert.deepEqual(expectLine(bad, 'tap'), { line: 'Not verified: the screen did not change in 5.0 s; "Welcome" is not on it. The tap was sent: don\'t resend it blindly. Screen now: Settings: Network, Apps', failed: true });
});

// ── over MCP ────────────────────────────────────────────────────────────────
function fake(expectReport?: ExpectReport, fail?: PhoneDockApiError) {
  const dev = { id: 'android-emulator:pdtest-x', nativeId: 'pdtest-x', name: 'pdtest-x', backend: 'android-emulator', platform: 'android',
    kind: 'virtual', state: 'running', managed: true, capabilities: [], screen: { width: 1080, height: 2400, scale: 1 } } as unknown as Device;
  const calls: unknown[][] = [];
  return {
    calls, owner: 'test',
    devices: async () => [dev], resolveDevice: async () => dev,
    screen: async () => ({ width: 1080, height: 2400, scale: 1 }),
    swipe: async (_id: string, x1: number, y1: number, x2: number, y2: number, ms?: number, opts?: unknown) => { calls.push(['swipe', x1, y1, x2, y2, ms, opts]); return { ok: true, delivery: 'sent', retrySafe: false }; },
    tap: async (_id: string, x: number, y: number, _l?: string, meta?: { expect?: unknown }) => {
      calls.push(['tap', x, y, meta?.expect]);
      if (fail) throw fail;
      return { ok: true, delivery: 'sent', retrySafe: false, ...(expectReport ? { expect: expectReport } : {}) };
    },
  };
}
async function connect(f: ReturnType<typeof fake>) {
  const server = createMcpServer({ client: f as unknown as PhoneDockClient, scales: new Map() });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }) as { content: { type: string; text?: string }[]; isError?: boolean };
    return { text: r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'), isError: !!r.isError };
  };
  return { call, close: () => client.close() };
}

test('MCP swipe(from_x…) swipes those coordinates; an unknown name is an error, not a silent default', async () => {
  const f = fake(); const { call, close } = await connect(f);
  try {
    const r = await call('swipe', { from_x: 540, from_y: 1500, to_x: 540, to_y: 600, coordinate_space: 'device' });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(f.calls[0].slice(0, 5), ['swipe', 540, 1500, 540, 600]);
    const u = await call('swipe', { from_x: 540, from_y: 1500, to_x: 540, too_y: 600, coordinate_space: 'device' });
    assert.equal(u.isError, true);
    assert.match(u.text, /swipe has no argument named too_y/);
    assert.match(u.text, /Valid arguments: device, direction/);
    assert.equal(f.calls.length, 1, 'nothing was swiped for the bad call');
    // batch steps get the same check
    const b = await call('batch', { steps: [{ tool: 'tap', args: { xx: 1 } }] });
    assert.equal(b.isError, true);
    assert.match(b.text, /tap has no argument named xx/);
  } finally { await close(); }
});

test('MCP wait takes ms or seconds (schema-checking clients refuse a call the schema lacks), and needs one', async () => {
  const f = fake(); const { call, close } = await connect(f);
  try {
    const s = await call('wait', { seconds: 0.01 });
    assert.equal(s.isError, false, s.text); assert.match(s.text, /Waited 10 ms/);
    const m = await call('wait', { ms: 5 });
    assert.equal(m.isError, false, m.text); assert.match(m.text, /Waited 5 ms/);
    const none = await call('wait', {});
    assert.equal(none.isError, true); assert.match(none.text, /wait needs ms \(milliseconds\) or seconds/);
    const both = await call('wait', { ms: 5, seconds: 1 });
    assert.equal(both.isError, true); assert.match(both.text, /not both/);
  } finally { await close(); }
});

test('MCP tap with expect: verified, or not verified with "was sent"; delivery errors say whether retry is safe', async () => {
  const report: ExpectReport = { ok: false, outcome: 'changed_not_found', expected: '"Welcome" visible', message: 'Not verified: the screen changed, but "Welcome" never appeared (5.0 s).', elapsedMs: 5000, polls: 10, changed: true };
  let f = fake(report); let s = await connect(f);
  try {
    const r = await s.call('tap', { x: 100, y: 200, coordinate_space: 'device', expect: { visible: 'Welcome', timeout_ms: 5000 } });
    assert.deepEqual(f.calls[0], ['tap', 100, 200, { visible: 'Welcome', timeoutMs: 5000 }]);
    assert.equal(r.isError, true);
    assert.match(r.text, /^Tapped \(100,200\)\.\nNot verified: the screen changed, but "Welcome" never appeared \(5\.0 s\)\. The tap was sent: don't resend it blindly\./);
    const bad = await s.call('tap', { x: 1, y: 2, expect: { visible: 'a', bogus: 1 } });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /bogus/);
  } finally { await s.close(); }
  f = fake(undefined, new PhoneDockApiError('The tap may or may not have reached the device', 'delivery_unknown', 502, [], undefined, 'unknown')); s = await connect(f);
  try {
    const r = await s.call('tap', { x: 1, y: 2, coordinate_space: 'device' });
    assert.equal(r.isError, true);
    assert.match(r.text, /Delivery unknown: it may have reached the device\. Check get_ui or a screenshot before retrying\./);
  } finally { await s.close(); }
  f = fake(undefined, new PhoneDockApiError('The device is held by someone else', 'lease_conflict', 409, [], undefined, 'not_sent')); s = await connect(f);
  try {
    const r = await s.call('tap', { x: 1, y: 2, coordinate_space: 'device' });
    assert.match(r.text, /Not sent: nothing reached the device, so retrying is safe\./);
  } finally { await s.close(); }
});
