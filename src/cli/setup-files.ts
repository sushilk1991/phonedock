// File helpers for `phonedock setup`: atomic writes, content hashes, and the small slices of JSON and TOML editing
// that setup needs. The TOML part reads and edits one table ([mcp_servers.phonedock] and its sub-tables) line by line
// and leaves every other byte of the file alone, so a user's comments and formatting survive.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** Write via a temporary file in the same folder, then rename over the target (keeps the file's mode). */
export function writeFileAtomic(path: string, content: string | Buffer, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  let keep = mode;
  if (keep === undefined && existsSync(path)) { try { keep = statSync(path).mode & 0o777; } catch { /* new file */ } }
  const tmp = join(dirname(path), `.${path.split('/').pop()}.phonedock-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, content, keep !== undefined ? { mode: keep } : undefined);
    if (keep !== undefined) chmodSync(tmp, keep);
    renameSync(tmp, path);
  } catch (e) { rmSync(tmp, { force: true }); throw e; }
}

/** Every regular file under `dir` (relative paths, sorted), skipping dotfiles and dot-folders. */
export function listFiles(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listFiles(p, base));
    else if (st.isFile()) out.push(relative(base, p));
  }
  return out;
}

// ── JSON ──────────────────────────────────────────────────────────────

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

/** Parse a JSON config file: undefined when missing or empty, an error when it isn't a JSON object. */
export function readJsonObject(path: string): { value?: JsonObject; error?: string } {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8');
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text) as Json;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: `${path} is not a JSON object` };
    return { value: v };
  } catch (e) { return { error: `${path} is not valid JSON (${(e as Error).message})` }; }
}

export const jsonText = (v: Json) => JSON.stringify(v, null, 2) + '\n';

// ── TOML (one table) ──────────────────────────────────────────────────

const HEADER = /^\s*\[(?!\[)(.*)\]\s*(?:#.*)?$/;
const AOT_HEADER = /^\s*\[\[/;

/** `mcp_servers."phone dock".env` → ['mcp_servers', 'phone dock', 'env']; undefined if it isn't a plain key path. */
export function parseKeyPath(s: string): string[] | undefined {
  const parts: string[] = []; let i = 0;
  const ws = () => { while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++; };
  for (;;) {
    ws();
    let key = '';
    if (s[i] === '"') {
      i++;
      while (i < s.length && s[i] !== '"') { if (s[i] === '\\' && i + 1 < s.length) { key += s[i + 1]; i += 2; } else key += s[i++]; }
      if (s[i] !== '"') return undefined; i++;
    } else if (s[i] === "'") {
      const end = s.indexOf("'", i + 1); if (end < 0) return undefined;
      key = s.slice(i + 1, end); i = end + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i)); if (!m) return undefined;
      key = m[0]; i += key.length;
    }
    parts.push(key); ws();
    if (i >= s.length) return parts;
    if (s[i] !== '.') return undefined;
    i++;
  }
}

const samePath = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const startsWith = (a: string[], pre: string[]) => a.length > pre.length && pre.every((x, i) => x === a[i]);

interface TableSpan { header: number; end: number }   // lines [header, end)

/** The table `path` and its sub-tables, as line spans (header line up to the next header). */
export function findTables(lines: string[], path: string[]): { main?: TableSpan; subs: TableSpan[] } {
  const heads: { i: number; path?: string[] }[] = [];
  lines.forEach((l, i) => {
    if (AOT_HEADER.test(l)) heads.push({ i });
    else { const m = HEADER.exec(l); if (m) heads.push({ i, path: parseKeyPath(m[1]) }); }
  });
  let main: TableSpan | undefined; const subs: TableSpan[] = [];
  heads.forEach((h, k) => {
    const span = { header: h.i, end: k + 1 < heads.length ? heads[k + 1].i : lines.length };
    if (!h.path) return;
    if (samePath(h.path, path)) main = span;
    else if (startsWith(h.path, path)) subs.push(span);
  });
  return { main, subs };
}

type TomlValue = string | number | boolean | TomlValue[] | { [k: string]: TomlValue };

/** Parse one TOML value at the start of `s` (strings, numbers, booleans, arrays, inline tables). */
export function parseTomlValue(s: string): { value: TomlValue; rest: string } | undefined {
  s = s.replace(/^\s+/, '');
  if (s.startsWith('"""') || s.startsWith("'''")) return undefined;   // multi-line strings: not needed here
  if (s[0] === '"') {
    let out = ''; let i = 1;
    while (i < s.length && s[i] !== '"') {
      if (s[i] === '\\') {
        const c = s[i + 1];
        const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\' };
        if (c === 'u' || c === 'U') { const n = c === 'u' ? 4 : 8; out += String.fromCodePoint(parseInt(s.slice(i + 2, i + 2 + n), 16)); i += 2 + n; continue; }
        if (!(c in map)) return undefined;
        out += map[c]; i += 2; continue;
      }
      out += s[i++];
    }
    if (s[i] !== '"') return undefined;
    return { value: out, rest: s.slice(i + 1) };
  }
  if (s[0] === "'") { const end = s.indexOf("'", 1); if (end < 0) return undefined; return { value: s.slice(1, end), rest: s.slice(end + 1) }; }
  if (s[0] === '[' || s[0] === '{') {
    const close = s[0] === '[' ? ']' : '}';
    const arr: TomlValue[] = []; const obj: Record<string, TomlValue> = {};
    let rest = s.slice(1);
    for (;;) {
      rest = rest.replace(/^(\s|#[^\n]*)+/, '');
      if (rest[0] === close) return { value: close === ']' ? arr : obj, rest: rest.slice(1) };
      if (close === '}') {
        const m = /^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*=/.exec(rest); if (!m) return undefined;
        const key = parseKeyPath(m[1])?.[0]; if (key === undefined) return undefined;
        const v = parseTomlValue(rest.slice(m[0].length)); if (!v) return undefined;
        obj[key] = v.value; rest = v.rest;
      } else {
        const v = parseTomlValue(rest); if (!v) return undefined;
        arr.push(v.value); rest = v.rest;
      }
      rest = rest.replace(/^(\s|#[^\n]*)+/, '');
      if (rest[0] === ',') rest = rest.slice(1);
      else if (rest[0] !== close) return undefined;
    }
  }
  const m = /^(true|false|[+-]?\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(s);
  if (!m) return undefined;
  const v = m[1] === 'true' ? true : m[1] === 'false' ? false : Number(m[1].replace(/_/g, ''));
  return { value: v, rest: s.slice(m[1].length) };
}

/** Key/value pairs of a table body; values may span lines (arrays). Unparseable lines are reported. */
function parseBody(lines: string[]): { values: Record<string, TomlValue>; bad: string[] } {
  const values: Record<string, TomlValue> = {}; const bad: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || /^\s*#/.test(l)) continue;
    const m = /^\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.-]+)\s*=(.*)$/.exec(l);
    if (!m) { bad.push(l.trim()); continue; }
    let text = m[2]; let v = parseTomlValue(text);
    while (!v && i + 1 < lines.length && /^\s*[[{]/.test(m[2])) { text += '\n' + lines[++i]; v = parseTomlValue(text); }
    if (!v || (v.rest.trim() && !/^\s*#/.test(v.rest))) { bad.push(l.trim()); continue; }
    const key = parseKeyPath(m[1]);
    if (key?.length === 1) values[key[0]] = v.value; else bad.push(l.trim());
  }
  return { values, bad };
}

export interface TomlServer { command?: string; args?: string[]; env?: Record<string, string>; tool_timeout_sec?: number; enabled?: boolean; other: string[]; unreadable: string[] }

/** Read [mcp_servers.<name>] (with an inline `env` or an [mcp_servers.<name>.env] table). */
export function readTomlServer(text: string, name: string): TomlServer | undefined {
  const lines = text.split('\n');
  const t = findTables(lines, ['mcp_servers', name]);
  if (!t.main) return undefined;
  const { values, bad } = parseBody(lines.slice(t.main.header + 1, t.main.end));
  const s: TomlServer = { other: [], unreadable: bad };
  for (const [k, v] of Object.entries(values)) {
    if (k === 'command' && typeof v === 'string') s.command = v;
    else if (k === 'args' && Array.isArray(v) && v.every((x) => typeof x === 'string')) s.args = v as string[];
    else if (k === 'tool_timeout_sec' && typeof v === 'number') s.tool_timeout_sec = v;
    else if (k === 'enabled' && typeof v === 'boolean') s.enabled = v;
    else if (k === 'env' && v && typeof v === 'object' && !Array.isArray(v)) s.env = Object.fromEntries(Object.entries(v).map(([a, b]) => [a, String(b)]));
    else s.other.push(k);
  }
  for (const sub of t.subs) {
    const p = parseKeyPath(HEADER.exec(lines[sub.header])![1])!;
    if (p.length === 3 && p[2] === 'env') {
      const body = parseBody(lines.slice(sub.header + 1, sub.end));
      s.env = { ...(s.env ?? {}), ...Object.fromEntries(Object.entries(body.values).map(([a, b]) => [a, String(b)])) };
      s.unreadable.push(...body.bad);
    } else s.other.push(p.slice(2).join('.'));
  }
  return s;
}

const tomlKey = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));
/** A TOML basic string (JSON's escapes are a subset of TOML's). */
export const tomlString = (s: string) => JSON.stringify(s);

/** The text of a fresh [mcp_servers.<name>] table. */
export function tomlServerBlock(name: string, command: string, args: string[], env: Record<string, string>, toolTimeoutSec?: number): string {
  let out = `[mcp_servers.${tomlKey(name)}]\ncommand = ${tomlString(command)}\nargs = [${args.map(tomlString).join(', ')}]\n`;
  if (toolTimeoutSec !== undefined) out += `tool_timeout_sec = ${toolTimeoutSec}\n`;
  const keys = Object.keys(env);
  if (keys.length) out += `\n[mcp_servers.${tomlKey(name)}.env]\n${keys.map((k) => `${tomlKey(k)} = ${tomlString(env[k])}`).join('\n')}\n`;
  return out;
}

/** Remove [mcp_servers.<name>] and its sub-tables; other text is kept byte for byte. */
export function removeTomlServer(text: string, name: string): string {
  const lines = text.split('\n');
  const t = findTables(lines, ['mcp_servers', name]);
  const drop = new Set<number>();
  for (const s of [...(t.main ? [t.main] : []), ...t.subs]) for (let i = s.header; i < s.end; i++) drop.add(i);
  if (!drop.size) return text;
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (drop.has(i)) return;
    // Where a table was cut out, don't leave two blank lines in a row (or a blank line at the very top).
    if (l.trim() === '' && drop.has(i - 1) && (out.length === 0 || out[out.length - 1].trim() === '')) return;
    out.push(l);
  });
  return out.join('\n');
}

/** Append (or replace) the [mcp_servers.<name>] table. */
export function upsertTomlServer(text: string, name: string, block: string): string {
  const base = removeTomlServer(text, name).replace(/\s*$/, '');
  return (base ? base + '\n\n' : '') + block;
}

/** Set `key = value` in [mcp_servers.<name>] (replacing the line if the key is there), or undefined without the table. */
export function setTomlServerKey(text: string, name: string, key: string, valueText: string): string | undefined {
  const lines = text.split('\n');
  const t = findTables(lines, ['mcp_servers', name]);
  if (!t.main) return undefined;
  const re = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = t.main.header + 1; i < t.main.end; i++) {
    if (re.test(lines[i])) { lines[i] = `${key} = ${valueText}`; return lines.join('\n'); }
  }
  let at = t.main.header;
  for (let i = t.main.header + 1; i < t.main.end; i++) if (lines[i].trim() && !/^\s*#/.test(lines[i])) at = i;
  lines.splice(at + 1, 0, `${key} = ${valueText}`);
  return lines.join('\n');
}
