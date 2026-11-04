// PhoneDock flows: a recorded or hand-written UI test as a small YAML (or JSON) file.
//
//   name: Greet and enable notifications
//   appId: dev.phonedock.sample
//   platform: android
//   minOS: "16"
//   steps:
//     - launch: dev.phonedock.sample
//     - assert_visible: PhoneDock Sample
//     - fill: { field: Your name, value: Ada }
//     - tap: Greet
//     - assert_visible: "Hello, Ada!"
//     - tap: { text: Notifications, type: Switch }
//     - assert_visible: Notifications on
//
// Steps are one-key mappings (`tap: Greet`), optionally with modifiers (`optional: true`, `timeout: 20000`,
// `label: …`). Elements are found by text (contains, case-insensitive, exact matches first), id or type, the same
// matching as `find` / `tap text=`; raw coordinates are allowed but marked fragile. `${VAR}` in a string is read from
// the environment (or the flow's `env:` defaults) when the flow runs.
//
// This module is pure: parse / validate / write flows, turn an action log + screen observations into a flow
// (`flowFromLog`), and export to Maestro. The runner is src/core/flow-runner.ts; the daemon side is
// src/daemon/observe.ts (observations) and src/daemon/routes-flow.ts (POST /v1/devices/:id/flow).
import { YAML_COMMENT, YamlError, parse as parseYaml, stringify as stringifyYaml } from './yaml.ts';

export type MatchMode = 'contains' | 'exact' | 'regex';
export type Direction = 'up' | 'down' | 'left' | 'right';
/** How to find an element: like `find` (text/label/value/placeholder contains, or exact / regex), id, type. */
export interface Selector { text?: string; id?: string; type?: string; match?: MatchMode; index?: number }
/** A screen position: `unit: '%'` = percent of the screen (portable), `'px'` = device screenshot pixels. */
export interface Point { x: number; y: number; unit: '%' | 'px' }

interface StepBase {
  optional?: boolean;      // a failure doesn't fail the flow (one-time dialogs, onboarding)
  timeoutMs?: number;      // how long element waits / assertions may take (default: the run's timeout, 10 s)
  label?: string;          // shown instead of the generated description
  fragile?: boolean;       // raw coordinates: breaks on other screen sizes or layouts
}
export type Step = StepBase & (
  | { kind: 'launch'; app?: string; stop: boolean }
  | { kind: 'terminate'; app?: string }
  | { kind: 'tap' | 'long_press' | 'double_tap'; sel?: Selector; at?: Point; durationMs?: number }
  | { kind: 'fill'; field?: Selector; at?: Point; value: string; submit?: boolean; clear?: boolean; secret?: boolean }
  | { kind: 'type'; text: string; submit?: boolean; secret?: boolean }
  | { kind: 'key'; key: string }
  | { kind: 'back' } | { kind: 'home' } | { kind: 'hide_keyboard' }
  | { kind: 'scroll_to'; sel: Selector; direction?: Direction; max?: number }
  | { kind: 'swipe'; direction?: Direction; distance?: number; from?: Point; to?: Point; durationMs?: number }
  | { kind: 'wait_for'; until: 'visible' | 'gone' | 'idle'; sel?: Selector; stableMs?: number }
  | { kind: 'set_appearance'; mode: 'dark' | 'light' }
  | { kind: 'rotate'; orientation: 'portrait' | 'landscape' }
  | { kind: 'open_url'; url: string }
  | { kind: 'gesture'; gesture: string }
  | { kind: 'alert'; action: 'accept' | 'dismiss' | 'button'; button?: string }
  | { kind: 'sleep'; ms: number }
  | { kind: 'assert_visible' | 'assert_not_visible'; sel: Selector }
  | { kind: 'assert_text'; field: Selector; equals?: string; contains?: string; matches?: string }
  | { kind: 'screenshot'; name: string; baseline?: string; tolerance?: number }
);
export type StepKind = Step['kind'];

/** A flow file as written (steps in their compact YAML form). */
export interface FlowFile {
  version?: number;
  name?: string;
  appId?: string;
  platform?: 'android' | 'ios';
  minOS?: string;
  recordedOn?: { device?: string; model?: string; os?: string; screen?: string; at?: string };
  env?: Record<string, string>;
  steps: unknown[];
}
/** A parsed, validated flow. */
export interface Flow {
  name: string;
  appId?: string;
  platform?: 'android' | 'ios';
  minOS?: string;
  recordedOn?: FlowFile['recordedOn'];
  env: Record<string, string>;
  steps: Step[];
  file?: string;
  warnings: string[];
}

export class FlowError extends Error {
  constructor(message: string) { super(message); this.name = 'FlowError'; }
}

export const COMMANDS: StepKind[] = ['launch', 'terminate', 'tap', 'long_press', 'double_tap', 'fill', 'type', 'key', 'back', 'home',
  'hide_keyboard', 'scroll_to', 'swipe', 'wait_for', 'set_appearance', 'rotate', 'open_url', 'gesture', 'alert', 'sleep',
  'assert_visible', 'assert_not_visible', 'assert_text', 'screenshot'];
const ALIASES: Record<string, StepKind> = {
  launch_app: 'launch', stop_app: 'terminate', terminate_app: 'terminate', go_back: 'back', press_key: 'key', go_home: 'home',
  type_text: 'type', open: 'open_url', appearance: 'set_appearance', handle_alert: 'alert', wait: 'sleep',
};
const MODIFIERS = new Set(['optional', 'timeout', 'label', 'fragile']);
const NO_ARG = new Set<StepKind>(['back', 'home', 'hide_keyboard', 'launch', 'terminate']);
const DIRS = new Set(['up', 'down', 'left', 'right']);
const MODES = new Set(['contains', 'exact', 'regex']);
const TOP_KEYS = new Set(['version', 'name', 'appId', 'platform', 'minOS', 'recordedOn', 'env', 'steps', 'description', 'tags']);

// ── parsing ────────────────────────────────────────────────────────────────
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined);

/** Parse flow text (YAML, or JSON when the file name ends in .json or the text starts with `{`/`[`). */
export function parseFlow(text: string, file?: string): Flow {
  let raw: unknown;
  const json = /\.json$/i.test(file ?? '') || /^\s*[{[]/.test(text) && !/^\s*\{\s*\w+\s*:/.test(text) && isJsonish(text);
  try { raw = json ? JSON.parse(text) : parseYaml(text); }
  catch (e) {
    const where = file ? `${file}: ` : '';
    if (e instanceof YamlError) throw new FlowError(`${where}${e.message}`);
    throw new FlowError(`${where}not valid ${json ? 'JSON' : 'YAML'}: ${(e as Error).message}`);
  }
  return validateFlow(raw, file);
}
function isJsonish(t: string): boolean { try { JSON.parse(t); return true; } catch { return false; } }

export function validateFlow(raw: unknown, file?: string): Flow {
  const where = file ? `${file}: ` : '';
  const warnings: string[] = [];
  let doc: Record<string, unknown>;
  if (Array.isArray(raw)) doc = { steps: raw };
  else if (isObj(raw)) doc = raw;
  else throw new FlowError(`${where}a flow is a mapping with "steps:" (or a list of steps)`);
  for (const k of Object.keys(doc)) if (!TOP_KEYS.has(k)) warnings.push(`unknown top-level key "${k}" (ignored)`);
  if (!Array.isArray(doc.steps)) throw new FlowError(`${where}"steps:" must be a list of steps`);
  if (!doc.steps.length) throw new FlowError(`${where}the flow has no steps`);
  const platform = str(doc.platform)?.toLowerCase();
  if (platform && platform !== 'android' && platform !== 'ios') throw new FlowError(`${where}platform must be android or ios (got "${platform}")`);
  const env: Record<string, string> = {};
  if (doc.env !== undefined) {
    if (!isObj(doc.env)) throw new FlowError(`${where}env: must be a mapping of NAME: value`);
    for (const [k, v] of Object.entries(doc.env)) env[k] = str(v) ?? '';
  }
  const steps = doc.steps.map((s, i) => {
    try { return parseStep(s); } catch (e) { throw new FlowError(`${where}step ${i + 1}: ${(e as Error).message}`); }
  });
  const name = str(doc.name) ?? (file ? file.split('/').pop()!.replace(/\.(flow\.)?(ya?ml|json)$/i, '') : 'flow');
  return { name, appId: str(doc.appId), platform: platform as Flow['platform'], minOS: str(doc.minOS), recordedOn: isObj(doc.recordedOn) ? doc.recordedOn as Flow['recordedOn'] : undefined, env, steps, file, warnings };
}

function selector(v: unknown, what = 'selector'): Selector {
  if (typeof v === 'string' || typeof v === 'number') {
    const s = String(v);
    if (!s.trim()) throw new Error(`empty ${what}`);
    const m = /^id:(.+)$/i.exec(s);
    return m ? { id: m[1].trim() } : { text: s };
  }
  if (!isObj(v)) throw new Error(`${what} must be text, or { text | id | type, match?, index? }`);
  const sel: Selector = {};
  for (const k of Object.keys(v)) if (!['text', 'id', 'type', 'match', 'index'].includes(k)) throw new Error(`unknown ${what} key "${k}" (use text, id, type, match, index)`);
  if (v.text !== undefined) sel.text = str(v.text);
  if (v.id !== undefined) sel.id = str(v.id);
  if (v.type !== undefined) sel.type = str(v.type);
  if (v.match !== undefined) { const m = str(v.match); if (!m || !MODES.has(m)) throw new Error('match must be contains, exact or regex'); sel.match = m as MatchMode; }
  if (v.index !== undefined) { const n = Number(v.index); if (!Number.isInteger(n) || n < 0) throw new Error('index must be a whole number ≥ 0'); sel.index = n; }
  if (!sel.text && !sel.id && !sel.type) throw new Error(`${what} needs text, id or type`);
  return sel;
}

/** "50%,62%" / "540,1210" / [540, 1210] / { x, y } → Point. */
export function parsePoint(v: unknown): Point {
  if (Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number')) return { x: v[0], y: v[1], unit: 'px' };
  if (isObj(v) && typeof v.x === 'number' && typeof v.y === 'number') return { x: v.x, y: v.y, unit: 'px' };
  const m = typeof v === 'string' ? /^\s*(-?[\d.]+)\s*(%?)\s*,\s*(-?[\d.]+)\s*(%?)\s*$/.exec(v) : null;
  if (m && m[2] === m[4]) return { x: Number(m[1]), y: Number(m[3]), unit: m[2] ? '%' : 'px' };
  throw new Error('a point is "x%,y%" (percent of the screen), "x,y" or [x, y] (device pixels)');
}
export const pointText = (p: Point) => (p.unit === '%' ? `${+p.x.toFixed(1)}%,${+p.y.toFixed(1)}%` : `${Math.round(p.x)},${Math.round(p.y)}`);

const ms = (v: unknown, what: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${what} must be a number of milliseconds`);
  return n;
};
const bool = (v: unknown, what: string): boolean => {
  if (typeof v === 'boolean') return v;
  throw new Error(`${what} must be true or false`);
};
const only = (o: Record<string, unknown>, keys: string[], cmd: string) => {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new Error(`${cmd}: unknown key "${k}" (allowed: ${keys.join(', ')})`);
};

export function parseStep(raw: unknown): Step {
  let cmd: string; let arg: unknown; const mods: Record<string, unknown> = {};
  if (typeof raw === 'string') { cmd = raw.trim(); arg = null; }
  else if (isObj(raw)) {
    const keys = Object.keys(raw);
    const cmds = keys.filter((k) => !MODIFIERS.has(k));
    if (cmds.length !== 1) throw new Error(cmds.length ? `one command per step (found ${cmds.join(', ')})` : `no command (only ${keys.join(', ')})`);
    cmd = cmds[0]; arg = raw[cmd];
    for (const k of keys) if (MODIFIERS.has(k)) mods[k] = raw[k];
  } else throw new Error('a step is "command: argument" (e.g. "tap: Sign in") or a bare command such as "back"');
  const kind = (COMMANDS as string[]).includes(cmd) ? cmd as StepKind : ALIASES[cmd];
  if (!kind) throw new Error(`unknown command "${cmd}". Commands: ${COMMANDS.join(', ')}`);
  if ((arg === null || arg === undefined) && !NO_ARG.has(kind) && !(kind === 'wait_for')) throw new Error(`${kind} needs an argument`);
  const base: StepBase = {};
  if (mods.optional !== undefined) base.optional = bool(mods.optional, 'optional');
  if (mods.timeout !== undefined) base.timeoutMs = ms(mods.timeout, 'timeout');
  if (mods.label !== undefined) base.label = str(mods.label);
  if (mods.fragile !== undefined) base.fragile = bool(mods.fragile, 'fragile');
  const o = isObj(arg) ? arg : undefined;
  switch (kind) {
    case 'launch': case 'terminate': {
      if (o) {
        only(o, kind === 'launch' ? ['app', 'stop'] : ['app'], kind);
        const app = o.app === undefined ? {} : { app: str(o.app) };
        return kind === 'launch' ? { ...base, kind, ...app, stop: o.stop === undefined ? true : bool(o.stop, 'stop') } : { ...base, kind, ...app };
      }
      const app = arg === null || arg === undefined || arg === true ? {} : { app: str(arg) };
      return kind === 'launch' ? { ...base, kind, ...app, stop: true } : { ...base, kind, ...app };
    }
    case 'tap': case 'long_press': case 'double_tap': {
      if (o && 'at' in o) {
        only(o, ['at', 'duration'], kind);
        return { ...base, kind, at: parsePoint(o.at), fragile: true, ...(o.duration !== undefined ? { durationMs: ms(o.duration, 'duration') } : {}) };
      }
      if (o && 'duration' in o) {
        const { duration, ...rest } = o;
        return { ...base, kind, sel: selector(rest), durationMs: ms(duration, 'duration') };
      }
      return { ...base, kind, sel: selector(arg) };
    }
    case 'fill': {
      if (!o) throw new Error('fill needs { field: <text or selector>, value: … }');
      only(o, ['field', 'at', 'value', 'submit', 'clear', 'secret'], 'fill');
      if (o.value === undefined || o.value === null) throw new Error('fill needs value');
      if (o.field === undefined && o.at === undefined) throw new Error('fill needs field (text, or { id | text | type })');
      const s: Step = { ...base, kind: 'fill', value: str(o.value) ?? '' };
      if (o.at !== undefined) { s.at = parsePoint(o.at); s.fragile = true; } else s.field = selector(o.field, 'field');
      if (o.submit !== undefined) s.submit = bool(o.submit, 'submit');
      if (o.clear !== undefined) s.clear = bool(o.clear, 'clear');
      if (o.secret !== undefined) s.secret = bool(o.secret, 'secret');
      return s;
    }
    case 'type': {
      if (o) {
        only(o, ['text', 'submit', 'secret'], 'type');
        return { ...base, kind, text: str(o.text) ?? '', ...(o.submit !== undefined ? { submit: bool(o.submit, 'submit') } : {}), ...(o.secret !== undefined ? { secret: bool(o.secret, 'secret') } : {}) };
      }
      return { ...base, kind, text: str(arg) ?? '' };
    }
    case 'key': { const k = str(arg); if (!k) throw new Error('key needs a key name (enter, back, home, delete, tab, …)'); return { ...base, kind, key: k }; }
    case 'back': case 'home': case 'hide_keyboard': return { ...base, kind };
    case 'scroll_to': {
      if (o && ('direction' in o || 'max' in o)) {
        const { direction, max, ...rest } = o;
        const d = direction === undefined ? undefined : str(direction);
        if (d && !DIRS.has(d)) throw new Error('direction must be down, up, left or right');
        return { ...base, kind, sel: selector(rest), ...(d ? { direction: d as Direction } : {}), ...(max !== undefined ? { max: Number(max) } : {}) };
      }
      return { ...base, kind, sel: selector(arg) };
    }
    case 'swipe': {
      if (typeof arg === 'string') { if (!DIRS.has(arg)) throw new Error('swipe needs a direction: up, down, left or right (the finger movement)'); return { ...base, kind, direction: arg as Direction }; }
      if (!o) throw new Error('swipe needs a direction, or { from: "x%,y%", to: "x%,y%" }');
      only(o, ['direction', 'distance', 'from', 'to', 'duration'], 'swipe');
      const s: Step = { ...base, kind: 'swipe' };
      if (o.direction !== undefined) { const d = str(o.direction); if (!d || !DIRS.has(d)) throw new Error('direction must be up, down, left or right'); s.direction = d as Direction; }
      if (o.distance !== undefined) s.distance = Number(o.distance);
      if (o.duration !== undefined) s.durationMs = ms(o.duration, 'duration');
      if (o.from !== undefined || o.to !== undefined) {
        if (o.from === undefined || o.to === undefined) throw new Error('swipe needs both from and to');
        s.from = parsePoint(o.from); s.to = parsePoint(o.to); s.fragile = true;
      } else if (!s.direction) throw new Error('swipe needs direction, or from and to');
      return s;
    }
    case 'wait_for': {
      if (arg === 'idle' || arg === null || arg === undefined) return { ...base, kind, until: 'idle' };
      if (!o) throw new Error('wait_for needs { visible: … }, { gone: … } or idle');
      only(o, ['visible', 'gone', 'idle', 'stable'], 'wait_for');
      const stable = o.stable === undefined ? undefined : ms(o.stable, 'stable');
      if (o.visible !== undefined) return { ...base, kind, until: 'visible', sel: selector(o.visible), ...(stable !== undefined ? { stableMs: stable } : {}) };
      if (o.gone !== undefined) return { ...base, kind, until: 'gone', sel: selector(o.gone), ...(stable !== undefined ? { stableMs: stable } : {}) };
      if (o.idle !== undefined) return { ...base, kind, until: 'idle', ...(typeof o.idle === 'number' ? { stableMs: o.idle } : stable !== undefined ? { stableMs: stable } : {}) };
      throw new Error('wait_for needs visible, gone or idle');
    }
    case 'set_appearance': { const m = str(arg)?.toLowerCase(); if (m !== 'dark' && m !== 'light') throw new Error('set_appearance is dark or light'); return { ...base, kind, mode: m }; }
    case 'rotate': { const m = str(arg)?.toLowerCase(); if (m !== 'portrait' && m !== 'landscape') throw new Error('rotate is portrait or landscape'); return { ...base, kind, orientation: m }; }
    case 'open_url': { const u = str(arg); if (!u) throw new Error('open_url needs a URL'); return { ...base, kind, url: u }; }
    case 'gesture': { const g = str(arg); if (!g) throw new Error('gesture needs go_home, app_switcher, control_center or notification_center'); return { ...base, kind, gesture: g }; }
    case 'alert': {
      if (arg === 'accept' || arg === 'dismiss') return { ...base, kind, action: arg };
      if (o && o.button !== undefined) { only(o, ['button'], 'alert'); return { ...base, kind, action: 'button', button: str(o.button) }; }
      const m = typeof arg === 'string' ? /^button\s*=\s*(.+)$/i.exec(arg) : null;
      if (m) return { ...base, kind, action: 'button', button: m[1].trim() };
      throw new Error('alert is accept, dismiss or { button: <label> }');
    }
    case 'sleep': return { ...base, kind, ms: ms(arg, 'sleep') };
    case 'assert_visible': case 'assert_not_visible': return { ...base, kind, sel: selector(arg) };
    case 'assert_text': {
      if (!o) throw new Error('assert_text needs { field: <selector>, equals | contains | matches: … }');
      only(o, ['field', 'equals', 'value', 'contains', 'matches'], 'assert_text');
      if (o.field === undefined) throw new Error('assert_text needs field');
      const s: Step = { ...base, kind, field: selector(o.field, 'field') };
      const eq = o.equals ?? o.value;
      if (eq !== undefined) s.equals = str(eq) ?? '';
      if (o.contains !== undefined) s.contains = str(o.contains);
      if (o.matches !== undefined) { s.matches = str(o.matches); try { new RegExp(s.matches ?? ''); } catch { throw new Error('matches is not a valid regular expression'); } }
      if (s.equals === undefined && s.contains === undefined && s.matches === undefined) throw new Error('assert_text needs equals, contains or matches');
      return s;
    }
    case 'screenshot': {
      if (o) {
        only(o, ['name', 'baseline', 'tolerance'], 'screenshot');
        return { ...base, kind, name: str(o.name) ?? 'checkpoint', ...(o.baseline !== undefined ? { baseline: str(o.baseline) } : {}), ...(o.tolerance !== undefined ? { tolerance: Number(o.tolerance) } : {}) };
      }
      return { ...base, kind, name: str(arg) ?? 'checkpoint' };
    }
  }
}

// ── writing ────────────────────────────────────────────────────────────────
/** The compact form of a selector: plain text when that's all it is. */
export function selectorOut(s: Selector): unknown {
  const keys = Object.keys(s).filter((k) => s[k as keyof Selector] !== undefined);
  if (keys.length === 1 && s.text !== undefined && !/^id:/i.test(s.text)) return s.text;
  const o: Record<string, unknown> = {};
  for (const k of ['text', 'id', 'type', 'match', 'index'] as const) if (s[k] !== undefined) o[k] = s[k];
  return o;
}

/** A selector as an object (for steps that add keys next to it). */
function selectorObj(s: Selector): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of ['text', 'id', 'type', 'match', 'index'] as const) if (s[k] !== undefined) o[k] = s[k];
  return o;
}

/** A step in its file form (`{ tap: Greet }`, `back`, …). */
export function stepOut(s: Step): unknown {
  const mods: Record<string, unknown> = {};
  if (s.optional) mods.optional = true;
  if (s.timeoutMs !== undefined) mods.timeout = s.timeoutMs;
  if (s.label) mods.label = s.label;
  let body: unknown;
  switch (s.kind) {
    case 'launch': body = s.stop ? (s.app ?? null) : { ...(s.app ? { app: s.app } : {}), stop: false }; break;
    case 'terminate': body = s.app ?? null; break;
    case 'tap': case 'long_press': case 'double_tap':
      body = s.at ? { at: pointText(s.at), ...(s.durationMs !== undefined ? { duration: s.durationMs } : {}) }
        : s.durationMs !== undefined ? { ...selectorObj(s.sel!), duration: s.durationMs } : selectorOut(s.sel!);
      if (s.at) mods.fragile = true;
      break;
    case 'fill':
      body = { ...(s.at ? { at: pointText(s.at) } : { field: selectorOut(s.field!) }), value: s.value, ...(s.submit ? { submit: true } : {}), ...(s.clear === false ? { clear: false } : {}), ...(s.secret ? { secret: true } : {}) };
      if (s.at) mods.fragile = true;
      break;
    case 'type': body = s.submit || s.secret ? { text: s.text, ...(s.submit ? { submit: true } : {}), ...(s.secret ? { secret: true } : {}) } : s.text; break;
    case 'key': body = s.key; break;
    case 'back': case 'home': case 'hide_keyboard': body = null; break;
    case 'scroll_to': body = s.direction || s.max !== undefined ? { ...selectorObj(s.sel), ...(s.direction && s.direction !== 'down' ? { direction: s.direction } : {}), ...(s.max !== undefined ? { max: s.max } : {}) } : selectorOut(s.sel); break;
    case 'swipe':
      if (s.from && s.to) { body = { from: pointText(s.from), to: pointText(s.to), ...(s.durationMs !== undefined ? { duration: s.durationMs } : {}) }; mods.fragile = true; }
      else body = s.distance !== undefined || s.durationMs !== undefined ? { direction: s.direction, ...(s.distance !== undefined ? { distance: s.distance } : {}), ...(s.durationMs !== undefined ? { duration: s.durationMs } : {}) } : s.direction;
      break;
    case 'wait_for': body = s.until === 'idle' ? (s.stableMs !== undefined ? { idle: s.stableMs } : 'idle') : { [s.until]: selectorOut(s.sel!), ...(s.stableMs !== undefined ? { stable: s.stableMs } : {}) }; break;
    case 'set_appearance': body = s.mode; break;
    case 'rotate': body = s.orientation; break;
    case 'open_url': body = s.url; break;
    case 'gesture': body = s.gesture; break;
    case 'alert': body = s.action === 'button' ? { button: s.button } : s.action; break;
    case 'sleep': body = s.ms; break;
    case 'assert_visible': case 'assert_not_visible': body = selectorOut(s.sel); break;
    case 'assert_text': body = { field: selectorOut(s.field), ...(s.equals !== undefined ? { equals: s.equals } : {}), ...(s.contains !== undefined ? { contains: s.contains } : {}), ...(s.matches !== undefined ? { matches: s.matches } : {}) }; break;
    case 'screenshot': body = s.baseline || s.tolerance !== undefined ? { name: s.name, ...(s.baseline ? { baseline: s.baseline } : {}), ...(s.tolerance !== undefined ? { tolerance: s.tolerance } : {}) } : s.name; break;
  }
  if (body === null && !Object.keys(mods).length) return s.kind;
  return { [s.kind]: body, ...mods };
}

/** Flow file text. `comments`: index → comment lines above that step; `header`: comment lines at the top. */
export function writeFlow(f: Omit<Flow, 'warnings' | 'file'> & { header?: string[]; comments?: Map<number, string[]> }, format: 'yaml' | 'json' = 'yaml'): string {
  const doc: FlowFile = { version: 1, name: f.name, ...(f.appId ? { appId: f.appId } : {}), ...(f.platform ? { platform: f.platform } : {}), ...(f.minOS ? { minOS: f.minOS } : {}),
    ...(f.recordedOn ? { recordedOn: f.recordedOn } : {}), ...(Object.keys(f.env ?? {}).length ? { env: f.env } : {}), steps: [] };
  doc.steps = f.steps.map((s, i) => {
    const out = stepOut(s);
    const c = f.comments?.get(i);
    if (format === 'yaml' && c?.length) {
      const boxed = (typeof out === 'string' ? new String(out) : out) as Record<symbol, unknown>;
      if (typeof out === 'string') return Object.assign({ [out]: null }, { [YAML_COMMENT]: c }); // a bare command with a comment
      boxed[YAML_COMMENT] = c;
      return boxed;
    }
    return out;
  });
  if (format === 'json') return JSON.stringify(doc, null, 2) + '\n';
  const text = stringifyYaml(doc);
  return (f.header?.length ? f.header.map((l) => `# ${l}`.trimEnd()).join('\n') + '\n' : '') + text;
}

// ── describing ─────────────────────────────────────────────────────────────
export function describeSelector(s: Selector | undefined): string {
  if (!s) return '?';
  const bits: string[] = [];
  if (s.type) bits.push(s.type);
  if (s.text !== undefined) bits.push(JSON.stringify(s.text) + (s.match && s.match !== 'contains' ? ` (${s.match})` : ''));
  if (s.id) bits.push(`id=${s.id}`);
  if (s.index) bits.push(`#${s.index}`);
  return bits.join(' ');
}
export function describeStep(s: Step): string {
  if (s.label) return s.label;
  const sel = (x?: Selector) => describeSelector(x);
  const frag = s.fragile ? ' (fragile: coordinates)' : '';
  switch (s.kind) {
    case 'launch': return `launch ${s.app ?? '(flow app)'}${s.stop ? '' : ' (keep running)'}`;
    case 'terminate': return `terminate ${s.app ?? '(flow app)'}`;
    case 'tap': case 'long_press': case 'double_tap': return `${s.kind} ${s.at ? `at ${pointText(s.at)}` : sel(s.sel)}${frag}`;
    case 'fill': return `fill ${s.at ? `at ${pointText(s.at)}` : sel(s.field)} = ${s.secret ? '•••' : JSON.stringify(s.value)}${s.submit ? ' + submit' : ''}${frag}`;
    case 'type': return `type ${s.secret ? '•••' : JSON.stringify(s.text)}${s.submit ? ' + submit' : ''}`;
    case 'key': return `key ${s.key}`;
    case 'back': case 'home': case 'hide_keyboard': return s.kind;
    case 'scroll_to': return `scroll_to ${sel(s.sel)}${s.direction && s.direction !== 'down' ? ` (${s.direction})` : ''}`;
    case 'swipe': return s.from && s.to ? `swipe ${pointText(s.from)} → ${pointText(s.to)}${frag}` : `swipe ${s.direction}`;
    case 'wait_for': return s.until === 'idle' ? 'wait_for idle' : `wait_for ${s.until} ${sel(s.sel)}`;
    case 'set_appearance': return `set_appearance ${s.mode}`;
    case 'rotate': return `rotate ${s.orientation}`;
    case 'open_url': return `open_url ${s.url}`;
    case 'gesture': return `gesture ${s.gesture}`;
    case 'alert': return `alert ${s.action === 'button' ? `button ${JSON.stringify(s.button)}` : s.action}`;
    case 'sleep': return `sleep ${s.ms} ms`;
    case 'assert_visible': case 'assert_not_visible': return `${s.kind} ${sel(s.sel)}`;
    case 'assert_text': return `assert_text ${sel(s.field)} ${s.equals !== undefined ? `= ${JSON.stringify(s.equals)}` : s.contains !== undefined ? `contains ${JSON.stringify(s.contains)}` : `matches /${s.matches}/`}`;
    case 'screenshot': return `screenshot ${s.name}${s.baseline ? ` vs ${s.baseline}` : ''}`;
  }
}

// ── environment ────────────────────────────────────────────────────────────
/** `${NAME}` / `${NAME:-default}` from `env`. Throws naming the variable when it is unset and has no default. */
export function interpolate(s: string, env: Record<string, string | undefined>): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, def?: string) => {
    const v = env[name];
    if (v !== undefined && v !== '') return v;
    if (def !== undefined) return def;
    throw new FlowError(`environment variable ${name} is not set (the flow uses \${${name}})`);
  });
}
export function interpolateStep(s: Step, env: Record<string, string | undefined>): Step {
  const walk = (v: unknown): unknown => (typeof v === 'string' ? interpolate(v, env) : Array.isArray(v) ? v.map(walk) : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
  return walk(s) as Step;
}

// ── versions ───────────────────────────────────────────────────────────────
/** "Android 16 (API 36)" → "16"; "iOS 26.5" → "26.5". */
export function osVersionNumber(os: string | undefined): string | undefined {
  return os ? /(\d+(?:\.\d+)*)/.exec(os)?.[1] : undefined;
}
/** -1 / 0 / 1 comparing dotted versions ("26.5" vs "27"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// ── from the action log ────────────────────────────────────────────────────
/** One line of the daemon's actions.jsonl (GET /v1/devices/:id/actions). */
export interface LogEntry {
  at: string;
  owner?: string;
  action?: Record<string, unknown>;
  via?: string;
  resolved?: { ref?: string; x?: number; y?: number; element?: { type?: string; text?: string; label?: string; id?: string; placeholder?: string } };
  replay?: boolean;
  /** On the first tap of a POST /fill: what was asked for. */
  fill?: { text?: string; id?: string; type?: string; match?: MatchMode; index?: number; ref?: boolean; point?: boolean; value?: string; length?: number; secret?: boolean; submit?: boolean; clear?: boolean };
  direction?: string;
  [k: string]: unknown;
}
/** One line of the daemon's observations.jsonl (src/daemon/observe.ts): what was on screen, waited for, scrolled to. */
export type Observation =
  | { at: string; kind: 'screen'; sig: string; texts: string[]; screen?: [number, number]; owner?: string }
  | { at: string; kind: 'wait'; owner?: string; until: 'visible' | 'gone' | 'idle'; query?: Selector; ok: boolean; elapsedMs?: number }
  | { at: string; kind: 'scroll_to'; owner?: string; query: Selector; direction?: Direction; found: boolean; scrolls?: number };
type ScreenObs = Extract<Observation, { kind: 'screen' }>;

export interface FromLogOptions {
  since?: string; until?: string;
  /** Only this owner's actions (exact, or a prefix ending in "*"). Screen observations are used whoever made them. */
  owner?: string;
  name?: string; appId?: string;
  platform?: 'android' | 'ios'; osVersion?: string; device?: string; model?: string;
  /** Screen size in device pixels, for converting coordinates to percentages. */
  screen?: { width: number; height: number };
  /** Explicit assertions, appended at the end (the automatic final assertion is then left out). */
  assertions?: Step[];
  /** Add assertions automatically (default true): after each launch, and at the end. */
  autoAssert?: boolean;
  /** Keep what looks like noise (undone taps, toggles flipped back). Default false. */
  keepNoise?: boolean;
  now?: string;
}
export interface FromLogResult {
  flow: Omit<Flow, 'warnings' | 'file'>;
  text: string;
  /** Comment lines above steps (index → lines) and at the top of the file. */
  comments: Map<number, string[]>; header: string[];
  warnings: string[];
  dropped: string[];
  stats: { entries: number; observations: number; steps: number; assertions: number };
}

interface Raw { step: Step; at: string; before?: ScreenObs; after?: ScreenObs; editable?: boolean; note?: string; src: number }

const TYPE_EDITABLE = /^(TextField|SecureTextField|SearchField|TextArea|EditText|AutoCompleteTextView|MultiAutoCompleteTextView|TextInputEditText|AppCompatEditText|ComboBox)$/i;
const shortType = (t?: string) => (t ?? '').split('.').pop() ?? '';
const shortId = (id: string) => id.replace(/^.*:id\//, '');
const GENERIC = new Set(['ok', 'cancel', 'back', 'done', 'close', 'more', 'more options', 'navigate up', 'search', 'menu']);
const sameSel = (a?: Selector, b?: Selector) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function ownerOk(owner: string | undefined, want?: string): boolean {
  if (!want || want === '*' || want === 'all') return true;
  if (want.endsWith('*')) return (owner ?? '').startsWith(want.slice(0, -1));
  return owner === want;
}

/** The text to assert on a screen: distinctive (new compared with `prev`, no digits, not generic), top first. */
export function pickAssertText(screen: { texts: string[] } | undefined, prev: { texts: string[] } | undefined, avoid: string[] = []): string | undefined {
  if (!screen?.texts.length) return undefined;
  const lower = (s: string) => s.toLowerCase();
  const old = new Set((prev?.texts ?? []).map(lower));
  const no = new Set(avoid.map(lower));
  const ok = (t: string) => t.length >= 2 && t.length <= 40 && !GENERIC.has(lower(t)) && !no.has(lower(t));
  const noDigits = (t: string) => !/\d/.test(t);
  const tiers = [
    (t: string) => ok(t) && noDigits(t) && !old.has(lower(t)),
    (t: string) => ok(t) && !old.has(lower(t)) && !/\d{2,}|\d+:\d+/.test(t),
    (t: string) => ok(t) && noDigits(t),
  ];
  for (const f of tiers) { const t = screen.texts.find(f); if (t) return t; }
  return undefined;
}

/** Selector for a logged tap: the client's query, the element a ref resolved to, or the label it sent. */
function tapSelector(e: LogEntry): { sel?: Selector; editable?: boolean } {
  const a = e.action ?? {};
  const el = e.resolved?.element ?? (a.element as LogEntry['resolved'] extends infer R ? R extends { element?: infer E } ? E : never : never);
  const editable = !!(a.element && (a.element as { editable?: boolean }).editable) || TYPE_EDITABLE.test(shortType(el?.type));
  const q = a.selector as Selector | undefined;
  if (q && (q.text || q.id || q.type)) {
    const sel: Selector = {};
    if (q.text) sel.text = q.text;
    if (q.id) sel.id = shortId(q.id);
    if (q.type) sel.type = shortType(q.type);
    if (q.match && q.match !== 'contains') sel.match = q.match;
    if (q.index) sel.index = q.index;
    return { sel, editable };
  }
  if (el) {
    const name = (el.text || el.label || '').trim();
    if (name && !editable) return { sel: { text: name.slice(0, 80) }, editable };
    if (el.id) return { sel: { id: shortId(el.id) }, editable };
    if (el.placeholder) return { sel: { text: el.placeholder }, editable };
    if (name) return { sel: { text: name.slice(0, 80) }, editable };
  }
  const label = typeof a.label === 'string' ? a.label.trim() : '';
  if (label) return { sel: { text: label }, editable };
  return { editable };
}

function pct(x: number, y: number, screen?: { width: number; height: number }): Point {
  if (!screen?.width || !screen.height) return { x, y, unit: 'px' };
  return { x: +(x / screen.width * 100).toFixed(1), y: +(y / screen.height * 100).toFixed(1), unit: '%' };
}

/** Turn an action log (+ screen observations) into a clean flow. Pure: the daemon reads the files and calls this. */
export function flowFromLog(entriesIn: LogEntry[], obsIn: Observation[], o: FromLogOptions = {}): FromLogResult {
  const t = (s: string) => Date.parse(s);
  const inRange = (at: string) => (!o.since || t(at) >= t(o.since)) && (!o.until || t(at) <= t(o.until));
  const entries = entriesIn.filter((e) => e && e.at && inRange(e.at) && e.owner !== 'daemon' && ownerOk(e.owner, o.owner));
  // Only one owner's actions: screens after someone else took over the device are not this session's.
  const lastOwn = entries.length ? t(entries[entries.length - 1].at) : -Infinity;
  const takeover = o.owner ? entriesIn.find((e) => e && e.at && t(e.at) > lastOwn && e.owner !== 'daemon' && !ownerOk(e.owner, o.owner) && !/^lease\./.test(String(e.action?.action ?? ''))) : undefined;
  const cutoff = takeover ? t(takeover.at) : Infinity;
  const obs = obsIn.filter((x) => x && x.at && inRange(x.at) && t(x.at) < cutoff && (x.kind === 'screen' || ownerOk(x.owner, o.owner)));
  const warnings: string[] = []; const dropped: string[] = [];
  const counts = new Map<string, number>(); const bump = (one: string, many: string) => { const k = `${one}\u0000${many}`; counts.set(k, (counts.get(k) ?? 0) + 1); };

  // one timeline: screens and observations sorted in with the actions (screen reads sort before an action at the same ms)
  type Ev = { at: number; ord: number; e?: LogEntry; ob?: Observation };
  const evs: Ev[] = [
    ...obs.map((ob, i) => ({ at: t(ob.at), ord: i, ob })),
    ...entries.map((e, i) => ({ at: t(e.at), ord: 1e6 + i, e })),
  ].sort((a, b) => a.at - b.at || a.ord - b.ord);

  const raws: Raw[] = []; let lastScreen: ScreenObs | undefined; let screenSize = o.screen;
  let fill: { raw: Raw; types: string[]; reset: boolean; legacy: boolean } | undefined;
  let secretN = 0;
  const push = (step: Step, at: string, extra: Partial<Raw> = {}) => {
    const r: Raw = { step, at, before: lastScreen, src: raws.length, ...extra };
    raws.push(r); return r;
  };
  const closeFill = () => {
    if (!fill) return;
    const s = fill.raw.step as Extract<Step, { kind: 'fill' }>;
    if (fill.legacy) s.value = fill.types.join('');
    fill = undefined;
  };
  const secretVar = () => `SECRET_${++secretN}`;

  for (const ev of evs) {
    if (ev.ob) {
      const ob = ev.ob;
      if (ob.kind === 'screen') {
        lastScreen = ob;
        if (ob.screen) screenSize = { width: ob.screen[0], height: ob.screen[1] };
        for (let k = raws.length - 1; k >= 0 && !raws[k].after; k--) raws[k].after = ob;   // first screen after each step
        continue;
      }
      closeFill();
      if (ob.kind === 'wait') {
        if (!ob.ok) { bump('failed wait (timed out)', 'failed waits (timed out)'); continue; }
        if (ob.until === 'idle') push({ kind: 'wait_for', until: 'idle' }, ob.at);
        else if (ob.query && (ob.query.text || ob.query.id || ob.query.type)) push({ kind: 'wait_for', until: ob.until, sel: cleanSel(ob.query) }, ob.at);
        continue;
      }
      if (ob.kind === 'scroll_to') {
        if (!ob.found) { bump('scroll_to attempt that found nothing', 'scroll_to attempts that found nothing'); continue; }
        push({ kind: 'scroll_to', sel: cleanSel(ob.query), ...(ob.direction && ob.direction !== 'down' ? { direction: ob.direction } : {}) }, ob.at);
        continue;
      }
      continue;
    }
    const e = ev.e!; const a = e.action ?? {}; const kind = String(a.action ?? '');
    // fill: its primitive taps / keys / typing become one step
    if (e.fill) {
      closeFill();
      const f = e.fill; const { sel } = tapSelector(e);
      const field: Selector | undefined = f.text || f.id || f.type
        ? cleanSel({ text: f.text, id: f.id, type: f.type, match: f.match, index: f.index })
        : sel;
      const value = f.secret ? `\${${secretVar()}}` : (f.value ?? '');
      const step: Step = field
        ? { kind: 'fill', field, value, ...(f.submit ? { submit: true } : {}), ...(f.clear === false ? { clear: false } : {}), ...(f.secret ? { secret: true } : {}) }
        : { kind: 'fill', at: pct(Number(a.x), Number(a.y), screenSize), fragile: true, value, ...(f.submit ? { submit: true } : {}), ...(f.secret ? { secret: true } : {}) };
      if (f.secret) warnings.push(`step ${raws.length + 1}: the typed secret is not recorded; set ${value.slice(2, -1)} in the environment when you run the flow`);
      fill = { raw: push(step, e.at), types: [], reset: false, legacy: false };
      continue;
    }
    if (e.via === 'fill') {
      if (!fill) {
        // logs from before fill markers: the first tap of the group is the field
        if (kind !== 'tap') { bump('fill step without its field tap', 'fill steps without their field tap'); continue; }
        const { sel } = tapSelector(e);
        fill = { raw: push(sel ? { kind: 'fill', field: sel, value: '' } : { kind: 'fill', at: pct(Number(a.x), Number(a.y), screenSize), fragile: true, value: '' }, e.at), types: [], reset: false, legacy: true };
        continue;
      }
      if (kind === 'type') {
        const txt = String(a.text ?? '');
        if (a.secret || txt.startsWith('•••')) { const s = fill.raw.step as Extract<Step, { kind: 'fill' }>; if (!s.secret) { s.secret = true; s.value = `\${${secretVar()}}`; fill.legacy = false; } continue; }
        if (fill.reset) { fill.types = []; fill.reset = false; }
        fill.types.push(txt);
      } else if (kind === 'key' && /^(delete|ctrl\+a)$/i.test(String(a.key))) fill.reset = true;
      else if (kind === 'key' && a.key === 'enter') (fill.raw.step as Extract<Step, { kind: 'fill' }>).submit = true;
      continue;
    }
    closeFill();
    if (e.replay) bump('replayed action (replay of an earlier session)', 'replayed actions (replay of an earlier session)');
    switch (kind) {
      case 'launch': push({ kind: 'launch', app: String(a.appId), stop: true }, e.at); break;
      case 'terminate': push({ kind: 'terminate', app: String(a.appId) }, e.at); break;
      case 'openUrl': push({ kind: 'open_url', url: String(a.url) }, e.at); break;
      case 'rotate': push({ kind: 'rotate', orientation: a.orientation === 'landscape' ? 'landscape' : 'portrait' }, e.at); break;
      case 'appearance': push({ kind: 'set_appearance', mode: a.appearance === 'dark' ? 'dark' : 'light' }, e.at); break;
      case 'gesture': push(a.gesture === 'go_home' ? { kind: 'home' } : { kind: 'gesture', gesture: String(a.gesture) }, e.at); break;
      case 'tap': {
        if (e.via === 'alert') { const b = e.resolved?.element?.text; push(b ? { kind: 'alert', action: 'button', button: b } : { kind: 'alert', action: 'accept' }, e.at); break; }
        if (e.via === 'back') { push({ kind: 'back' }, e.at); break; }
        const { sel, editable } = tapSelector(e);
        if (sel) push({ kind: 'tap', sel }, e.at, { editable });
        else push({ kind: 'tap', at: pct(Number(a.x), Number(a.y), screenSize), fragile: true }, e.at);
        break;
      }
      case 'longPress': push({ kind: 'long_press', at: pct(Number(a.x), Number(a.y), screenSize), fragile: true, ...(a.durationMs ? { durationMs: Number(a.durationMs) } : {}) }, e.at); break;
      case 'doubleTap': push({ kind: 'double_tap', at: pct(Number(a.x), Number(a.y), screenSize), fragile: true }, e.at); break;
      case 'swipe': {
        if (e.via === 'scroll-to') break;                               // the scroll_to observation stands for these
        if (e.via === 'swipe' && typeof e.direction === 'string' && DIRS.has(e.direction)) { push({ kind: 'swipe', direction: e.direction as Direction }, e.at); break; }
        const x1 = Number(a.x1), y1 = Number(a.y1), x2 = Number(a.x2), y2 = Number(a.y2);
        const dx = x2 - x1, dy = y2 - y1;
        if (Math.abs(dy) >= 2 * Math.abs(dx) && Math.abs(dy) > 20) push({ kind: 'swipe', direction: dy < 0 ? 'up' : 'down' }, e.at, { note: 'from a coordinate swipe' });
        else if (Math.abs(dx) >= 2 * Math.abs(dy) && Math.abs(dx) > 20) push({ kind: 'swipe', direction: dx < 0 ? 'left' : 'right' }, e.at, { note: 'from a coordinate swipe' });
        else push({ kind: 'swipe', from: pct(x1, y1, screenSize), to: pct(x2, y2, screenSize), fragile: true, ...(a.durationMs ? { durationMs: Number(a.durationMs) } : {}) }, e.at);
        break;
      }
      case 'type': {
        const txt = String(a.text ?? '');
        if (a.secret || txt.startsWith('•••')) { const v = secretVar(); push({ kind: 'type', text: `\${${v}}`, secret: true }, e.at); warnings.push(`step ${raws.length}: the typed secret is not recorded; set ${v} in the environment when you run the flow`); }
        else push({ kind: 'type', text: txt }, e.at);
        break;
      }
      case 'key': {
        const k = String(a.key ?? '');
        if (e.via === 'back' || k === 'back') push({ kind: 'back' }, e.at);
        else if (k === 'home') push({ kind: 'home' }, e.at);
        else push({ kind: 'key', key: k }, e.at);
        break;
      }
      case 'pinch': bump('pinch gesture (not supported in flows)', 'pinch gestures (not supported in flows)'); break;
      default:
        if (/^(lease|handoff)\./.test(kind)) break;
        if (kind === 'install' || kind === 'uninstall') { bump(`app ${kind} (do it in your CI setup)`, `app ${kind}s (do them in your CI setup)`); break; }
        if (kind === 'shell') { bump('shell command (not part of a flow)', 'shell commands (not part of a flow)'); break; }
        if (kind) bump(`${kind} action (not part of a flow)`, `${kind} actions (not part of a flow)`);
    }
  }
  closeFill();
  const finalScreen = lastScreen;

  // ── clean-up passes ────────────────────────────────────────────────────
  let steps = raws;
  // tap a field, (clear it,) type → fill
  {
    const out: Raw[] = [];
    for (let i = 0; i < steps.length; i++) {
      const r = steps[i];
      if (r.step.kind === 'tap' && r.step.sel) {
        let j = i + 1; let cleared = false;
        while (j < steps.length && steps[j].step.kind === 'key' && /^(delete|ctrl\+a|KEYCODE_MOVE_END|KEYCODE_DEL)$/i.test((steps[j].step as { key: string }).key)) { cleared = true; j++; }
        const ty = steps[j];
        if (ty && ty.step.kind === 'type' && (r.editable || cleared)) {
          const tstep = ty.step;
          let submit = !!tstep.submit; let k = j + 1;
          if (steps[k]?.step.kind === 'key' && (steps[k].step as { key: string }).key === 'enter') { submit = true; k++; }
          out.push({ ...r, step: { kind: 'fill', field: r.step.sel, value: tstep.text, ...(submit ? { submit: true } : {}), ...(tstep.secret ? { secret: true } : {}) }, after: steps[k - 1].after });
          i = k - 1; continue;
        }
      }
      out.push(r);
    }
    steps = out;
  }
  // terminate X then launch X: launch already stops the app first (stop: true)
  steps = steps.filter((r, i) => !(r.step.kind === 'terminate' && steps[i + 1]?.step.kind === 'launch' && (steps[i + 1].step as { app?: string }).app === r.step.app));
  // wait_for visible X right before a step on X: that step waits for X itself
  steps = steps.filter((r, i) => {
    const n = steps[i + 1]?.step as { kind: string; sel?: Selector; field?: Selector } | undefined;
    return !(r.step.kind === 'wait_for' && r.step.until === 'visible' && n && ['tap', 'long_press', 'double_tap', 'fill', 'assert_visible', 'scroll_to'].includes(n.kind) && sameSel(r.step.sel, n.sel ?? n.field));
  });
  // repeated steps: keep the last of a run of identical waits / launches / fills of the same field (a retry)
  {
    const out: Raw[] = [];
    for (const r of steps) {
      const p = out[out.length - 1];
      if (p) {
        const a = p.step, b = r.step;
        const same = a.kind === b.kind && JSON.stringify(stepOut(a)) === JSON.stringify(stepOut(b));
        const idem = same && ['wait_for', 'launch', 'set_appearance', 'rotate', 'hide_keyboard', 'scroll_to', 'assert_visible', 'assert_not_visible', 'home'].includes(a.kind);
        const refill = a.kind === 'fill' && b.kind === 'fill' && sameSel(a.field, b.field) && !a.at && !b.at;
        if (idem || refill) { if (refill) dropped.push(`an earlier fill of ${describeSelector(a.kind === 'fill' ? a.field : undefined)} (filled again right after)`); out[out.length - 1] = { ...r, before: p.before }; continue; }
      }
      out.push(r);
    }
    steps = out;
  }
  // undone steps: a tap and then back (or the same tap twice) that left the screen as it was
  if (!o.keepNoise) {
    const out: Raw[] = [];
    for (let i = 0; i < steps.length; i++) {
      const a = steps[i], b = steps[i + 1];
      if (a.step.kind === 'tap' && b && a.before && b.after && a.after) {
        const undoneByBack = b.step.kind === 'back' && a.after.sig !== a.before.sig && b.after.sig === a.before.sig;
        const toggledBack = b.step.kind === 'tap' && sameSel(a.step.sel, b.step.sel) && !!a.step.sel && b.after.sig === a.before.sig && a.after.sig !== a.before.sig;
        if (undoneByBack || toggledBack) {
          dropped.push(`${describeStep(a.step)} then ${describeStep(b.step)}: the screen ended up as before (an accidental or undone tap)`);
          i++; continue;
        }
      }
      out.push(a);
    }
    steps = out;
  }

  // ── assertions ─────────────────────────────────────────────────────────
  const auto = o.autoAssert !== false;
  const final: Raw[] = []; let nAssert = 0;
  const isCheck = (s?: Step) => !!s && ((s.kind === 'wait_for' && s.until === 'visible') || s.kind === 'assert_visible');
  for (let i = 0; i < steps.length; i++) {
    const r = steps[i];
    final.push(r);
    if (auto && r.step.kind === 'launch' && !isCheck(steps[i + 1]?.step)) {
      // the screen the next step acted on (the last read before it), compared with the screen before the launch
      const nextAt = steps[i + 1] ? t(steps[i + 1].at) : Infinity;
      const seen = obs.filter((x): x is ScreenObs => x.kind === 'screen' && t(x.at) >= t(r.at) && t(x.at) <= nextAt);
      const scr = seen[seen.length - 1];
      const next = steps[i + 1]?.step as { sel?: Selector; field?: Selector } | undefined;
      const nextTarget = next?.sel?.text ?? next?.field?.text;
      const txt = pickAssertText(scr, r.before, nextTarget ? [nextTarget] : []) ?? pickAssertText(scr, r.before);
      if (txt) { final.push({ step: { kind: 'assert_visible', sel: { text: txt } }, at: r.at, src: -1, note: 'auto' }); nAssert++; }
      else warnings.push(`${scr ? 'nothing distinctive was on screen' : 'the screen was not read (or had no readable text)'} after launching ${(r.step as { app?: string }).app}: add an assert_visible for its first screen yourself`);
    }
  }
  steps = final;
  const lastAct = [...steps].reverse().find((r) => r.src >= 0);
  if (o.assertions?.length) {
    for (const s of o.assertions) { steps.push({ step: s, at: o.now ?? new Date().toISOString(), src: -1, note: 'explicit' }); nAssert++; }
  } else if (auto && lastAct && !isCheck(steps[steps.length - 1]?.step)) {
    const after = finalScreen && t(finalScreen.at) >= t(lastAct.at) && finalScreen !== lastAct.before ? finalScreen : undefined;
    const already = steps.filter((r) => r.step.kind === 'assert_visible').map((r) => (r.step as { sel: Selector }).sel.text ?? '');
    const txt = after ? (pickAssertText(after, lastAct.before, already) ?? pickAssertText(after, undefined, already)) : undefined;
    if (txt) { steps.push({ step: { kind: 'assert_visible', sel: { text: txt } }, at: after!.at, src: -1, note: 'auto' }); nAssert++; }
    else warnings.push(after ? 'nothing distinctive on the final screen to assert: add an assert_visible yourself' : 'the screen was not read after the last step, so there is no final assertion: add one (or read the screen and save again)');
  }

  // ── header ─────────────────────────────────────────────────────────────
  const launched = steps.map((r) => r.step).filter((s): s is Extract<Step, { kind: 'launch' }> => s.kind === 'launch').map((s) => s.app!).filter(Boolean);
  const appId = o.appId ?? launched[0];
  const os = osVersionNumber(o.osVersion);
  const comments = new Map<number, string[]>();
  steps.forEach((r, i) => {
    const c: string[] = [];
    if (r.step.fragile) c.push('fragile: raw coordinates (percent of the screen); replace with a text or id selector if you can');
    if (r.note === 'from a coordinate swipe') c.push('was a coordinate swipe; replayed as a direction swipe');
    if (r.note === 'auto') c.push('assertion added by flow save: edit or remove it');
    if (c.length) comments.set(i, c);
  });
  for (const [k, n] of counts) { const [one, many] = k.split('\u0000'); dropped.push(`${n} ${n === 1 ? one : many}`); }
  const recordedAt = o.now ?? new Date().toISOString();
  const header = [
    `PhoneDock flow, saved by \`phonedock flow save\` from ${o.device ?? 'a device'}${o.osVersion ? ` (${o.osVersion})` : ''} at ${recordedAt.slice(0, 19).replace('T', ' ')} UTC.`,
    `Run it:  phonedock test ${'<this file>'} --device <id>     Format: docs/API.md#flows`,
    ...(dropped.length ? ['', 'Left out of this flow:', ...dropped.map((d) => `- ${d}`)] : []),
  ];
  const flow: Omit<Flow, 'warnings' | 'file'> = {
    name: o.name ?? `${appId ?? 'flow'} (${recordedAt.slice(0, 10)})`,
    ...(appId ? { appId } : {}),
    ...(o.platform ? { platform: o.platform } : {}),
    ...(os ? { minOS: o.platform === 'android' ? os.split('.')[0] : os } : {}),
    recordedOn: { ...(o.device ? { device: o.device } : {}), ...(o.model ? { model: o.model } : {}), ...(o.osVersion ? { os: o.osVersion } : {}), ...(screenSize ? { screen: `${screenSize.width}x${screenSize.height}` } : {}), at: recordedAt },
    env: {},
    steps: steps.map((r) => r.step),
  };
  if (!flow.steps.length) warnings.push('no steps in that time range (check --since / --owner)');
  const text = writeFlow({ ...flow, header, comments });
  return { flow, text, comments, header, warnings, dropped, stats: { entries: entries.length, observations: obs.length, steps: flow.steps.length, assertions: nAssert } };
}

function cleanSel(q: Selector): Selector {
  const s: Selector = {};
  if (q.text) s.text = q.text;
  if (q.id) s.id = shortId(q.id);
  if (q.type) s.type = shortType(q.type);
  if (q.match && q.match !== 'contains') s.match = q.match;
  if (q.index) s.index = q.index;
  return s;
}

// ── Maestro export ─────────────────────────────────────────────────────────
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function maestroSel(s: Selector, notes: string[]): unknown {
  const text = s.text === undefined ? undefined : s.match === 'regex' ? s.text : s.match === 'exact' || !s.match ? reEscape(s.text) : `.*${reEscape(s.text)}.*`;
  if (s.type) notes.push(`type ${s.type} has no Maestro selector; matching by ${s.text !== undefined ? 'text' : 'id'} only`);
  const o: Record<string, unknown> = {};
  if (text !== undefined) o.text = text;
  if (s.id) o.id = s.id;
  if (s.index) o.index = s.index;
  if (!Object.keys(o).length) { notes.push('a type-only selector has no Maestro equivalent'); return undefined; }
  return Object.keys(o).length === 1 && o.text !== undefined ? o.text : o;
}
const MAESTRO_KEYS: Record<string, string> = { enter: 'Enter', delete: 'Backspace', backspace: 'Backspace', home: 'Home', back: 'Back', tab: 'Tab', volume_up: 'Volume Up', volume_down: 'Volume Down', power: 'Power', lock: 'Lock' };

/** Maestro YAML for a flow. Steps without an equivalent become comments that say so. */
export function toMaestro(f: Flow): { text: string; unsupported: string[] } {
  const lines: string[] = [];
  const unsupported: string[] = [];
  const cmd = (step: Step, v: unknown, notes: string[] = []) => {
    for (const n of notes) lines.push(`# note: ${n}`);
    const opt = step.optional || step.label ? { ...(step.label ? { label: step.label } : {}), ...(step.optional ? { optional: true } : {}) } : undefined;
    let body = v;
    if (opt) body = typeof v === 'string' ? (isObj(v) ? { ...(v as object), ...opt } : v) : v;
    if (opt && isObj(body)) {
      const [[k, inner]] = Object.entries(body as Record<string, unknown>);
      body = { [k]: isObj(inner) ? { ...inner, ...opt } : typeof inner === 'string' && /^(tapOn|assertVisible|assertNotVisible|longPressOn|doubleTapOn)$/.test(k) ? { text: inner, ...opt } : inner };
    }
    lines.push(stringifyYaml([body]).trimEnd());
  };
  const no = (step: Step, why: string) => {
    unsupported.push(`${describeStep(step)}: ${why}`);
    lines.push(`# not exported: ${describeStep(step)} (${why})`);
  };
  const app = f.appId;
  for (const s of f.steps) {
    const notes: string[] = [];
    if (s.fragile) notes.push('fragile: raw coordinates');
    switch (s.kind) {
      case 'launch': {
        const o: Record<string, unknown> = {};
        if (s.app && s.app !== app) o.appId = s.app;
        if (!s.stop) o.stopApp = false;
        cmd(s, Object.keys(o).length ? { launchApp: o } : 'launchApp', notes); break;
      }
      case 'terminate': cmd(s, s.app && s.app !== app ? { stopApp: s.app } : 'stopApp', notes); break;
      case 'tap': case 'long_press': case 'double_tap': {
        const name = s.kind === 'tap' ? 'tapOn' : s.kind === 'long_press' ? 'longPressOn' : 'doubleTapOn';
        if (s.at) { cmd(s, { [name]: { point: s.at.unit === '%' ? `${Math.round(s.at.x)}%,${Math.round(s.at.y)}%` : `${Math.round(s.at.x)},${Math.round(s.at.y)}` } }, notes); break; }
        const sel = maestroSel(s.sel!, notes);
        if (sel === undefined) { no(s, notes.pop()!); break; }
        if (s.durationMs) notes.push('Maestro long presses have a fixed duration');
        cmd(s, { [name]: sel }, notes); break;
      }
      case 'fill': {
        if (s.at) cmd(s, { tapOn: { point: `${Math.round(s.at.x)}%,${Math.round(s.at.y)}%` } }, notes);
        else { const sel = maestroSel(s.field!, notes); if (sel === undefined) { no(s, notes.pop()!); break; } cmd(s, { tapOn: sel }, notes); }
        if (s.clear !== false) lines.push(stringifyYaml(['eraseText']).trimEnd());
        lines.push(stringifyYaml([{ inputText: s.value }]).trimEnd());
        if (s.submit) lines.push(stringifyYaml([{ pressKey: 'Enter' }]).trimEnd());
        break;
      }
      case 'type': cmd(s, { inputText: s.text }, notes); if (s.submit) lines.push(stringifyYaml([{ pressKey: 'Enter' }]).trimEnd()); break;
      case 'key': { const k = MAESTRO_KEYS[s.key.toLowerCase()]; if (k) cmd(s, { pressKey: k }, notes); else no(s, `no Maestro key for "${s.key}"`); break; }
      case 'back': cmd(s, 'back', notes); break;
      case 'home': cmd(s, { pressKey: 'Home' }, notes); break;
      case 'hide_keyboard': cmd(s, 'hideKeyboard', notes); break;
      case 'scroll_to': {
        const sel = maestroSel(s.sel, notes); if (sel === undefined) { no(s, notes.pop()!); break; }
        cmd(s, { scrollUntilVisible: { element: typeof sel === 'string' ? { text: sel } : sel, direction: (s.direction ?? 'down').toUpperCase() } }, notes); break;
      }
      case 'swipe':
        if (s.from && s.to) cmd(s, { swipe: { start: `${Math.round(s.from.x)}%,${Math.round(s.from.y)}%`, end: `${Math.round(s.to.x)}%,${Math.round(s.to.y)}%` } }, notes);
        else cmd(s, { swipe: { direction: s.direction!.toUpperCase() } }, notes);
        break;
      case 'wait_for': {
        if (s.until === 'idle') { cmd(s, 'waitForAnimationToEnd', notes); break; }
        const sel = maestroSel(s.sel!, notes); if (sel === undefined) { no(s, notes.pop()!); break; }
        cmd(s, { extendedWaitUntil: { [s.until === 'visible' ? 'visible' : 'notVisible']: sel, timeout: s.timeoutMs ?? 10000 } }, notes); break;
      }
      case 'set_appearance': no(s, 'Maestro has setDarkMode in recent versions; add it by hand if yours does'); break;
      case 'rotate': cmd(s, { setOrientation: s.orientation === 'portrait' ? 'PORTRAIT' : 'LANDSCAPE_LEFT' }, notes); break;
      case 'open_url': cmd(s, { openLink: s.url }, notes); break;
      case 'gesture': if (s.gesture === 'go_home') cmd(s, { pressKey: 'Home' }, notes); else no(s, 'no Maestro command for system gestures'); break;
      case 'alert':
        if (s.action === 'button' && s.button) cmd(s, { tapOn: reEscape(s.button) }, ['PhoneDock answered a system prompt; Maestro taps the button by text']);
        else no(s, 'Maestro has no accept/dismiss for system prompts; tap the button by its text');
        break;
      case 'sleep': no(s, 'Maestro has no plain sleep; use extendedWaitUntil or waitForAnimationToEnd'); break;
      case 'assert_visible': case 'assert_not_visible': {
        const sel = maestroSel(s.sel, notes); if (sel === undefined) { no(s, notes.pop()!); break; }
        cmd(s, { [s.kind === 'assert_visible' ? 'assertVisible' : 'assertNotVisible']: sel }, notes); break;
      }
      case 'assert_text': {
        const fieldSel = maestroSel(s.field, notes); if (fieldSel === undefined) { no(s, notes.pop()!); break; }
        if (!isObj(fieldSel) || !fieldSel.id) { no(s, 'Maestro checks an element\'s text through its id; this field has no id'); break; }
        const text = s.equals !== undefined ? reEscape(s.equals) : s.contains !== undefined ? `.*${reEscape(s.contains)}.*` : s.matches!;
        cmd(s, { assertVisible: { id: fieldSel.id, text } }, notes); break;
      }
      case 'screenshot': if (s.baseline) notes.push('baseline comparison is not exported'); cmd(s, { takeScreenshot: s.name }, notes); break;
    }
  }
  const head = [
    `# Maestro flow exported from the PhoneDock flow "${f.name}" by \`phonedock flow export --maestro\`.`,
    '# Text: PhoneDock matches "contains" (exact matches first); Maestro matches the whole text as a regex, so',
    '# texts are written escaped, and steps marked match: contains become .*text.*.',
    '# The mapping was not run with Maestro by PhoneDock: try it once with `maestro test` before relying on it.',
    ...(unsupported.length ? [`# ${unsupported.length} step${unsupported.length > 1 ? 's have' : ' has'} no Maestro equivalent and ${unsupported.length > 1 ? 'are' : 'is'} commented out below.`] : []),
  ];
  const appLine = app ? `appId: ${stringifyYaml(app).trim()}` : '# appId: <your app id>  (the PhoneDock flow had none)';
  return { text: `${head.join('\n')}\n${appLine}\n---\n${lines.join('\n')}\n`, unsupported };
}
