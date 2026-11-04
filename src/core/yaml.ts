// A small, dependency-free YAML subset for PhoneDock flow files (src/core/flow.ts). It reads what people write in
// test files and nothing more: block mappings and sequences (indented with spaces), `- key: value` items, flow
// collections on one line (`{ text: Greet, type: Button }`, `[a, b]`), plain / 'single' / "double" quoted scalars,
// `|` and `>` block scalars, comments, and `---`. Scalars resolve like YAML 1.2's core schema: true/false, null/~,
// numbers; everything else (yes, no, on, off, 1.2.3, …) is a string. Anchors, aliases, tags, multiple documents and
// complex keys are rejected with the line number. `stringify` writes the same subset, so its output reads back.

export class YamlError extends Error {
  line: number;
  constructor(message: string, line: number) { super(`line ${line}: ${message}`); this.line = line; }
}

/** Attach to an object (or array item) to write `# comment` lines above it; JSON and parse ignore it. */
export const YAML_COMMENT = Symbol('yaml-comment');

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

interface Line { n: number; indent: number; text: string }   // text: the line without its indentation

const NUM_INT = /^[-+]?[0-9]+$/;
const NUM_HEX = /^0x[0-9a-fA-F]+$/;
const NUM_OCT = /^0o[0-7]+$/;
const NUM_FLOAT = /^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/;

/** Plain scalar → null / boolean / number / string (YAML 1.2 core schema). */
export function resolvePlain(s: string): Json {
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true' || s === 'True' || s === 'TRUE') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE') return false;
  if (NUM_INT.test(s) || NUM_FLOAT.test(s)) return Number(s);
  if (NUM_HEX.test(s)) return parseInt(s.slice(2), 16);
  if (NUM_OCT.test(s)) return parseInt(s.slice(2), 8);
  if (/^[-+]?\.(inf|Inf|INF)$/.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(s)) return NaN;
  return s;
}

class Parser {
  private lines: Line[] = [];
  private i = 0;

  constructor(src: string) {
    const raw = src.replace(/^﻿/, '').split(/\r?\n/);
    raw.forEach((l, k) => {
      const n = k + 1;
      const m = /^( *)(.*)$/.exec(l)!;
      if (/^\t/.test(m[2]) && m[2].trim() && !m[2].trim().startsWith('#')) throw new YamlError('tabs are not allowed for indentation; use spaces', n);
      this.lines.push({ n, indent: m[1].length, text: m[2].replace(/\s+$/, '') });
    });
  }

  /** Next line with content (skips blanks, comment-only lines and `---`), or undefined at the end. */
  private peek(): Line | undefined {
    while (this.i < this.lines.length) {
      const l = this.lines[this.i];
      if (l.text === '' || l.text.startsWith('#')) { this.i++; continue; }
      if (l.indent === 0 && (l.text === '---' || l.text.startsWith('--- ') || l.text.startsWith('---#'))) {
        if (this.seenContent) throw new YamlError('only one document per file is supported', l.n);
        this.i++; continue;
      }
      if (l.indent === 0 && l.text === '...') { this.i = this.lines.length; return undefined; }
      return l;
    }
    return undefined;
  }
  private seenContent = false;

  parseDocument(): Json {
    const first = this.peek();
    if (!first) return null;
    this.seenContent = true;
    const v = this.parseNode(first.indent);
    const extra = this.peek();
    if (extra) throw new YamlError(extra.indent < first.indent ? 'bad indentation' : 'unexpected content after the document', extra.n);
    return v;
  }

  /** The block node starting at the next line, which must be indented at least `min`. */
  private parseNode(min: number): Json {
    const l = this.peek();
    if (!l || l.indent < min) return null;
    if (isSeqItem(l.text)) return this.parseSequence(l.indent);
    if (keyOf(l.text, l.n)) return this.parseMapping(l.indent);
    this.i++;
    const v = this.inlineOrBlock(l.text, l, l.indent - 1);
    const next = this.peek();
    if (next && next.indent > l.indent) throw new YamlError('unexpected indentation (a plain value continues on the next line? put it in quotes on one line)', next.n);
    return v;
  }

  private parseSequence(ind: number): Json[] {
    const out: Json[] = [];
    for (;;) {
      const l = this.peek();
      if (!l || l.indent < ind) return out;
      if (l.indent > ind) throw new YamlError('bad indentation in a list', l.n);
      if (!isSeqItem(l.text)) {
        if (keyOf(l.text, l.n)) throw new YamlError('a mapping key at the same indentation as a list item: indent the list under its key, or the key under the item', l.n);
        throw new YamlError('expected a list item ("- …")', l.n);
      }
      const rest = l.text.slice(1).replace(/^ +/, '');
      const col = l.indent + (l.text.length - rest.length);
      if (rest === '' || rest.startsWith('#')) {
        this.i++;
        const nx = this.peek();
        out.push(nx && nx.indent > ind ? this.parseNode(ind + 1) : null);
        continue;
      }
      if (isSeqItem(rest) || keyOf(rest, l.n)) {
        // "- key: value" / "- - x": the rest of the line is the first line of a block node at column `col`
        this.lines[this.i] = { n: l.n, indent: col, text: rest };
        out.push(this.parseNode(col));
        continue;
      }
      this.i++;
      out.push(this.inlineOrBlock(rest, l, ind));
      const nx = this.peek();
      if (nx && nx.indent > ind) throw new YamlError('unexpected indentation after a list item', nx.n);
    }
  }

  private parseMapping(ind: number): { [k: string]: Json } {
    const out: { [k: string]: Json } = {};
    for (;;) {
      const l = this.peek();
      if (!l || l.indent < ind) return out;
      if (l.indent > ind) throw new YamlError('bad indentation', l.n);
      const k = keyOf(l.text, l.n);
      if (!k) {
        if (isSeqItem(l.text)) throw new YamlError('a list item where a "key: value" was expected (indent the list under its key)', l.n);
        throw new YamlError('expected "key: value"', l.n);
      }
      if (Object.prototype.hasOwnProperty.call(out, k.key)) throw new YamlError(`duplicate key "${k.key}"`, l.n);
      this.i++;
      const rest = k.rest;
      if (rest === '' || rest.startsWith('#')) {
        const nx = this.peek();
        if (nx && nx.indent > ind) out[k.key] = this.parseNode(ind + 1);
        else if (nx && nx.indent === ind && isSeqItem(nx.text)) out[k.key] = this.parseSequence(ind);   // "key:\n- a"
        else out[k.key] = null;
        continue;
      }
      out[k.key] = this.inlineOrBlock(rest, l, ind);
      const nx = this.peek();
      if (nx && nx.indent > ind) throw new YamlError(`unexpected indentation after "${k.key}: …" (a value continues on the next line? put it in quotes on one line)`, nx.n);
    }
  }

  /** A value on the rest of a line: a block scalar header (`|`, `>`) or an inline (flow / scalar) value. */
  private inlineOrBlock(s: string, l: Line, parentIndent: number): Json {
    const bs = /^([|>])([-+]?)(\s+#.*)?$/.exec(s);
    if (bs) return this.blockScalar(bs[1] as '|' | '>', bs[2], parentIndent, l.n);
    const cur = { s, p: 0, n: l.n };
    const v = parseInline(cur, false);
    skipWs(cur);
    if (cur.p < s.length && s[cur.p] !== '#') throw new YamlError(`unexpected "${s.slice(cur.p, cur.p + 12)}" after a value${/:\s/.test(s.slice(cur.p - 1)) ? ' (a value with ": " in it must be quoted)' : ''}`, l.n);
    if (cur.p < s.length && s[cur.p] === '#' && cur.p > 0 && !/\s/.test(s[cur.p - 1])) throw new YamlError('a comment needs a space before "#"', l.n);
    return v;
  }

  private blockScalar(style: '|' | '>', chomp: string, parentIndent: number, n: number): string {
    const body: string[] = []; let ind = -1;
    while (this.i < this.lines.length) {
      const l = this.lines[this.i];
      if (l.text === '') { body.push(''); this.i++; continue; }
      if (ind < 0) { if (l.indent <= parentIndent) break; ind = l.indent; }
      if (l.indent < ind) break;
      body.push(' '.repeat(l.indent - ind) + l.text);
      this.i++;
    }
    // trailing blank lines belong to the chomping, not the content
    let trail = 0; while (body.length && body[body.length - 1] === '') { body.pop(); trail++; }
    if (ind < 0 && !body.length) { void n; return ''; }
    let text: string;
    if (style === '|') text = body.join('\n');
    else {
      text = '';
      body.forEach((b, k) => {
        if (k === 0) { text = b; return; }
        const prev = body[k - 1];
        text += b === '' ? '\n' : prev === '' || /^\s/.test(b) || /^\s/.test(prev) ? (prev === '' ? b : '\n' + b) : ' ' + b;
      });
    }
    if (chomp === '-') return text;
    if (chomp === '+') return text + '\n'.repeat(trail + 1);
    return text + '\n';
  }
}

function isSeqItem(t: string): boolean { return t === '-' || t.startsWith('- ') || t.startsWith('-\t'); }

/** `key: rest` (plain or quoted key) or undefined when the line isn't a mapping entry. */
function keyOf(t: string, n: number): { key: string; rest: string } | undefined {
  if (t.startsWith('"') || t.startsWith("'")) {
    const cur = { s: t, p: 0, n };
    let key: string;
    try { key = t[0] === '"' ? dq(cur) : sq(cur); } catch { return undefined; }
    const m = /^\s*:(\s|$)/.exec(t.slice(cur.p));
    return m ? { key, rest: t.slice(cur.p + m[0].length).trim() } : undefined;
  }
  if (/^[[{|>&*!%@`?]/.test(t) || isSeqItem(t)) {
    if (/^[&*!]/.test(t)) throw new YamlError('anchors, aliases and tags (&, *, !) are not supported', n);
    if (/^\?\s/.test(t)) throw new YamlError('complex keys ("? ") are not supported', n);
    return undefined;
  }
  const m = /^(.*?)\s*:(\s+|$)/.exec(t);
  if (!m || / #/.test(m[1]) || m[1].startsWith('#')) return undefined;
  return { key: m[1], rest: t.slice(m[0].length).trim() };
}

interface Cur { s: string; p: number; n: number }
function skipWs(c: Cur) { while (c.p < c.s.length && (c.s[c.p] === ' ' || c.s[c.p] === '\t')) c.p++; }

function parseInline(c: Cur, inFlow: boolean): Json {
  skipWs(c);
  const ch = c.s[c.p];
  if (ch === '[') return flowSeq(c);
  if (ch === '{') return flowMap(c);
  if (ch === '"') return dq(c);
  if (ch === "'") return sq(c);
  if (ch === '&' || ch === '*' || ch === '!') throw new YamlError('anchors, aliases and tags (&, *, !) are not supported', c.n);
  if (ch === '|' || ch === '>') throw new YamlError('block scalars ("|", ">") must end their line', c.n);
  if (ch === '@' || ch === '`' || ch === '%') throw new YamlError(`a plain value can't start with "${ch}": put it in quotes`, c.n);
  return resolvePlain(plain(c, inFlow));
}

function plain(c: Cur, inFlow: boolean): string {
  const start = c.p;
  while (c.p < c.s.length) {
    const ch = c.s[c.p];
    if (ch === '#' && c.p > start && /\s/.test(c.s[c.p - 1])) break;
    if (ch === ':' && (c.p + 1 >= c.s.length || /\s/.test(c.s[c.p + 1]) || (inFlow && /[,\]}]/.test(c.s[c.p + 1])))) break;
    if (inFlow && (ch === ',' || ch === ']' || ch === '}' || ch === '[' || ch === '{')) break;
    c.p++;
  }
  return c.s.slice(start, c.p).trim();
}

function dq(c: Cur): string {
  let out = ''; c.p++;
  while (c.p < c.s.length) {
    const ch = c.s[c.p];
    if (ch === '"') { c.p++; return out; }
    if (ch === '\\') {
      const e = c.s[c.p + 1]; c.p += 2;
      const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v', ' ': ' ', N: '\u0085', _: '\u00a0' };
      if (e in simple) { out += simple[e]; continue; }
      const len = e === 'x' ? 2 : e === 'u' ? 4 : e === 'U' ? 8 : 0;
      if (len) {
        const hex = c.s.slice(c.p, c.p + len);
        if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) throw new YamlError(`bad escape "\\${e}${hex}"`, c.n);
        out += String.fromCodePoint(parseInt(hex, 16)); c.p += len; continue;
      }
      throw new YamlError(`unknown escape "\\${e ?? ''}" in a double-quoted string`, c.n);
    }
    out += ch; c.p++;
  }
  throw new YamlError('unterminated double-quoted string (quoted values must stay on one line)', c.n);
}

function sq(c: Cur): string {
  let out = ''; c.p++;
  while (c.p < c.s.length) {
    const ch = c.s[c.p];
    if (ch === "'") { if (c.s[c.p + 1] === "'") { out += "'"; c.p += 2; continue; } c.p++; return out; }
    out += ch; c.p++;
  }
  throw new YamlError("unterminated single-quoted string (quoted values must stay on one line)", c.n);
}

function flowSeq(c: Cur): Json[] {
  const out: Json[] = []; c.p++;
  for (;;) {
    skipWs(c);
    if (c.s[c.p] === ']') { c.p++; return out; }
    if (c.p >= c.s.length) throw new YamlError('unterminated "[" (flow lists must stay on one line)', c.n);
    out.push(parseInline(c, true));
    skipWs(c);
    if (c.s[c.p] === ',') { c.p++; continue; }
    if (c.s[c.p] === ']') { c.p++; return out; }
    throw new YamlError(`expected "," or "]" in a flow list, got "${c.s.slice(c.p, c.p + 10)}"`, c.n);
  }
}

function flowMap(c: Cur): { [k: string]: Json } {
  const out: { [k: string]: Json } = {}; c.p++;
  for (;;) {
    skipWs(c);
    if (c.s[c.p] === '}') { c.p++; return out; }
    if (c.p >= c.s.length) throw new YamlError('unterminated "{" (flow mappings must stay on one line)', c.n);
    const ch = c.s[c.p];
    const key = ch === '"' ? dq(c) : ch === "'" ? sq(c) : plain(c, true);
    if (key === '') throw new YamlError('empty key in a flow mapping', c.n);
    skipWs(c);
    let v: Json = null;
    if (c.s[c.p] === ':') { c.p++; v = parseInline(c, true); }
    if (Object.prototype.hasOwnProperty.call(out, key)) throw new YamlError(`duplicate key "${key}"`, c.n);
    out[key] = v;
    skipWs(c);
    if (c.s[c.p] === ',') { c.p++; continue; }
    if (c.s[c.p] === '}') { c.p++; return out; }
    throw new YamlError(`expected "," or "}" in a flow mapping, got "${c.s.slice(c.p, c.p + 10)}"`, c.n);
  }
}

export function parse(src: string): unknown {
  return new Parser(src).parseDocument();
}

// ── writer ─────────────────────────────────────────────────────────────────

/** Can `s` be written without quotes? `flow`: inside `{ }` / `[ ]`. */
function plainOk(s: string, flow: boolean): boolean {
  if (s === '' || s !== s.trim()) return false;
  if (typeof resolvePlain(s) !== 'string') return false;          // "true", "12", "null" … stay strings
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return false;
  if (/[\x00-\x1f\x7f\u0085\u2028\u2029]/.test(s)) return false;
  if (/: |:$| #/.test(s)) return false;
  if (flow && /[,[\]{}]|:/.test(s)) return false;
  return true;
}
export function scalar(v: unknown, flow = false): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : Number.isNaN(v) ? '.nan' : v > 0 ? '.inf' : '-.inf';
  const s = String(v);
  return plainOk(s, flow) ? s : JSON.stringify(s);
}
const keyText = (k: string) => (plainOk(k, true) ? k : JSON.stringify(k));
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const comments = (v: unknown, pad: string): string[] => {
  const c = (v && typeof v === 'object' ? (v as Record<symbol, unknown>)[YAML_COMMENT] : undefined) as string | string[] | undefined;
  return c === undefined ? [] : (Array.isArray(c) ? c : [c]).flatMap((x) => x.split('\n')).map((x) => `${pad}# ${x}`.trimEnd());
};

/** `{ a: 1, b: x }` when it is short and only holds scalars. */
function flowForm(v: unknown, room: number): string | undefined {
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    if (v.some((x) => x !== null && typeof x === 'object')) return undefined;
    const s = `[${v.map((x) => scalar(x, true)).join(', ')}]`;
    return s.length <= room ? s : undefined;
  }
  if (isObj(v)) {
    const ks = Object.keys(v).filter((k) => v[k] !== undefined);
    if (!ks.length) return '{}';
    if (ks.some((k) => v[k] !== null && typeof v[k] === 'object')) return undefined;
    const s = `{ ${ks.map((k) => `${keyText(k)}: ${scalar(v[k], true)}`).join(', ')} }`;
    return s.length <= room ? s : undefined;
  }
  return undefined;
}

export interface StringifyOptions { /** Write small scalar-only objects as `{ a: b }` (default true). */ flow?: boolean; width?: number }

/** YAML text for a JSON-like value (undefined properties are skipped; YAML_COMMENT symbols become comments). */
export function stringify(value: unknown, opts: StringifyOptions = {}): string {
  const width = opts.width ?? 100; const useFlow = opts.flow !== false;
  const lines: string[] = [];
  const block = (v: unknown, indent: number) => {
    const pad = ' '.repeat(indent);
    if (Array.isArray(v)) {
      for (const item of v) {
        lines.push(...comments(item, pad));
        if (isObj(item) && Object.keys(item).some((k) => item[k] !== undefined)) {
          // "- key: value" with the item's other keys under it
          const start = lines.length;
          block(item, indent + 2);
          lines[start] = `${pad}- ${lines[start].slice(indent + 2)}`;
        } else if (Array.isArray(item) && item.length) {
          const f = useFlow ? flowForm(item, width - indent - 2) : undefined;
          if (f) lines.push(`${pad}- ${f}`);
          else { lines.push(`${pad}-`); block(item, indent + 2); }
        } else lines.push(`${pad}- ${isObj(item) ? '{}' : Array.isArray(item) ? '[]' : scalar(item)}`);
      }
      return;
    }
    if (isObj(v)) {
      for (const k of Object.keys(v)) {
        const x = v[k];
        if (x === undefined) continue;
        lines.push(...comments(x, pad));
        const head = `${pad}${keyText(k)}:`;
        if (x !== null && typeof x === 'object') {
          const f = useFlow ? flowForm(x, width - head.length - 1) : (Array.isArray(x) && !x.length ? '[]' : isObj(x) && !Object.keys(x).length ? '{}' : undefined);
          if (f) lines.push(`${head} ${f}`);
          else { lines.push(head); block(x, Array.isArray(x) ? indent + 2 : indent + 2); }
        } else lines.push(`${head} ${scalar(x)}`);
      }
      return;
    }
    lines.push(pad + scalar(v));
  };
  lines.push(...comments(value, ''));
  block(value, 0);
  return lines.join('\n') + '\n';
}
