// /v1/app-notes routes and the launch hint (`appNotes` on launch and trace start results), through the daemon's
// router against a fake backend, with PHONEDOCK_HOME in a temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhoneDockError, type Backend } from '../core/types.ts';
import type { Ctx } from './http.ts';

const HOME = mkdtempSync(join(tmpdir(), 'pd-app-notes-'));
process.env.PHONEDOCK_HOME = HOME;
delete process.env.PHONEDOCK_DEVICE_FILTER;
const core = await import('./core.ts');
const { router } = await import('./routes.ts');
await import('./routes-notes.ts');

const launched: string[] = [];
const fake = {
  id: 'fake-notes', displayName: 'Fake', platform: 'android', kind: 'virtual', capabilities: [],
  available: async () => ({ ok: true }), listDevices: async () => [],
  screenshot: async () => Buffer.alloc(0), tap: async () => {}, swipe: async () => {}, type: async () => {}, key: async () => {},
  async launchApp(_nid: string, appId: string) { launched.push(appId); },
  async foregroundApp() { return { id: launched.at(-1) ?? '' }; },
} as unknown as Backend;
core.backends.push(fake);

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const m = router.match(method, path);
  assert.ok(m && m !== 'method', `${method} ${path} has a route`);
  const c = { params: m.params, owner: 'mcp:test:1', body: async () => body ?? {}, q: () => undefined } as unknown as Ctx;
  return m.h(c);
}
async function fails(p: Promise<unknown>): Promise<PhoneDockError> {
  try { await p; } catch (e) { assert.ok(e instanceof PhoneDockError, String(e)); return e; }
  assert.fail('expected an error');
}
const notesPath = (id: string) => `/v1/app-notes/${encodeURIComponent(id)}`;

test('routes: save, read, list and delete one app\'s notes under PHONEDOCK_HOME/app-notes', async () => {
  assert.deepEqual(await call('GET', '/v1/app-notes'), []);
  const none = await call('GET', notesPath('com.example.app'));
  assert.deepEqual(none, { appId: 'com.example.app', path: join(HOME, 'app-notes', 'com.example.app.md'), notes: null });
  assert.ok(!existsSync(join(HOME, 'app-notes')), 'a read creates nothing');

  const text = '# Example\n- Settings: tap "Profile"\n';
  const saved = await call('PUT', notesPath('com.example.app'), { notes: text });
  assert.equal(saved.ok, true); assert.equal(saved.created, true); assert.equal(saved.sizeBytes, Buffer.byteLength(text));
  assert.equal(statSync(join(HOME, 'app-notes')).mode & 0o777, 0o700);
  const r = await call('GET', notesPath('com.example.app'));
  assert.equal(r.notes, text);
  assert.equal(r.updatedAt, saved.updatedAt);
  assert.deepEqual((await call('GET', '/v1/app-notes')).map((n: { appId: string }) => n.appId), ['com.example.app']);

  assert.equal((await call('DELETE', notesPath('com.example.app'))).deleted, true);
  assert.equal((await call('DELETE', notesPath('com.example.app'))).deleted, false);
  assert.equal((await call('GET', notesPath('com.example.app'))).notes, null);
});

test('routes: traversal ids, empty and oversized notes are refused, and nothing lands outside the folder', async () => {
  for (const id of ['../x', '../../daemon', 'a/b', 'A'.repeat(201), '.hidden']) {
    for (const [m, body] of [['GET'], ['PUT', { notes: 'x' }], ['DELETE']] as const) {
      const e = await fails(call(m, notesPath(id), body));
      assert.equal(e.code, 'bad_request', `${m} ${id}`);
      assert.match(e.message, /Invalid app id/);
    }
  }
  assert.equal((await fails(call('PUT', notesPath('com.x'), {}))).code, 'bad_request');
  assert.equal((await fails(call('PUT', notesPath('com.x'), { notes: 'x'.repeat(32 * 1024 + 1) }))).status, 413);
  assert.deepEqual(readdirSync(HOME).filter((n) => n !== 'app-notes' && n !== 'devices'), []);
  // why clients check ids too: "." and ".." never reach this route, URL parsing turns them into other paths
  assert.equal(new URL('http://127.0.0.1/v1/app-notes/..').pathname, '/v1/');
});

test('launch: `appNotes` is set only when the app has notes', async () => {
  const dev = 'fake-notes:pdtest-notes';
  const launch = (app: string) => call('POST', `/v1/devices/${encodeURIComponent(dev)}/apps/${encodeURIComponent(app)}/launch`);
  const without = await launch('dev.phonedock.sample');
  assert.equal(without.ok, true); assert.equal(without.inFront, true);
  assert.ok(!('appNotes' in without), JSON.stringify(without));

  const s = await call('PUT', notesPath('dev.phonedock.sample'), { notes: 'Tap "Greet" after typing a name.\n' });
  const withNotes = await launch('dev.phonedock.sample');
  assert.deepEqual(withNotes.appNotes, { updatedAt: s.updatedAt, sizeBytes: s.sizeBytes });
  assert.deepEqual(launched, ['dev.phonedock.sample', 'dev.phonedock.sample']);
  assert.ok(!('appNotes' in (await launch('com.other.app'))), 'another app: no hint');
});
