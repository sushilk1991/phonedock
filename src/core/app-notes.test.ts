// App notes storage (src/core/app-notes.ts): the app-id boundary, the size cap, permissions, round trips and the atomic
// overwrite. Every test uses its own temp folder, passed in explicitly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhoneDockError } from './types.ts';
import {
  MAX_APP_NOTES_BYTES, appNotesInfo, appNotesPath, deleteAppNotes, isAppId, listAppNotes, readAppNotes, saveAppNotes, validateAppId,
} from './app-notes.ts';

const fresh = () => { const root = mkdtempSync(join(tmpdir(), 'pd-notes-')); return { root, dir: join(root, 'app-notes') }; };
function code(f: () => unknown): string {
  try { f(); } catch (e) { assert.ok(e instanceof PhoneDockError, String(e)); return `${e.code} ${e.status}`; }
  assert.fail('expected an error');
}

test('app ids: bundle ids and package names pass; traversal, slashes, empty and over-long ids are refused', () => {
  for (const ok of ['com.apple.Preferences', 'dev.phonedock.sample', 'com.android.settings', 'a', 'com.x_y-z.App2', 'A'.repeat(200)]) {
    assert.equal(validateAppId(ok), ok);
  }
  const bad: unknown[] = ['', '..', '.', '../x', 'a/b', '/etc/passwd', 'a\\b', '.hidden', '-flag', 'a..b', 'com.x/../../y', 'com.x ', ' com.x',
    'com.x\0', 'com.x\n', 'A'.repeat(201), undefined, null, 42, ['com.x']];
  for (const v of bad) {
    assert.equal(isAppId(v), false, JSON.stringify(v));
    assert.equal(code(() => validateAppId(v)), 'bad_request 400', JSON.stringify(v));
  }
  assert.match(code(() => validateAppId('../x')), /bad_request/);
  try { validateAppId('../x'); } catch (e) { assert.match((e as PhoneDockError).detail ?? '', /"\.\.\/x" is not an app id/); }
});

test('every operation refuses a traversal id before touching the disk', () => {
  const { root, dir } = fresh();
  for (const id of ['../x', 'a/b', '', '..', 'A'.repeat(201)]) {
    assert.equal(code(() => saveAppNotes(id, '# x', dir)), 'bad_request 400', id);
    assert.equal(code(() => readAppNotes(id, dir)), 'bad_request 400', id);
    assert.equal(code(() => deleteAppNotes(id, dir)), 'bad_request 400', id);
    assert.equal(code(() => appNotesPath(id, dir)), 'bad_request 400', id);
    assert.equal(appNotesInfo(id, dir), null, id);   // the hint path never throws
  }
  assert.deepEqual(readdirSync(root), [], 'nothing was created, not even the folder');
  assert.ok(!existsSync(join(root, 'x.md')) && !existsSync(join(tmpdir(), 'x.md')));
});

test('size cap: 32 KB of UTF-8 is accepted, one byte more is refused (bytes, not characters); empty notes are refused', () => {
  const { dir } = fresh();
  assert.equal(saveAppNotes('com.x', 'a'.repeat(MAX_APP_NOTES_BYTES), dir).sizeBytes, 32 * 1024);
  assert.equal(code(() => saveAppNotes('com.x', 'a'.repeat(MAX_APP_NOTES_BYTES + 1), dir)), 'too_large 413');
  const wide = 'é'.repeat(MAX_APP_NOTES_BYTES / 2 + 1);   // 16 385 characters, 32 770 bytes
  assert.ok(wide.length < MAX_APP_NOTES_BYTES);
  assert.equal(code(() => saveAppNotes('com.x', wide, dir)), 'too_large 413');
  for (const empty of ['', '  \n\t', undefined, 42]) assert.equal(code(() => saveAppNotes('com.x', empty, dir)), 'bad_request 400');
  assert.equal(readAppNotes('com.x', dir)?.notes.length, MAX_APP_NOTES_BYTES, 'a refused save leaves the old notes alone');
});

test('permissions: the folder is 0700 and each file 0600, also when the folder existed with looser ones', () => {
  const { dir } = fresh();
  const old = process.umask(0o000);   // the modes must not depend on the umask
  try { saveAppNotes('com.example.app', '# Example\n', dir); } finally { process.umask(old); }
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'com.example.app.md')).mode & 0o777, 0o600);
  saveAppNotes('com.example.app', '# Example v2\n', dir);   // the overwrite keeps 0600
  assert.equal(statSync(join(dir, 'com.example.app.md')).mode & 0o777, 0o600);

  const loose = fresh(); mkdirSync(loose.dir, { recursive: true }); chmodSync(loose.dir, 0o755);
  saveAppNotes('com.x', 'x', loose.dir);
  assert.equal(statSync(loose.dir).mode & 0o777, 0o700);
});

test('round trip: save → read → list → delete, with created flags and missing notes reading as null', () => {
  const { dir } = fresh();
  assert.equal(readAppNotes('com.example.app', dir), null);
  assert.deepEqual(listAppNotes(dir), []);
  const text = '# com.example.app (v2.3, 2026-11-05)\n- Settings: tap "Profile" → "Settings"\n- Onboarding: tap "Skip" twice\nÜnïcödé ✓\n';
  const s1 = saveAppNotes('com.example.app', text, dir);
  assert.equal(s1.created, true);
  assert.equal(s1.path, join(dir, 'com.example.app.md'));
  assert.equal(s1.sizeBytes, Buffer.byteLength(text));
  const r = readAppNotes('com.example.app', dir)!;
  assert.equal(r.notes, text);
  assert.equal(r.appId, 'com.example.app');
  assert.equal(r.updatedAt, s1.updatedAt);
  assert.equal(saveAppNotes('com.example.app', `${text}- more\n`, dir).created, false);
  saveAppNotes('dev.phonedock.sample', 'Sample notes', dir);
  // newest first
  const t = Date.now() / 1000;
  utimesSync(join(dir, 'com.example.app.md'), t - 3600, t - 3600);
  assert.deepEqual(listAppNotes(dir).map((n) => n.appId), ['dev.phonedock.sample', 'com.example.app']);
  const info = appNotesInfo('dev.phonedock.sample', dir)!;
  assert.deepEqual(info, listAppNotes(dir)[0]);
  assert.equal(info.sizeBytes, 12);
  assert.equal(appNotesInfo('com.unknown', dir), null);

  assert.deepEqual(deleteAppNotes('com.example.app', dir), { appId: 'com.example.app', path: join(dir, 'com.example.app.md'), deleted: true });
  assert.equal(readAppNotes('com.example.app', dir), null);
  assert.equal(deleteAppNotes('com.example.app', dir).deleted, false, 'deleting again is not an error');
  assert.deepEqual(listAppNotes(dir).map((n) => n.appId), ['dev.phonedock.sample']);
});

test('atomic overwrite: the file is replaced by a rename (an open reader keeps the old text whole), no temp files stay', () => {
  const { dir } = fresh();
  const v1 = `# v1\n${'one '.repeat(4000)}\n`; const v2 = `# v2\n${'two '.repeat(2000)}\n`;
  saveAppNotes('com.x', v1, dir);
  const path = join(dir, 'com.x.md');
  const ino = statSync(path).ino;
  const fd = openSync(path, 'r');   // a reader that started before the save
  try {
    saveAppNotes('com.x', v2, dir);
    assert.notEqual(statSync(path).ino, ino, 'a new file took the name: the old one was never written in place');
    const buf = Buffer.alloc(Buffer.byteLength(v1) + 10);
    const n = readSync(fd, buf, 0, buf.length, 0);
    assert.equal(buf.subarray(0, n).toString('utf8'), v1);
  } finally { closeSync(fd); }
  assert.equal(readFileSync(path, 'utf8'), v2);
  assert.deepEqual(readdirSync(dir), ['com.x.md']);
});

test('a failed save removes its temp file; list skips temp files, other files and links; read never follows a link', () => {
  const { dir } = fresh();
  saveAppNotes('com.ok', 'ok', dir);
  mkdirSync(join(dir, 'com.blocked.md'));   // a folder where the file should go: the rename fails
  assert.throws(() => saveAppNotes('com.blocked', 'x', dir));
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);

  const outside = join(fresh().root, 'secret.txt'); writeFileSync(outside, 'not notes');
  symlinkSync(outside, join(dir, 'com.link.md'));
  writeFileSync(join(dir, '.com.ok.md.123-abcd.tmp'), 'half');
  writeFileSync(join(dir, 'README.txt'), 'x');
  writeFileSync(join(dir, 'bad name.md'), 'x');
  assert.deepEqual(listAppNotes(dir).map((n) => n.appId), ['com.ok']);
  assert.equal(readAppNotes('com.link', dir), null);
  assert.equal(appNotesInfo('com.link', dir), null);
});
