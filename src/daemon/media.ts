// Image transforms (PNG → JPEG / resized PNG) and UI-tree text rendering.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBuffer, run } from '../core/exec.ts';
import { which } from '../core/paths.ts';
import { PhoneDockError, type Bounds, type ElementMatch, type UiElement, type UiTree } from '../core/types.ts';
import { windowsLine } from '../backends/android-windows.ts';

export function pngSize(png: Buffer): { width: number; height: number } | undefined {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) return undefined;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
export function jpegSize(j: Buffer): { width: number; height: number } | undefined {
  let i = 2;
  while (i + 9 < j.length) {
    if (j[i] !== 0xff) { i++; continue; }
    const m = j[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: j.readUInt16BE(i + 5), width: j.readUInt16BE(i + 7) };
    i += 2 + j.readUInt16BE(i + 2);
  }
  return undefined;
}

export function fitSize(w: number, h: number, maxSize?: number): { width: number; height: number } {
  if (!maxSize || Math.max(w, h) <= maxSize) return { width: w, height: h };
  const k = Math.max(w, h) / maxSize;
  return { width: Math.max(2, Math.round(w / k / 2) * 2), height: Math.max(2, Math.round(h / k / 2) * 2) };
}

/** Convert a PNG to the requested format/size. Returns bytes + output dims. */
export async function transformPng(png: Buffer, format: 'png' | 'jpeg', maxSize?: number, quality = 70): Promise<{ data: Buffer; width: number; height: number; type: string }> {
  const src = pngSize(png);
  if (!src) throw new PhoneDockError('The screenshot is not a valid PNG image', 'bad_image', 500, undefined, 'Backend returned a non-PNG screenshot');
  const out = fitSize(src.width, src.height, maxSize);
  const resize = out.width !== src.width || out.height !== src.height;
  if (format === 'png' && !resize) return { data: png, ...src, type: 'image/png' };
  const ff = which('ffmpeg');
  const q = String(Math.max(2, Math.min(31, Math.round(31 - (Math.max(1, Math.min(100, quality)) / 100) * 29))));
  if (ff) {
    const vf = resize ? ['-vf', `scale=${out.width}:${out.height}:flags=bilinear`] : [];
    const enc = format === 'jpeg' ? ['-f', 'mjpeg', '-q:v', q] : ['-f', 'image2pipe', '-c:v', 'png'];
    const r = await runBuffer(ff, ['-loglevel', 'error', '-f', 'png_pipe', '-i', '-', ...vf, '-frames:v', '1', ...enc, '-'], { input: png, timeoutMs: 20_000 });
    return { data: r.stdout, ...out, type: format === 'jpeg' ? 'image/jpeg' : 'image/png' };
  }
  // sips fallback
  const dir = mkdtempSync(join(tmpdir(), 'pd-img-'));
  try {
    const i = join(dir, 'in.png'); const o = join(dir, format === 'jpeg' ? 'out.jpg' : 'out.png');
    writeFileSync(i, png);
    const args = ['-s', 'format', format === 'jpeg' ? 'jpeg' : 'png'];
    if (format === 'jpeg') args.push('-s', 'formatOptions', String(quality));
    if (resize) args.push('-Z', String(Math.max(out.width, out.height)));
    await run('/usr/bin/sips', [...args, i, '--out', o], { timeoutMs: 20_000 });
    return { data: readFileSync(o), ...out, type: format === 'jpeg' ? 'image/jpeg' : 'image/png' };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ── UI tree helpers ─────────────────────────────────────────────────────────
export function flatten(els: UiElement[], out: UiElement[] = []): UiElement[] {
  for (const e of els) { out.push(e); if (e.children) flatten(e.children, out); }
  return out;
}
export function findRef(tree: UiTree, ref: string): UiElement | undefined {
  return flatten(tree.root).find((e) => e.ref === ref);
}
/** Make accessibility trees agent-friendly (all backends): drop elements entirely outside the screen
 *  (e.g. iOS keyboard frames reported off-screen), drop exact repeats (same type/text/bounds — iOS
 *  exposes some subtrees twice), and unwrap unlabeled, non-interactive wrappers that only repeat their
 *  parent's frame. Refs are kept as-is so they stay valid for tap-by-ref. */
export function cleanTree(tree: UiTree): UiTree {
  const W = tree.screen.width, H = tree.screen.height;
  const seen = new Set<string>();
  const onScreen = (b: UiElement['bounds']) => !(W && H) || (b.x < W && b.y < H && b.x + b.width > 0 && b.y + b.height > 0);
  const same = (a: UiElement['bounds'], b?: UiElement['bounds']) => !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  const walk = (els: UiElement[], parent?: UiElement['bounds']): UiElement[] => els.flatMap((e) => {
    const kids = e.children ? walk(e.children, e.bounds) : [];
    const plain = !(e.text || e.label || e.id || e.value || e.clickable || e.scrollable || e.focused);
    const key = `${e.type}|${e.text ?? ''}|${e.label ?? ''}|${e.id ?? ''}|${e.bounds.x},${e.bounds.y},${e.bounds.width},${e.bounds.height}`;
    if (e.bounds.width <= 0 || e.bounds.height <= 0 || !onScreen(e.bounds) || seen.has(key) || (plain && same(e.bounds, parent))) return kids;
    seen.add(key);
    const out: UiElement = { ...e };
    if (kids.length) out.children = kids; else delete out.children;
    return [out];
  });
  return { ...tree, root: walk(tree.root) };
}
export function center(e: UiElement) { return { x: Math.round(e.bounds.x + e.bounds.width / 2), y: Math.round(e.bounds.y + e.bounds.height / 2) }; }

// ── partial trees + OCR merge ───────────────────────────────────────────────
// iOS accessibility containers. (Empty Android layouts/Views are mostly decoration — backgrounds, scrims, bar
// backgrounds — so on Android only web views count.)
const CONTAINER = /^(Group|Other|GenericElement)$/;
const WEBVIEW = /WebView$/i;
const hasText = (e: UiElement) => !!(e.text || e.label || e.value || e.placeholder);
const ctr = (b: Bounds) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const inBox = (b: Bounds, p: { x: number; y: number }) => p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height;

/** Places where the accessibility tree is clearly missing content that is on screen: a content-sized container
 *  with no children and no text (iOS Settings rows such as "Dark Appearance" come out as an empty Group), or a web
 *  view with no text inside (Chrome before its renderer exposes the page). A container that other text-bearing
 *  elements sit on top of is a background, not a gap. Pure; cheap enough to run on every /ui. */
export function partialRegions(tree: UiTree): UiElement[] {
  if (tree.source !== 'accessibility') return [];
  const W = tree.screen.width || 0, H = tree.screen.height || 0;
  const all = flatten(tree.root);
  const texts = all.filter(hasText);
  const out: UiElement[] = [];
  for (const e of all) {
    const t = shortType(e.type); const b = e.bounds;
    if (b.width <= 0 || b.height <= 0) continue;
    if (W && H && (b.x >= W || b.y >= H || b.x + b.width <= 0 || b.y + b.height <= 0)) continue;
    const covered = (k: UiElement) => k !== e && inBox(b, ctr(k.bounds)) && k.bounds.width * k.bounds.height < b.width * b.height;
    // Chrome before its renderer's tree is ready: a FrameLayout labelled "Web View" with nothing inside
    if (WEBVIEW.test(t) || /^web ?view$/i.test((e.label ?? e.text ?? '').trim())) {
      const inner = e.children?.length ? flatten(e.children) : [];
      if (inner.some(hasText)) continue; // (browser toolbars overlap the web view's frame: don't count them)
      if (b.width >= W * 0.3 && b.height >= Math.max(40, H * 0.08)) out.push(e);
      continue;
    }
    if (!CONTAINER.test(t) || e.children?.length || hasText(e)) continue;
    if (b.height < Math.max(30, H * 0.025) || b.width < W * 0.25) continue;   // separators, spacers, icons
    if (texts.some(covered) || all.some((k) => k !== e && (k.clickable || isEditable(k)) && inBox(b, ctr(k.bounds)) && k.bounds.width * k.bounds.height < b.width * b.height)) continue;
    out.push(e);
  }
  return out;
}

const normTxt = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const overlaps = (a: Bounds, b: Bounds) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
/** Add the OCR lines that fall inside `regions` (from partialRegions) to an accessibility tree, as `ocr: true` Text
 *  children of the region's element with fresh refs (they stay tappable by ref). Lines that repeat text the tree
 *  already has at that spot are skipped. Returns a new tree and how many lines were added. Pure. */
export function mergeOcr(tree: UiTree, ocrTree: UiTree, regions: UiElement[]): { tree: UiTree; merged: number } {
  if (!regions.length || !ocrTree.root.length) return { tree, merged: 0 };
  let maxRef = 0;
  const all = flatten(tree.root);
  for (const e of all) { const m = /^e(\d+)$/.exec(e.ref); if (m) maxRef = Math.max(maxRef, +m[1]); }
  const known = all.filter(hasText);
  const sx = ocrTree.screen.width && tree.screen.width ? tree.screen.width / ocrTree.screen.width : 1;
  const sy = ocrTree.screen.height && tree.screen.height ? tree.screen.height / ocrTree.screen.height : 1;
  const add = new Map<UiElement, UiElement[]>();
  let merged = 0;
  for (const o of flatten(ocrTree.root)) {
    const t = (o.text ?? o.label ?? '').trim(); if (!t) continue;
    const b = { x: Math.round(o.bounds.x * sx), y: Math.round(o.bounds.y * sy), width: Math.round(o.bounds.width * sx), height: Math.round(o.bounds.height * sy) };
    const c = ctr(b);
    const region = regions.find((r) => inBox(r.bounds, c));
    if (!region) continue;
    if (known.some((k) => overlaps(k.bounds, b) && [k.text, k.label, k.value].some((v) => v && normTxt(v) === normTxt(t)))) continue;
    // drawn by something on top of the region (a browser toolbar over the web view's frame), not by the region
    const ra = region.bounds.width * region.bounds.height;
    if (all.some((k) => k !== region && k.bounds.width * k.bounds.height < ra && inBox(k.bounds, c) && !inBox(k.bounds, ctr(region.bounds)))) continue;
    const el: UiElement = { ref: `e${++maxRef}`, type: 'Text', text: t, bounds: b, ocr: true, enabled: true };
    add.set(region, [...(add.get(region) ?? []), el]);
    merged++;
  }
  if (!merged) return { tree, merged: 0 };
  const walk = (els: UiElement[]): UiElement[] => els.map((e) => {
    const extra = add.get(e);
    const kids = e.children ? walk(e.children) : undefined;
    if (!extra && kids === e.children) return e;
    const out: UiElement = { ...e };
    const all2 = [...(kids ?? []), ...(extra ?? [])];
    if (all2.length) out.children = all2;
    return out;
  });
  return { tree: { ...tree, root: walk(tree.root) }, merged };
}

const q = (s: string) => JSON.stringify(s.length > 120 ? s.slice(0, 117) + '…' : s);
/** Compact outline: `e12 Button "Sign in" @(540,1210) 300x96` */
export function uiText(tree: UiTree): string {
  const lines: string[] = [`# ${tree.source} ${tree.screen.width}x${tree.screen.height} ${tree.capturedAt}`];
  const over = windowsLine(tree.windows);
  if (over) lines.push(`# ${over}`);
  if (tree.ocr?.merged) lines.push(`# ${tree.ocr.merged} text line(s) marked [ocr] were read from the screenshot: the accessibility tree has no content there (controls such as switches in those rows aren't listed)`);
  for (const e of flatten(tree.root)) {
    const interesting = e.text || e.label || e.id || e.clickable || e.scrollable || e.focused || e.value || e.placeholder;
    if (!interesting) continue;
    const c = tapPoint(e);
    let s = `${e.ref} ${e.type}`;
    if (e.text) s += ` ${q(e.text)}`;
    if (e.label && e.label !== e.text) s += ` label=${q(e.label)}`;
    if (e.id) s += ` id=${e.id.replace(/^.*:id\//, '')}`;
    if (e.value && e.value !== e.text && !(e.checked !== undefined && /^[01]$/.test(e.value))) s += ` value=${q(e.value)}`;
    if (e.placeholder) s += ` placeholder=${q(e.placeholder)}${e.text || e.value ? '' : ' (empty)'}`;
    s += ` @(${c.x},${c.y}) ${e.bounds.width}x${e.bounds.height}`;
    const flags = [e.clickable && 'clickable', e.scrollable && 'scrollable', e.focused && 'focused', e.selected && 'selected', e.checked === true && 'on', e.checked === false && 'off', e.enabled === false && 'disabled', e.ocr && 'ocr'].filter(Boolean);
    if (flags.length) s += ` [${flags.join(',')}]`;
    lines.push(s);
  }
  return lines.join('\n') + '\n';
}

// ── element search (POST /find, /wait, /fill) ───────────────────────────────
export type MatchMode = 'contains' | 'exact' | 'regex';
export interface FindQuery { text?: string; id?: string; type?: string; match?: MatchMode; editable?: boolean }

const EDITABLE = /^(TextField|SecureTextField|SearchField|TextView|TextArea|EditText|AutoCompleteTextView|MultiAutoCompleteTextView|ExtractEditText|TextInputEditText|AppCompatEditText|AppCompatAutoCompleteTextView|ComboBox)$/i;
export const shortType = (t: string) => (t ?? '').split('.').pop() ?? '';
export const shortId = (id: string) => id.replace(/^.*:id\//, '');
// iOS "TextView" (UITextView) is editable; Android's android.widget.TextView is a label.
export function isEditable(e: UiElement): boolean { const t = shortType(e.type); return EDITABLE.test(t) && !(t === 'TextView' && (e.type ?? '').includes('.')); }

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
function matcher(q: string, mode: MatchMode): { test: (s: string | undefined) => boolean; exact: (s: string | undefined) => boolean } {
  const nq = norm(q);
  const exact = (s: string | undefined) => s !== undefined && norm(s) === nq;
  if (mode === 'regex') {
    let re: RegExp;
    try { re = new RegExp(q, 'i'); } catch (e) { throw new PhoneDockError("The search pattern is invalid", 'bad_request', 400, undefined, `Bad regex ${JSON.stringify(q)}: ${(e as Error).message}`); }
    return { test: (s) => s !== undefined && re.test(s), exact };
  }
  if (mode === 'exact') return { test: exact, exact };
  return { test: (s) => s !== undefined && norm(s).includes(nq), exact };
}

const KB_IDS = new Set(['shift', 'delete', 'Return', 'more', 'space', 'dictation', 'Next keyboard']);
/** iOS software keyboard (the tree exposes its keys; Android's IME is a separate window and never appears). */
export function keyboardInfo(tree: UiTree): { visible: boolean; frame?: UiElement['bounds']; node?: UiElement; deleteKey?: UiElement; returnKey?: UiElement } {
  // Android: the keyboard is its own window (the tree is the app's); the helper reports it with its bounds
  const ime = tree.windows?.find((w) => w.role === 'keyboard');
  if (ime) return { visible: true, frame: ime.bounds };
  if (tree.windows) return { visible: false };
  let best: UiElement | undefined; let deleteKey: UiElement | undefined; let returnKey: UiElement | undefined;
  const walk = (e: UiElement): number => {
    let n = e.id && KB_IDS.has(e.id) ? 1 : 0;
    if (e.id === 'delete' && /^(Button|Key)$/.test(shortType(e.type))) deleteKey = e;
    if (e.id === 'Return' && /^(Button|Key)$/.test(shortType(e.type))) returnKey ??= e;
    for (const k of e.children ?? []) n += walk(k);
    if (n >= 3 && (!best || e.bounds.width * e.bounds.height < best.bounds.width * best.bounds.height)) best = e;
    return n;
  };
  for (const e of tree.root) walk(e);
  if (!best || !deleteKey) return { visible: false };
  // the keys' container is a bit smaller than the keyboard: grow it to the screen bottom
  const frame = { x: 0, y: best.bounds.y, width: tree.screen.width || best.bounds.width, height: Math.max(best.bounds.height, (tree.screen.height || 0) - best.bounds.y) };
  return { visible: true, frame, node: best, deleteKey, returnKey };
}
export function focusedElement(tree: UiTree): UiElement | undefined {
  const all = flatten(tree.root);
  return all.find((e) => e.focused && isEditable(e)) ?? all.find((e) => e.focused && !e.children?.length);
}
function within(b: UiElement['bounds'], p: { x: number; y: number }) { return p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height; }

const TOGGLE = /^(Switch|Toggle|CheckBox|ToggleButton|SwitchCompat|SwitchMaterial|MaterialSwitch)$/i;
/** Where a tap actually activates the element. A toggle row that contains its own switch (SwiftUI Toggle in a
 *  Form: the row is a CheckBox whose label area does nothing) is tapped on the inner switch. */
export function tapPoint(e: UiElement): { x: number; y: number } {
  if (TOGGLE.test(shortType(e.type)) && e.children?.length) {
    const inner = flatten(e.children).find((k) => TOGGLE.test(shortType(k.type)) && k.bounds.width < e.bounds.width);
    if (inner) return center(inner);
  }
  return center(e);
}

/** iOS bars that float over the content at the bottom of the screen: the search field of iOS 26 Settings (with its
 *  glass background, wider than the field's frame) and tab bars. A row under one shows in the tree but a tap there
 *  hits the bar (blind run 4: "Developer" under the Search field did nothing). */
export interface FloatingBar { name: string; /** the bar's own element */ frame: UiElement['bounds']; /** the band it takes taps in */ region: UiElement['bounds'] }
export function floatingBars(tree: UiTree): FloatingBar[] {
  const W = tree.screen.width, H = tree.screen.height;
  const root = tree.root[0];
  if (!W || !H || !root || shortType(root.type) !== 'Application') return [];
  const out: FloatingBar[] = [];
  for (const e of flatten(tree.root)) {
    const b = e.bounds; const cy = b.y + b.height / 2;
    const search = isEditable(e) && cy > H * 0.8 && b.width > W * 0.4;
    const tabs = /TabBar/i.test(shortType(e.type)) && cy > H * 0.75;
    if (!search && !tabs) continue;
    const pad = search ? Math.max(24, Math.round(b.height * 0.4)) : 0;   // the glass around the search field
    const hint = e.label ?? e.placeholder;   // not its text: that is what was typed into it
    out.push({ name: search ? (hint ? `the floating ${JSON.stringify(hint)} field` : 'the floating search field') : 'the tab bar',
      frame: { ...b }, region: { x: 0, y: b.y - pad, width: W, height: H - (b.y - pad) } });
  }
  return out;
}
/** Where to tap an element so a floating bar doesn't take the tap: its centre, or the middle of its part above the
 *  bar when the centre is under one (`coveredBy`); nothing usable above it → `hidden` as well. */
export function uncoveredPoint(e: UiElement, c: { x: number; y: number }, bars: FloatingBar[]): { x: number; y: number; coveredBy?: string; hidden?: boolean } {
  const b = e.bounds;
  for (const bar of bars) {
    if (!within(bar.region, c)) continue;
    const f = bar.frame;
    if (b.x >= f.x && b.y >= f.y && b.x + b.width <= f.x + f.width && b.y + b.height <= f.y + f.height) return c;   // part of the bar
    const top = Math.max(0, b.y), bottom = Math.min(b.y + b.height, bar.region.y);
    if (bottom - top < 12) return { ...c, coveredBy: bar.name, hidden: true };
    return { x: c.x, y: Math.round((top + bottom) / 2), coveredBy: bar.name };
  }
  return c;
}

export function toMatch(e: UiElement, tree: UiTree, extra: { exact?: boolean; kb?: ReturnType<typeof keyboardInfo>; kbKeys?: Set<UiElement>; editableBoost?: boolean; bars?: ReturnType<typeof floatingBars> } = {}): ElementMatch {
  const p = uncoveredPoint(e, tapPoint(e), extra.bars ?? floatingBars(tree));
  const c = { x: p.x, y: p.y };
  const W = tree.screen.width, H = tree.screen.height;
  const onScreen = !(W && H) || (c.x >= 0 && c.y >= 0 && c.x < W && c.y < H);
  const underKb = !!(extra.kb?.visible && extra.kb.frame && within(extra.kb.frame, c) && !extra.kbKeys?.has(e));
  const visible = onScreen && !underKb && !p.hidden;
  const editable = isEditable(e);
  const exact = !!extra.exact;
  const score = (exact ? 4 : 0) + (e.clickable ? 2 : 0) + (visible ? 1 : 0) + (extra.editableBoost && editable ? 8 : 0);
  const m: ElementMatch = { type: e.type, bounds: e.bounds, center: c, visible, exact, score, source: tree.source };
  if (tree.source === 'accessibility') m.ref = e.ref;
  for (const k of ['text', 'label', 'id', 'value', 'placeholder', 'clickable', 'enabled', 'focused', 'checked'] as const) if (e[k] !== undefined) (m as unknown as Record<string, unknown>)[k] = e[k];
  if (editable) m.editable = true;
  if (p.coveredBy) m.coveredBy = p.coveredBy;
  return m;
}

/** Ranked matches: exact over contains, clickable over not, visible over not (then enabled, then tree order). */
export function findElements(tree: UiTree, q: FindQuery): ElementMatch[] {
  const mode: MatchMode = q.match ?? 'contains';
  const tm = q.text ? matcher(q.text, mode) : undefined;
  const im = q.id ? matcher(q.id, mode) : undefined;
  const ty = q.type ? q.type.toLowerCase() : undefined;
  const kb = keyboardInfo(tree);
  const kbKeys = new Set(kb.node ? flatten([kb.node]) : []);
  const bars = floatingBars(tree);
  const out: { m: ElementMatch; i: number }[] = [];
  flatten(tree.root).forEach((e, i) => {
    if (ty && shortType(e.type).toLowerCase() !== ty && (e.type ?? '').toLowerCase() !== ty) return;
    let exact = false;
    if (tm) {
      const fields = [e.text, e.label, e.value, e.placeholder];
      if (!fields.some((f) => tm.test(f))) return;
      exact = fields.some((f) => tm.exact(f));
    }
    if (im) {
      if (!e.id || !(im.test(e.id) || im.test(shortId(e.id)))) return;
      if (!tm) exact = im.exact(e.id) || im.exact(shortId(e.id));
    }
    if (!tm && !im && !ty) return;
    if (tm && kbKeys.has(e) && !ty) return; // never match the keyboard's own keys by text ("a", "space", …)
    out.push({ m: toMatch(e, tree, { exact, kb, kbKeys, editableBoost: q.editable, bars }), i });
  });
  out.sort((a, b) => (b.m.score - a.m.score) || ((a.m.enabled === false ? 1 : 0) - (b.m.enabled === false ? 1 : 0)) || (a.i - b.i));
  return out.map((x) => x.m);
}

/** For fill: given a matched label (non-editable), the nearest editable element below or to the right of it. */
export function nearestEditable(tree: UiTree, from: ElementMatch): ElementMatch | undefined {
  const fb = from.bounds; let best: { e: UiElement; d: number } | undefined;
  for (const e of flatten(tree.root)) {
    if (!isEditable(e)) continue;
    const b = e.bounds;
    const below = b.y >= fb.y + fb.height * 0.5 && b.y - (fb.y + fb.height) < Math.max(fb.height * 3, 300);
    const right = b.x >= fb.x + fb.width * 0.5 && Math.abs((b.y + b.height / 2) - (fb.y + fb.height / 2)) < Math.max(fb.height, b.height);
    const inside = within(b, from.center) || within(fb, center(e));
    if (!below && !right && !inside) continue;
    const d = inside ? 0 : Math.hypot(center(e).x - from.center.x, center(e).y - from.center.y);
    if (!best || d < best.d) best = { e, d };
  }
  return best ? toMatch(best.e, tree, { exact: from.exact }) : undefined;
}

/** One short line of what is on screen (for timeouts / errors). */
export function screenSummary(tree: UiTree, max = 14): string {
  const seen = new Set<string>(); const parts: string[] = [];
  const kb = keyboardInfo(tree); const kbKeys = new Set(kb.node ? flatten([kb.node]) : []);
  for (const e of flatten(tree.root)) {
    if (kbKeys.has(e)) continue;
    const t = (e.text ?? e.label ?? ((e.value && e.value !== e.text ? e.value : '') || e.placeholder) ?? '').replace(/\s+/g, ' ').trim();
    if (!t || seen.has(t) || shortType(e.type) === 'Application') continue;
    seen.add(t);
    // ids too (as get_ui prints them), so agents can pick a field by id: always for text fields, and short app ids
    // (Android's "greetButton") elsewhere; long reverse-DNS ids (iOS "com.apple.settings.general") would drown the line
    const id = e.id ? shortId(e.id) : '';
    const showId = id && id !== t && (isEditable(e) ? id.length <= 60 : id.length <= 24 && !id.includes('.'));
    parts.push(`${shortType(e.type)} ${JSON.stringify(t.length > 40 ? t.slice(0, 39) + '…' : t)}${showId ? ` id=${id}` : ''}`);
    if (parts.length >= max) break;
  }
  const total = flatten(tree.root).filter((e) => e.text || e.label).length;
  return parts.length ? `${parts.join(', ')}${total > parts.length ? ', …' : ''}${kb.visible ? ' [keyboard up]' : ''}` : '(no text on screen)';
}

// ── idle detection: tiny grayscale frames ───────────────────────────────────
export interface Thumb { data: Buffer; width: number; height: number; srcWidth: number; srcHeight: number }
/** Downscale a PNG to `width` px wide 8-bit grayscale (area averaging) via ffmpeg. */
export async function grayThumb(png: Buffer, width = 64): Promise<Thumb> {
  const src = pngSize(png);
  if (!src) throw new PhoneDockError('The screenshot is not a valid PNG image', 'bad_image', 500, undefined, 'Backend returned a non-PNG screenshot');
  const ff = which('ffmpeg');
  if (!ff) throw new PhoneDockError("Screen change detection is unavailable", 'not_supported', 501, ["Install ffmpeg."], ['ffmpeg is required for until="idle"', ...['brew install ffmpeg']].filter(Boolean).join('\n'));
  const w = Math.max(8, Math.min(width, src.width));
  const h = Math.max(8, Math.round((src.height * w) / src.width));
  const r = await runBuffer(ff, ['-loglevel', 'error', '-f', 'png_pipe', '-i', '-', '-vf', `scale=${w}:${h}:flags=area,format=gray`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { input: png, timeoutMs: 20_000 });
  if (r.stdout.length < w * h) throw new PhoneDockError("Couldn’t process the screenshot", 'bad_image', 500, undefined, `ffmpeg produced ${r.stdout.length} bytes, expected ${w * h}`);
  return { data: r.stdout.subarray(0, w * h), width: w, height: h, srcWidth: src.width, srcHeight: src.height };
}
/** Cells that differ by ≥ pixThreshold; `changed` is false for tiny blinks (text caret, clock tick). */
export function diffThumbs(a: Thumb, b: Thumb, pixThreshold = 16): { cells: number; changed: boolean; region?: UiElement['bounds'] } {
  if (a.width !== b.width || a.height !== b.height) return { cells: a.width * a.height, changed: true, region: { x: 0, y: 0, width: b.srcWidth, height: b.srcHeight } };
  let n = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let i = 0; i < a.data.length; i++) {
    if (Math.abs(a.data[i] - b.data[i]) < pixThreshold) continue;
    n++; const x = i % a.width, y = (i / a.width) | 0;
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  const changed = n > Math.max(4, a.data.length * 0.0005);
  if (!n) return { cells: 0, changed };
  const sx = b.srcWidth / b.width, sy = b.srcHeight / b.height;
  return { cells: n, changed, region: { x: Math.floor(x0 * sx), y: Math.floor(y0 * sy), width: Math.ceil((x1 - x0 + 1) * sx), height: Math.ceil((y1 - y0 + 1) * sy) } };
}
export function unionBounds(a: UiElement['bounds'] | undefined, b: UiElement['bounds'] | undefined): UiElement['bounds'] | undefined {
  if (!a) return b; if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

// ── crash reports ───────────────────────────────────────────────────────────
/** Keep long crash reports readable: the header plus the crashed/faulting thread (Apple text + .ips JSON,
 *  Android FATAL EXCEPTION / tombstones / ANR). Returns the input unchanged when it fits. */
export function truncateCrash(text: string, maxChars = 16_000): { text: string; truncated: boolean; length: number } {
  const length = text.length;
  if (length <= maxChars) return { text, truncated: false, length };
  const ips = summarizeIps(text);
  if (ips && ips.length <= maxChars) return { text: ips, truncated: true, length };
  const lines = text.split('\n');
  const headN = Math.min(lines.length, 60);
  const isCrashStart = (l: string) => /^Thread \d+( name:.*)? Crashed|^\s*Crashed Thread|FATAL EXCEPTION|^backtrace:|^\s*"main" prio=|^Caused by:|"triggered"\s*:\s*true|^Last Exception Backtrace/.test(l);
  let start = lines.findIndex((l, i) => i >= headN && isCrashStart(l));
  if (start < 0) start = lines.findIndex((l) => isCrashStart(l));
  const parts: string[] = [lines.slice(0, headN).join('\n')];
  if (start >= headN) {
    let end = start + 1;
    while (end < lines.length && end - start < 120 && !(lines[end].trim() === '' && /^(Thread \d+|Binary Images|---)/.test(lines[end + 1] ?? ''))) end++;
    parts.push(`… [${start - headN} lines omitted] …`, lines.slice(start, end).join('\n'));
    const causes = lines.slice(end).filter((l) => /^Caused by:/.test(l)).slice(0, 5);
    if (causes.length) parts.push(causes.join('\n'));
    if (end < lines.length) parts.push(`… [${lines.length - end} more lines; pass full=1 for everything] …`);
  } else parts.push(`… [${lines.length - headN} more lines; pass full=1 for everything] …`);
  let out = parts.join('\n');
  if (out.length > maxChars) out = out.slice(0, maxChars) + '\n… [cut] …';
  return { text: out, truncated: true, length };
}
/** Apple .ips (two JSON documents: a one-line header + the body) → classic-looking summary with the faulting thread. */
function summarizeIps(text: string): string | undefined {
  const nl = text.indexOf('\n');
  if (nl < 0 || text[0] !== '{') return undefined;
  let head: Record<string, unknown>, body: Record<string, any>;
  try { head = JSON.parse(text.slice(0, nl)); body = JSON.parse(text.slice(nl + 1)); } catch { return undefined; }
  if (!Array.isArray(body.threads)) return undefined;
  const images: { name?: string }[] = Array.isArray(body.usedImages) ? body.usedImages : [];
  const ex = body.exception ?? {};
  const lines = [
    `Process: ${body.procName ?? head.app_name ?? '?'} [${body.pid ?? '?'}]  Bundle: ${body.bundleInfo?.CFBundleIdentifier ?? head.bundleID ?? '?'} ${head.app_version ?? ''}`,
    `OS: ${head.os_version ?? body.osVersion?.train ?? '?'}  Time: ${body.captureTime ?? head.timestamp ?? '?'}  Incident: ${head.incident_id ?? body.incident ?? '?'}`,
    `Exception: ${ex.type ?? '?'} (${ex.signal ?? ''}${ex.codes ? ` ${ex.codes}` : ''})${ex.subtype ? ` – ${ex.subtype}` : ''}`,
  ];
  if (body.termination) lines.push(`Termination: ${body.termination.namespace ?? ''} ${body.termination.code ?? ''} ${body.termination.indicator ?? ''}`.trim());
  if (body.asi) lines.push(`Application Specific Information: ${JSON.stringify(body.asi).slice(0, 1500)}`);
  const frames = (fs: any[]) => fs.slice(0, 60).map((f, i) => `${String(i).padEnd(3)} ${(images[f.imageIndex]?.name ?? '???').padEnd(28)} ${f.symbol ?? `0x${(f.imageOffset ?? 0).toString(16)}`}${f.symbolLocation !== undefined ? ` + ${f.symbolLocation}` : ''}${f.sourceFile ? ` (${f.sourceFile}:${f.sourceLine ?? ''})` : ''}`);
  if (Array.isArray(body.lastExceptionBacktrace) && body.lastExceptionBacktrace.length) lines.push('', 'Last Exception Backtrace:', ...frames(body.lastExceptionBacktrace));
  const idx = typeof body.faultingThread === 'number' ? body.faultingThread : body.threads.findIndex((t: any) => t.triggered);
  const t = body.threads[idx];
  if (t) lines.push('', `Thread ${idx} Crashed${t.name ? ` (${t.name})` : ''}${t.queue ? ` queue=${t.queue}` : ''}:`, ...frames(t.frames ?? []));
  lines.push('', `… [${body.threads.length} threads, ${images.length} images omitted; pass full=1 for the raw .ips] …`);
  return lines.join('\n');
}

// ── Activity: a point on the screen in human terms ──────────────────────────
/** The label of the smallest labelled element under the point, or undefined. */
export function labelAt(tree: UiTree, x: number, y: number): string | undefined {
  let best: { area: number; label: string } | undefined;
  for (const e of flatten(tree.root)) {
    const b = e.bounds;
    if (x < b.x || y < b.y || x > b.x + b.width || y > b.y + b.height) continue;
    const label = [e.text, e.label, e.value].find((t) => typeof t === 'string' && t.trim() && t.length <= 60)?.trim();
    if (!label) continue;
    const area = b.width * b.height;
    if (!best || area < best.area) best = { area, label };
  }
  return best?.label;
}
/** "near the top right", "near the bottom", "in the middle", … for a point on a screen of the given size. */
export function coarseWhere(x: number, y: number, width: number, height: number): string | undefined {
  if (!(width > 0 && height > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  const col = x < width / 3 ? 'left' : x > (2 * width) / 3 ? 'right' : '';
  const row = y < height / 3 ? 'top' : y > (2 * height) / 3 ? 'bottom' : '';
  if (!col && !row) return 'in the middle';
  return `near the ${[row, col].filter(Boolean).join(' ')}`;
}
