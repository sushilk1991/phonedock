// Tap by ref, checked against the screen. A ref names an element of the tree the client last read, and the screen
// may have changed since: a keyboard closed and the layout shifted, a list scrolled, a row was inserted. Its old
// coordinates then hold something else (an agent's tap on Instagram's comment "Post" button by ref liked another
// person's comment, whose heart had moved under that point). So before a ref is tapped the screen is read again and
// the same element is found anew; when that can't be done safely, nothing is tapped (stale_ref). A wrong tap is far
// worse than a refused one. Used by POST /input (`tap {ref}`) and POST /fill (`ref`).
import { PhoneDockError, type ScreenInfo, type UiElement, type UiTree } from '../core/types.ts';
import { lastActionAt, uiCache } from './core.ts';
import { ocrTree, recentTree, type Dev } from './find.ts';
import { findRef, flatten, floatingBars, isEditable, shortId, shortType, tapPoint, uncoveredPoint } from './media.ts';

/** A tree captured this recently, with no input since, shows the screen as it is: no new read. */
export const TRUST_MS = 300;
/** No way to read the screen again (the read failed, or OCR is unavailable): a ref from a tree this young is still
 *  tapped, unchecked; an older one is refused. */
export const UNCHECKED_MS = 1500;
/** Ancestors searched for the words that tell look-alike elements apart (the comment a Like heart belongs to). */
const MAX_LEVELS = 8;

type Pt = { x: number; y: number };
/** How the ref was checked: `recent` the tree it came from is under TRUST_MS old with no input since; `joined` a read
 *  in flight was used; `read` a new accessibility read; `ocr` a new OCR read (refs from an OCR tree, or OCR lines merged
 *  into a partial tree); `unchecked` the screen couldn't be read again and the tree was under UNCHECKED_MS old. */
export type RefCheckVia = 'recent' | 'joined' | 'read' | 'ocr' | 'unchecked';
export interface RefTarget {
  /** The element as found now, and the tree it was found in (the client's own tree for `recent` / `unchecked`). */
  el: UiElement; tree: UiTree;
  /** Where to tap it, above a floating bar that covers its centre (see uncoveredPoint). */
  x: number; y: number; coveredBy?: string; hidden?: boolean;
  /** It was found somewhere else than where the client's tree had it: the point that tree gave, and the one tapped. */
  moved?: { from: Pt; to: Pt };
  check: { via: RefCheckVia; ms: number };
}

/** How far an element may be from where it was and still count as not moved: 2% of the screen's shorter side, at
 *  least 8 px. */
export function tolerance(screen?: ScreenInfo): number {
  return Math.max(8, Math.round(0.02 * Math.min(screen?.width || 0, screen?.height || 0)));
}

const clean = (s?: string) => (s ?? '').replace(/\s+/g, ' ').trim();
/** What makes an element the same one in another read of the screen: its type, text, label and id; for a text field
 *  its placeholder instead of its text (the text is what was typed, and typing changes it); a switch's on/off state.
 *  OCR lines have no type, id or label of their own: their text, case aside. */
export function identity(e: UiElement, ocr = false): string {
  if (ocr) return clean(e.text ?? e.label).toLowerCase();
  const ed = isEditable(e);
  return JSON.stringify([e.type, ed ? '' : clean(e.text), clean(e.label), e.id ?? '', ed ? clean(e.placeholder) : '', e.checked ?? null]);
}
/** Only a type to go by (an unlabelled icon): its size has to match as well. */
const weak = (e: UiElement) => !(clean(e.text) && !isEditable(e)) && !clean(e.label) && !e.id && !clean(e.placeholder);

/** The words an element shows that don't change as it is used: texts and labels, a text field's label and
 *  placeholder. OCR lines merged into a partial tree are left out: a new accessibility read doesn't have them. */
function ownWords(e: UiElement): string[] {
  if (e.ocr) return [];
  return (isEditable(e) ? [e.label, e.placeholder] : [e.text, e.label]).map(clean).filter(Boolean);
}
/** words(e, level): the words in the subtree of e's level-th ancestor (0: e itself), sorted; undefined when e has no
 *  ancestor that high. */
function wordsIn(tree: UiTree): (e: UiElement, level: number) => string | undefined {
  const parent = new Map<UiElement, UiElement>();
  const walk = (els: UiElement[], p?: UiElement) => { for (const e of els) { if (p) parent.set(e, p); if (e.children) walk(e.children, e); } };
  walk(tree.root);
  const memo = new Map<UiElement, string>();
  const of = (a: UiElement) => {
    let w = memo.get(a);
    if (w === undefined) {
      const s = new Set<string>();
      for (const x of flatten([a])) for (const t of ownWords(x)) s.add(t);
      w = [...s].sort().join('\n'); memo.set(a, w);
    }
    return w;
  };
  return (e, level) => {
    let a: UiElement | undefined = e;
    for (let i = 0; i < level && a; i++) a = parent.get(a);
    return a ? of(a) : undefined;
  };
}

/** The words on the same line as an element: of the elements (not taller than a quarter of the screen) that span its
 *  centre's height. For trees without rows to go by: an iPhone without WDA reports one flat list. */
function bandWords(tree: UiTree, e: UiElement): string {
  const cy = e.bounds.y + e.bounds.height / 2; const maxH = (tree.screen.height || Infinity) / 4;
  const s = new Set<string>();
  for (const x of flatten(tree.root)) {
    if (x === e || x.bounds.height > maxH || cy < x.bounds.y || cy >= x.bounds.y + x.bounds.height) continue;
    for (const t of ownWords(x)) s.add(t);
  }
  return [...s].sort().join('\n');
}

const at = (p: Pt) => `@(${p.x},${p.y})`;
/** `Button "Post" id=post_button`, for messages. */
export function what(e: UiElement): string {
  const t = clean(isEditable(e) ? e.label || e.placeholder : e.text || e.label);   // never a field's text: it may be secret
  return `${shortType(e.type) || 'element'}${t ? ` ${JSON.stringify(t.length > 60 ? t.slice(0, 59) + '…' : t)}` : ''}${e.id ? ` id=${shortId(e.id)}` : ''}`;
}
/** What a tap at p would hit in a tree: the smallest element there that shows words, else the smallest tappable one. */
function hitAt(tree: UiTree, p: Pt): UiElement | undefined {
  let best: { e: UiElement; area: number; rank: number } | undefined;
  for (const e of flatten(tree.root)) {
    const b = e.bounds;
    if (p.x < b.x || p.y < b.y || p.x >= b.x + b.width || p.y >= b.y + b.height) continue;
    const rank = ownWords(e).length ? 2 : e.clickable ? 1 : 0;
    if (!rank) continue;
    const area = b.width * b.height;
    if (!best || rank > best.rank || (rank === best.rank && area < best.area)) best = { e, area, rank };
  }
  return best?.e;
}
const ago = (t: UiTree) => { const ms = Date.now() - Date.parse(t.capturedAt); return Number.isFinite(ms) ? `${(Math.max(0, ms) / 1000).toFixed(1)} s ago` : 'earlier'; };

/** An OCR read of another size than the tree it is compared with (same aspect ratio): its bounds in that tree's pixels. */
function toScreen(t: UiTree, s: ScreenInfo): UiTree {
  const W = t.screen.width, H = t.screen.height;
  if (!W || !H || !s.width || !s.height || (W === s.width && H === s.height) || Math.abs(W / H - s.width / s.height) > 0.02) return t;
  const sx = s.width / W, sy = s.height / H;
  const map = (els: UiElement[]): UiElement[] => els.map((e) => ({ ...e, bounds: { x: Math.round(e.bounds.x * sx), y: Math.round(e.bounds.y * sy), width: Math.round(e.bounds.width * sx), height: Math.round(e.bounds.height * sy) }, ...(e.children ? { children: map(e.children) } : {}) }));
  return { ...t, screen: { ...t.screen, width: s.width, height: s.height }, root: map(t.root) };
}

export type Relocated = ({ ok: true; el: UiElement; moved?: { from: Pt; to: Pt } } & ReturnType<typeof uncoveredPoint>) | { ok: false; detail: string };
/** Find `el` (an element of `old`, the tree the client read) in `fresh`, a new read of the screen. Pure.
 *  Candidates: elements of `fresh` with the same identity (an unlabelled one also of about the same size). When
 *  several elements look alike (in either tree), only those among the same words as `el` stay candidates: the words
 *  of its nearest ancestor that tell it apart (its row), else (a flat tree) the words on its line. Then: a candidate within `tolerance` of the old tap point is
 *  tapped there (not moved); else exactly one candidate is tapped where it is now (`moved`, if that point is on
 *  screen); else nothing is (`ok: false`, with what changed). */
export function relocateRef(old: UiTree, el: UiElement, freshTree: UiTree): Relocated {
  const ocr = old.source === 'ocr' || !!el.ocr;
  const fresh = ocr ? toScreen(freshTree, old.screen) : freshTree;
  const key = identity(el, ocr);
  const tol = tolerance(fresh.screen?.width ? fresh.screen : old.screen);
  const sameSize = (c: UiElement) => Math.abs(c.bounds.width - el.bounds.width) <= Math.max(tol, el.bounds.width * 0.25)
    && Math.abs(c.bounds.height - el.bounds.height) <= Math.max(tol, el.bounds.height * 0.25);
  const alike = flatten(fresh.root).filter((e) => identity(e, ocr) === key && (ocr || !weak(el) || sameSize(e)));
  let cands = alike;
  let context: string | undefined;
  const dups = flatten(old.root).filter((e) => e !== el && identity(e, ocr) === key);
  if (!ocr && (dups.length || cands.length > 1)) {
    // the nearest level whose words single `el` out among its look-alikes in the old tree and leave at most one
    // candidate in the new one; none (a grid of identical photos), or OCR lines (no tree around them): position decides
    const ow = wordsIn(old), fw = wordsIn(fresh);
    for (let level = 0; level <= MAX_LEVELS; level++) {
      const w = ow(el, level);
      if (w === undefined) break;
      if (!w || dups.some((o) => ow(o, level) === w)) continue;
      const same = cands.filter((c) => fw(c, level) === w);
      if (same.length <= 1) { cands = same; context = w; break; }
    }
    // no ancestor tells it apart (a flat tree): the words on its line
    const w = context === undefined ? bandWords(old, el) : '';
    if (w && !dups.some((o) => bandWords(old, o) === w)) {
      const same = cands.filter((c) => bandWords(fresh, c) === w);
      if (same.length <= 1) { cands = same; context = w; }
    }
  }
  const p0 = tapPoint(el);
  const from = uncoveredPoint(el, p0, floatingBars(old));
  const dist = (c: UiElement) => { const p = tapPoint(c); return Math.hypot(p.x - p0.x, p.y - p0.y); };
  const near = cands.filter((c) => dist(c) <= tol).sort((a, b) => dist(a) - dist(b));
  const pick = near[0] ?? (cands.length === 1 ? cands[0] : undefined);
  const head = `${what(el)} was ${at(from)} in the screen read ${ago(old)}`;
  const hit = hitAt(fresh, from);
  const there = hit ? `A tap at ${at(from)} would now hit ${what(hit)}.` : `Nothing tappable is at ${at(from)} now.`;
  if (!pick) {
    if (!alike.length) return { ok: false, detail: `${head}; it is not on screen now. ${there}` };
    if (context !== undefined) {
      const words = context.split('\n').slice(0, 3).map((s) => JSON.stringify(s.length > 40 ? s.slice(0, 39) + '…' : s)).join(', ');
      return { ok: false, detail: `${head}, next to ${words}; ${alike.length === 1 ? 'one element like it is on screen now' : `${alike.length} elements like it are on screen now`}, but not next to those words. ${there}` };
    }
    return { ok: false, detail: `${head}; ${cands.length} elements like it are on screen now, none there: ${cands.slice(0, 5).map((c) => at(tapPoint(c))).join(', ')}${cands.length > 5 ? ', …' : ''}. ${there}` };
  }
  const p = uncoveredPoint(pick, tapPoint(pick), floatingBars(fresh.source === 'accessibility' ? fresh : old));
  if (near.length) return { ok: true, el: pick, ...p };
  const W = fresh.screen?.width, H = fresh.screen?.height;
  if (W && H && !(p.x >= 0 && p.y >= 0 && p.x < W && p.y < H)) return { ok: false, detail: `${head}; it has moved to ${at(p)}, off the screen. ${there}` };
  return { ok: true, el: pick, ...p, moved: { from: { x: from.x, y: from.y }, to: { x: p.x, y: p.y } } };
}

export function staleRef(detail: string): PhoneDockError {
  return new PhoneDockError("The screen changed since it was read, so PhoneDock didn't tap: read the screen again", 'stale_ref', 409,
    ['Read the screen again and use a ref from that read, or tap the element by its text.'], detail);
}

/** The element `ref` names in the tree the client last read, found again on the screen as it is now (see relocateRef).
 *  Throws stale_ref, having tapped nothing, when there is no such tree or ref, or the element can't be told apart. */
export async function resolveRef(d: Dev, ref: string): Promise<RefTarget> {
  const tree = uiCache.get(d.id);
  if (!tree) throw new PhoneDockError("The screen information is out of date", 'stale_ref', 409, ["Refresh the screen information and try again."], `No UI tree cached for ${d.id}: read the UI first, then tap by ref`);
  const el = findRef(tree, ref);
  if (!el) throw new PhoneDockError("The screen reference is out of date", 'stale_ref', 409, ["Refresh the screen information and try again."], `Unknown ref ${ref}: refs are only valid until the next UI read; read the UI again`);
  return check(d, tree, el, lastActionAt.get(d.id) ?? 0, true);
}
/** After something changed the screen on purpose before the tap (the keyboard was hidden): find the element again in
 *  a read started at or after `since`. Never unchecked. `moved` runs from the client's point to the final one. */
export async function recheckRef(d: Dev, t: RefTarget, since: number): Promise<RefTarget> {
  const r = await check(d, t.tree, t.el, since, false);
  const from = t.moved?.from ?? { x: t.x, y: t.y };
  const moved = r.moved || t.moved ? { from, to: { x: r.x, y: r.y } } : undefined;
  return { ...r, ...(moved ? { moved } : {}), check: { via: r.check.via, ms: t.check.ms + r.check.ms } };
}

async function check(d: Dev, tree: UiTree, el: UiElement, since: number, first: boolean): Promise<RefTarget> {
  const t0 = Date.now();
  const capturedAt = Date.parse(tree.capturedAt);
  const asRead = (via: RefCheckVia): RefTarget => ({ el, tree, ...uncoveredPoint(el, tapPoint(el), floatingBars(tree)), check: { via, ms: Date.now() - t0 } });
  if (first && capturedAt >= since && t0 - capturedAt < TRUST_MS) return asRead('recent');
  const ocr = tree.source === 'ocr' || !!el.ocr;
  let fresh: UiTree | undefined; let via: RefCheckVia = 'read'; let err: unknown;
  try {
    if (ocr) { fresh = await ocrTree(d.b, d.nid); via = 'ocr'; }
    else { const r = await recentTree(d, since, first ? TRUST_MS : 0); if (r) { fresh = r.tree; via = r.via; } }
  } catch (e) { err = e; }
  if (!fresh) {
    if (first && Date.now() - capturedAt < UNCHECKED_MS) return asRead('unchecked');
    const why = err ? ((err as PhoneDockError).detail ?? (err as Error).message ?? String(err)).split('\n')[0] : 'this device has no accessibility tree';
    throw staleRef(`${what(el)} is from the screen read ${ago(tree)}, and the screen couldn't be read again to check it is still there (${why}).`);
  }
  if (ocr) fresh = toScreen(fresh, tree.screen);   // in the pixels of the tree the ref came from, as relocateRef sees it
  const r = relocateRef(tree, el, fresh);
  if (!r.ok) throw staleRef(r.detail);
  const { ok: _ok, ...hit } = r;
  return { ...hit, tree: fresh, check: { via, ms: Date.now() - t0 } };
}
