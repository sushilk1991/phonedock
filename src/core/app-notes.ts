// App notes: what agents learned about one app (how to reach key screens, stable labels and ids, quirks), kept as one
// Markdown file per app in <PhoneDock home>/app-notes/<appId>.md and shared by every agent on this Mac. The daemon
// serves them (src/daemon/routes-notes.ts); the MCP `app_notes` tool and `phonedock app-notes` go through it.
//
// The app id becomes a file name, so it is the path-traversal boundary: it is checked strictly on every call (no
// "..", no "/", nothing empty or over 200 characters). The folder is 0700 and the files 0600; a save writes a temp
// file and renames it over the old one, so a reader never sees half a file.
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { PHONEDOCK_HOME } from './paths.ts';
import { PhoneDockError } from './types.ts';

/** A bundle id or package name: letters, digits, `.`, `_`, `-`, starting with a letter or digit, ≤200 characters. */
export const APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
export const MAX_APP_NOTES_BYTES = 32 * 1024;

/** One app's notes file. `updatedAt` = its modification time (ISO). */
export interface AppNotesInfo { appId: string; path: string; updatedAt: string; sizeBytes: number }
export interface AppNotes extends AppNotesInfo { notes: string }

/** `stateDir('app-notes')`, without creating it (reads never create anything; the first save does, as 0700). */
export function appNotesDir(): string { return join(PHONEDOCK_HOME, 'app-notes'); }

export function isAppId(v: unknown): v is string { return typeof v === 'string' && APP_ID_RE.test(v) && !v.includes('..'); }

export function validateAppId(v: unknown): string {
  if (isAppId(v)) return v;
  const shown = typeof v === 'string' ? JSON.stringify(v.length > 60 ? `${v.slice(0, 60)}…` : v) : String(v);
  throw new PhoneDockError('Invalid app id: use a bundle ID or package name', 'bad_request', 400,
    ['Pass the app\'s bundle ID (iOS) or package name (Android), e.g. com.apple.Preferences.'],
    `${shown} is not an app id: 1–200 characters of A-Z a-z 0-9 . _ -, starting with a letter or digit, without ".."`);
}

export function appNotesPath(appId: unknown, dir = appNotesDir()): string { return join(dir, `${validateAppId(appId)}.md`); }

const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';
const info = (appId: string, path: string, st: Stats): AppNotesInfo => ({ appId, path, updatedAt: st.mtime.toISOString(), sizeBytes: st.size });

/** lstat: a symlink or folder where a notes file should be is never followed (only regular files count). */
function fileStat(path: string): Stats | null {
  try { const st = lstatSync(path); return st.isFile() ? st : null; } catch (e) { if (missing(e)) return null; throw e; }
}

/** The notes for one app, or null when there are none yet. */
export function readAppNotes(appId: unknown, dir = appNotesDir()): AppNotes | null {
  const id = validateAppId(appId); const path = join(dir, `${id}.md`);
  const st = fileStat(path);
  if (!st) return null;
  return { ...info(id, path, st), notes: readFileSync(path, 'utf8') };
}

/** Cheap check for hints (a launch): the notes file's details, or null. Never throws; an invalid id has no notes. */
export function appNotesInfo(appId: unknown, dir = appNotesDir()): AppNotesInfo | null {
  if (!isAppId(appId)) return null;
  const path = join(dir, `${appId}.md`);
  try { const st = fileStat(path); return st ? info(appId, path, st) : null; } catch { return null; }
}

/** Replace one app's notes (atomically). `created`: there were none before. */
export function saveAppNotes(appId: unknown, notes: unknown, dir = appNotesDir()): AppNotesInfo & { created: boolean } {
  const id = validateAppId(appId);
  if (typeof notes !== 'string' || !notes.trim()) {
    throw new PhoneDockError('The notes are empty', 'bad_request', 400, ['Pass the whole Markdown text to save; to remove an app\'s notes, delete them.'],
      'notes must be a non-empty string');
  }
  const size = Buffer.byteLength(notes, 'utf8');
  if (size > MAX_APP_NOTES_BYTES) {
    throw new PhoneDockError('The notes are too long', 'too_large', 413, ['Keep notes short (about 60 lines): trim them and save again.'],
      `${size} bytes; at most ${MAX_APP_NOTES_BYTES} (32 KB)`);
  }
  mkdirSync(dirname(dir), { recursive: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if ((statSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700);   // a folder made earlier with other permissions
  const path = join(dir, `${id}.md`);
  const created = !fileStat(path);
  const tmp = join(dir, `.${id}.md.${process.pid}-${randomBytes(4).toString('hex')}.tmp`);   // dot: never listed
  try {
    writeFileSync(tmp, notes, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
  } catch (e) { rmSync(tmp, { force: true }); throw e; }
  return { ...info(id, path, statSync(path)), created };
}

/** Every app with notes, newest first. */
export function listAppNotes(dir = appNotesDir()): AppNotesInfo[] {
  let names: string[];
  try { names = readdirSync(dir); } catch (e) { if (missing(e)) return []; throw e; }
  const out: AppNotesInfo[] = [];
  for (const n of names) {
    const id = n.endsWith('.md') ? n.slice(0, -3) : '';
    if (!isAppId(id)) continue;
    const st = fileStat(join(dir, n));
    if (st) out.push(info(id, join(dir, n), st));
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.appId.localeCompare(b.appId));
}

/** Remove one app's notes. `deleted: false` when there were none (not an error). */
export function deleteAppNotes(appId: unknown, dir = appNotesDir()): { appId: string; path: string; deleted: boolean } {
  const id = validateAppId(appId); const path = join(dir, `${id}.md`);
  try { unlinkSync(path); return { appId: id, path, deleted: true }; } catch (e) { if (missing(e)) return { appId: id, path, deleted: false }; throw e; }
}
