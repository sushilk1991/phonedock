// GET / PUT / POST /v1/devices/:id/clipboard against fake backends, through the daemon's router: what reaches the
// backend, validation, leases, not_supported, and that the text never reaches the Activity log or SSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhoneDockError, type Backend } from '../core/types.ts';
import type { Ctx } from './http.ts';

process.env.PHONEDOCK_HOME = mkdtempSync(join(tmpdir(), 'pd-clipboard-'));   // actions.jsonl goes under it
delete process.env.PHONEDOCK_DEVICE_FILTER;
const core = await import('./core.ts');
const { router } = await import('./routes.ts');
const { MAX_CLIPBOARD_CHARS } = await import('./routes-extra.ts');

let clip: string | null = null;
let failSet: Error | undefined;
const sets: { nid: string; text: string }[] = [];
const base = {
  displayName: 'Fake', platform: 'android', kind: 'virtual', available: async () => ({ ok: true }), listDevices: async () => [],
  screenshot: async () => Buffer.alloc(0), tap: async () => {}, swipe: async () => {}, type: async () => {}, key: async () => {},
};
const fake = {
  ...base, id: 'fake-clip', capabilities: ['clipboard'],
  async clipboardGet() { return clip; },
  async clipboardSet(nid: string, text: string) { if (failSet) throw failSet; sets.push({ nid, text }); clip = text; },
} as unknown as Backend;
const plain = { ...base, id: 'fake-noclip', capabilities: [] } as unknown as Backend;
core.backends.push(fake, plain);

const DEV = 'fake-clip:pdtest-clip';
async function call(method: string, id: string, body?: unknown, owner = 'mcp:test:1'): Promise<any> {
  const m = router.match(method, `/v1/devices/${encodeURIComponent(id)}/clipboard`);
  assert.ok(m && m !== 'method', `${method} route exists`);
  const c = { params: m.params, owner, body: async () => body ?? {}, q: () => undefined } as unknown as Ctx;
  return m.h(c);
}
async function fails(p: Promise<unknown>): Promise<PhoneDockError> {
  try { await p; } catch (e) { assert.ok(e instanceof PhoneDockError, String(e)); return e; }
  assert.fail('expected an error');
}
const logText = (id: string) => {
  const f = join(process.env.PHONEDOCK_HOME!, 'devices', core.safeId(id), 'actions.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
};

test('GET returns the backend text; empty and missing text read as null', async () => {
  clip = 'https://example.com/invite/abc?ref=copy';
  assert.deepEqual(await call('GET', DEV), { text: 'https://example.com/invite/abc?ref=copy' });
  clip = '';
  assert.deepEqual(await call('GET', DEV), { text: null });
  clip = null;
  assert.deepEqual(await call('GET', DEV), { text: null });
});

test('PUT and POST set the exact text (emoji, newlines, 10 KB); the reply and the log carry the length only', async () => {
  const sse: string[] = [];
  const client = { write: (s: string) => { sse.push(s); return true; } } as never;
  core.sseClients.add(client);
  try {
    const secret = 'OTP 493817 — héllo 👋\nsecond line\n';
    const r = await call('PUT', DEV, { text: secret });
    assert.deepEqual(r, { ok: true, length: [...secret].length });
    assert.equal(sets.at(-1)?.text, secret);
    assert.equal(sets.at(-1)?.nid, 'pdtest-clip');
    const big = 'x'.repeat(10 * 1024);
    assert.deepEqual(await call('POST', DEV, { text: big }), { ok: true, length: 10 * 1024 });
    assert.equal(sets.at(-1)?.text, big);
    assert.deepEqual(await call('PUT', DEV, { text: '' }), { ok: true, length: 0 });
    assert.equal(sets.at(-1)?.text, '');

    const actions = core.readActions(DEV, 10) as { action: { action: string; length: number; text?: unknown } }[];
    const mine = actions.filter((a) => a.action.action === 'clipboard.set');
    assert.deepEqual(mine.map((a) => a.action), [{ action: 'clipboard.set', length: [...secret].length }, { action: 'clipboard.set', length: 10240 }, { action: 'clipboard.set', length: 0 }]);
    for (const leak of ['493817', 'héllo', 'second line', 'xxxxxxxxxx']) {
      assert.ok(!logText(DEV).includes(leak), `actions.jsonl must not contain ${leak}`);
      assert.ok(!sse.join('').includes(leak), `SSE must not contain ${leak}`);
    }
    assert.ok(sse.some((s) => s.includes('"clipboard.set"')), 'the set is announced on SSE');
  } finally { core.sseClients.delete(client); }
});

test('set validation: text must be a string within the limit; nothing is sent or logged otherwise', async () => {
  const before = sets.length; const logged = logText(DEV);
  for (const body of [{}, { text: 42 }, { text: null }, { value: 'x' }]) {
    const e = await fails(call('PUT', DEV, body));
    assert.equal(e.code, 'bad_request'); assert.equal(e.status, 400);
    assert.match(e.detail ?? '', /text must be a string/);
  }
  const e = await fails(call('PUT', DEV, { text: 'é'.repeat(MAX_CLIPBOARD_CHARS + 1) }));
  assert.equal(e.code, 'bad_request');
  assert.match(e.detail ?? '', /too long/);
  assert.ok(!(e.detail ?? '').includes('éé'), 'the error never quotes the text');
  assert.equal(sets.length, before);
  assert.equal(logText(DEV), logged);
});

test('set needs the lease; reading does not', async () => {
  const id = 'fake-clip:pdtest-leased';
  core.acquireLease(id, 'cli:other');   // no pid: never stale
  try {
    clip = 'shared';
    assert.deepEqual(await call('GET', id, undefined, 'mcp:test:1'), { text: 'shared' });
    const e = await fails(call('PUT', id, { text: 'mine' }, 'mcp:test:1'));
    assert.equal(e.code, 'lease_conflict');
    assert.equal(clip, 'shared');
    assert.deepEqual(await call('PUT', id, { text: 'theirs' }, 'cli:other'), { ok: true, length: 6 });
  } finally { core.clearLeases(); }
});

test('a backend without clipboard support: 501 not_supported with a plain message and hints', async () => {
  for (const [method, body] of [['GET', undefined], ['PUT', { text: 'x' }]] as const) {
    const e = await fails(call(method, 'fake-noclip:pdtest-x', body));
    assert.equal(e.code, 'not_supported'); assert.equal(e.status, 501);
    assert.match(e.message, /can’t read or set the clipboard/);
    assert.ok(e.hints?.length, 'has hints');
  }
});

test('a failed set is passed on and not logged', async () => {
  const logged = logText(DEV);
  failSet = new PhoneDockError('Couldn’t set the clipboard', 'clipboard_failed', 502, ['Try again.']);
  try {
    const e = await fails(call('PUT', DEV, { text: 'nope-secret' }));
    assert.equal(e.code, 'clipboard_failed');
  } finally { failSet = undefined; }
  assert.equal(logText(DEV), logged);
});
