// Scroll decisions shared by POST /scroll-to and POST /swipe (pure: trees in, decisions out; see scroll.test.ts).
// - Is there anything to scroll? Only trees that report scrollability reliably (Android accessibility nodes) can
//   say "no"; iOS marks containers by type and OCR has no structure, so those answer "unknown".
// - Where to swipe: inside the scroll container, never on the keyboard and away from the status / nav bars.
// - Did the content move? Compare the container's content (texts and their positions), not screen pixels.
import type { Bounds, UiElement, UiTree } from '../core/types.ts';
import { flatten, isEditable } from './media.ts';

export type LookDir = 'up' | 'down' | 'left' | 'right';            // where to look (scroll-to "direction")
export interface Swipe { x1: number; y1: number; x2: number; y2: number; durationMs: number }

const area = (b: Bounds) => Math.max(0, b.width) * Math.max(0, b.height);
const inside = (b: Bounds, x: number, y: number) => x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height;
function clip(b: Bounds, W: number, H: number): Bounds {
  const x = Math.max(0, b.x), y = Math.max(0, b.y);
  return { x, y, width: Math.max(0, Math.min(W, b.x + b.width) - x), height: Math.max(0, Math.min(H, b.y + b.height) - y) };
}
const HORIZONTAL = /Horizontal|Pager|Carousel|TabLayout/i;
const WEB = /WebView|Web View/i;

/** Visible scrollable elements, largest first. */
export function scrollables(tree: UiTree): UiElement[] {
  const W = tree.screen.width || Infinity, H = tree.screen.height || Infinity;
  return flatten(tree.root).filter((e) => e.scrollable && area(clip(e.bounds, W, H)) > 0)
    .sort((a, b) => area(clip(b.bounds, W, H)) - area(clip(a.bounds, W, H)));
}

/** true: something scrolls; false: nothing on this screen scrolls; null: can't tell (no tree, OCR, iOS, web content). */
export function canScroll(tree: UiTree | undefined, platform: string): boolean | null {
  if (!tree || tree.source !== 'accessibility' || !tree.root.length) return null;
  if (scrollables(tree).length) return true;
  if (platform !== 'android') return null;                    // iOS: scrollability is guessed from element types
  if (flatten(tree.root).some((e) => WEB.test(e.type ?? ''))) return null;   // web content scrolls without flags
  return false;
}

/** The container to swipe in: the smallest one under `point`, else the largest that scrolls along the axis. */
export function pickContainer(tree: UiTree, vertical: boolean, point?: { x: number; y: number }): UiElement | undefined {
  const all = scrollables(tree);
  if (point) {
    const under = all.filter((e) => inside(e.bounds, point.x, point.y)).sort((a, b) => area(a.bounds) - area(b.bounds));
    return under[0];
  }
  const axis = all.filter((e) => (HORIZONTAL.test(e.type ?? '') ? !vertical : vertical));
  // never a SystemUI container (quick settings, notification stack) while an app's own container is there
  const own = (l: UiElement[]) => l.find((e) => !SYSTEMUI.test(e.id ?? '')) ?? l[0];
  return own(axis) ?? own(all);
}
const SYSTEMUI = /^com\.android\.systemui:id\//;

/** A swipe that reveals content in `look` direction (finger moves the other way), `distance` × the usable length,
 *  inside `container` (default: the whole screen), within the 8–92 % band of the screen, above `bottomLimit`
 *  (the keyboard's top, if one is up), and through `point` when given. */
export function swipeFor(W: number, H: number, look: LookDir, opts: { container?: Bounds; distance?: number; durationMs?: number; point?: { x: number; y: number }; bottomLimit?: number } = {}): Swipe {
  const vertical = look === 'up' || look === 'down';
  const distance = opts.distance ?? 0.6; const durationMs = opts.durationMs ?? 600;
  const box = clip(opts.container ?? { x: 0, y: 0, width: W, height: H }, W, H);
    // usable band: the container shrunk by 10 % of its length on each end, inside the screen's safe band
  const lo = vertical ? Math.max(box.y + box.height * 0.1, H * 0.08) : Math.max(box.x + box.width * 0.1, W * 0.06);
  let hi = vertical ? Math.min(box.y + box.height * 0.9, H * 0.92) : Math.min(box.x + box.width * 0.9, W * 0.94);
  if (vertical && opts.bottomLimit !== undefined) hi = Math.min(hi, opts.bottomLimit - H * 0.02);
  if (hi <= lo) hi = lo + 1;
  const len = vertical ? box.height : box.width;
  const half = Math.min((len * Math.min(1, Math.max(0.05, distance))) / 2, (hi - lo) / 2);
  const mid = vertical ? (opts.point ? clampTo(opts.point.y, lo + half, hi - half) : (lo + hi) / 2) : (opts.point ? clampTo(opts.point.x, lo + half, hi - half) : (lo + hi) / 2);
  const cross = vertical
    ? (opts.point ? opts.point.x : box.x + box.width / 2)
    : (opts.point ? opts.point.y : Math.min(box.y + box.height / 2, opts.bottomLimit !== undefined ? opts.bottomLimit - H * 0.05 : Infinity));
  // reveal what is below/right = finger moves up/left
  const [a, b] = look === 'down' || look === 'right' ? [mid + half, mid - half] : [mid - half, mid + half];
  const r = Math.round;
  return vertical ? { x1: r(cross), y1: r(a), x2: r(cross), y2: r(b), durationMs } : { x1: r(a), y1: r(cross), x2: r(b), y2: r(cross), durationMs };
}
function clampTo(v: number, lo: number, hi: number) { return lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)); }

/** Finger direction (swipe "up" = content moves up = reveal what is below) → where it looks. */
export function lookFromFinger(finger: LookDir): LookDir {
  return finger === 'up' ? 'down' : finger === 'down' ? 'up' : finger === 'left' ? 'right' : 'left';
}

/** What the container shows: each element inside it (centre within its bounds) with its text and position. Editable
 *  fields count by position only, so text typed into a field never looks like scrolling. Empty → '' (no structure:
 *  the caller falls back to comparing pixels). */
export function contentSignature(tree: UiTree, container?: Bounds): string {
  const parts: string[] = [];
  for (const e of flatten(tree.root)) {
    const cx = e.bounds.x + e.bounds.width / 2, cy = e.bounds.y + e.bounds.height / 2;
    if (container && (!inside(container, cx, cy) || (e.bounds.x === container.x && e.bounds.y === container.y && e.bounds.width === container.width && e.bounds.height === container.height))) continue;
    const t = isEditable(e) ? `[${e.type}${e.id ? '#' + e.id : ''}]` : (e.text ?? e.label ?? '') || (e.id ? `#${e.id}` : '');
    if (!t) continue;
    parts.push(`${t}@${Math.round(e.bounds.x)},${Math.round(e.bounds.y)}`);
  }
  return parts.join('|');
}

/** One row of what a list shows: its text and where it is. */
export interface ContentItem { t: string; x: number; y: number }
const SCROLL_BAR = /scroll bar/i;
/** iOS: the rows a list shows (text and position, in tree order), without the chrome that changes or floats on its
 *  own: the status bar (its clock ticks), scroll indicators ("Vertical scroll bar, 2 pages": the value follows the
 *  scrolling, and they come and go), and a search field floating at the bottom of the screen (iOS 26 Settings) with
 *  what sits on it. Editable fields count by position only. */
export function contentItems(tree: UiTree, container?: Bounds): ContentItem[] {
  const H = tree.screen.height || Infinity;
  const all = flatten(tree.root);
  const floating = all.filter((e) => isEditable(e) && e.bounds.y + e.bounds.height / 2 > H * 0.8).map((e) => e.bounds);
  const out: ContentItem[] = [];
  for (const e of all) {
    const cx = e.bounds.x + e.bounds.width / 2, cy = e.bounds.y + e.bounds.height / 2;
    if (container && (!inside(container, cx, cy) || (e.bounds.x === container.x && e.bounds.y === container.y && e.bounds.width === container.width && e.bounds.height === container.height))) continue;
    if (cy < H * 0.06 || /StatusBar|^Application$|^Window$/i.test(e.type ?? '')) continue;
    if (SCROLL_BAR.test(e.label ?? '') || SCROLL_BAR.test(e.text ?? '')) continue;
    if (floating.some((b) => inside(b, cx, cy))) continue;
    const t = isEditable(e) ? `[${e.type}${e.id ? '#' + e.id : ''}]` : (e.text ?? e.label ?? '') || (e.id ? `#${e.id}` : '');
    if (!t) continue;
    out.push({ t, x: Math.round(e.bounds.x), y: Math.round(e.bounds.y) });
  }
  return out;
}
/** Did a swipe move the list? Yes when other rows show; with the same rows, only when they moved together by more
 *  than a rubber-band bounce (a swipe at the end of an iOS list bounces back, and the tree may be read mid-bounce).
 *  `length`: the container's length along the scroll axis. */
export function contentMoved(before: ContentItem[], after: ContentItem[], length: number, vertical = true): boolean {
  if (before.length !== after.length || before.some((b, i) => b.t !== after[i].t)) return true;
  if (!before.length) return false;
  const d = before.map((b, i) => Math.abs(vertical ? after[i].y - b.y : after[i].x - b.x)).sort((p, q) => p - q);
  return d[Math.floor(d.length / 2)] > length * 0.12;
}
