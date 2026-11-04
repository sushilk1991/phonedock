// Which Android window a UI read describes, and what lies over it (pure: helper XML in, decisions out; see
// android-windows.test.ts).
//
// The helper lists every window of the display as <pd-window/> (UiAutomation.getWindows(), top layer first) and
// dumps the roots of the focused window, the active window and the top application window. "Active" is not "the
// screen the user is using": SystemUI's notification shade window (NotificationShade) becomes active while it shows a
// heads-up notification or a status bar touch, and its tree is the whole shade: notification stack and the collapsed
// quick settings (expanded_qs_scroll_view, tiles), all marked visible, spanning the screen. Describing that window
// put the quick settings' ScrollView in the tree of an app screen, and swipe / scroll_to scrolled it.
//
// The rule: describe the window with input focus (an app, a system dialog that has focus, the pulled-down shade);
// else the active one under the same rule; else the top application window. Everything else that is on screen
// (keyboard, heads-up, unfocused system windows) is reported as an overlay, never described. The status and
// navigation bars are left out.
import type { Bounds, UiWindow, UiWindowRole } from '../core/types.ts';

export interface HelperWindow {
  id: number;
  type: 'app' | 'ime' | 'system' | 'a11y' | 'divider' | 'other';
  layer: number;
  focused: boolean;
  active: boolean;
  pip: boolean;
  /** SystemUI's notification shade (it has the notification stack or the quick settings). */
  shade: boolean;
  bounds: Bounds;
  pkg?: string;
  title?: string;
  /** Index of this window's root among the dumped roots (top-level <node>s), if it was dumped. */
  root?: number;
  texts: string[];
}

function decode(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    if (e === 'amp') return '&'; if (e === 'lt') return '<'; if (e === 'gt') return '>';
    if (e === 'quot') return '"'; if (e === 'apos') return "'";
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : '';
  });
}
function bounds(b?: string): Bounds {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(b ?? '');
  if (!m) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: +m[1], y: +m[2], width: Math.max(0, +m[3] - +m[1]), height: Math.max(0, +m[4] - +m[2]) };
}
const TYPES = new Set(['app', 'ime', 'system', 'a11y', 'divider', 'other']);

/** The helper's window list, or undefined when the dump has none (plain `uiautomator dump`, or getWindows() failed:
 *  then the dump is one root, the active window's). */
export function parseHelperWindows(xml: string): HelperWindow[] | undefined {
  const i = xml.lastIndexOf('<pd-windows>');
  if (i < 0) return undefined;
  const out: HelperWindow[] = [];
  for (const m of xml.slice(i).matchAll(/<pd-window\b([^>]*)>([\s\S]*?)<\/pd-window>/g)) {
    const a: Record<string, string> = {};
    for (const p of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) a[p[1]] = decode(p[2]);
    const texts = [...m[2].matchAll(/<t>([\s\S]*?)<\/t>/g)].map((t) => decode(t[1]).trim())
      .filter((t) => /[\p{L}\p{N}]/u.test(t));   // "•", "·": separators, not words
    out.push({
      id: Number(a.id), type: (TYPES.has(a.type) ? a.type : 'other') as HelperWindow['type'], layer: Number(a.layer) || 0,
      focused: a.focused === '1', active: a.active === '1', pip: a.pip === '1', shade: a.shade === '1',
      bounds: bounds(a.bounds), ...(a.pkg ? { pkg: a.pkg } : {}), ...(a.title ? { title: a.title } : {}),
      ...(a.root !== undefined && a.root !== '' ? { root: Number(a.root) } : {}), texts,
    });
  }
  return out;
}

const BAR_TITLE = /status ?bar|navigation ?bar|taskbar|^NavigationBar|^StatusBar/i;
const SHADE_TITLE = /NotificationShade|notification shade/i;

/** What a window is to the person holding the phone; 'bar' = status / navigation bar (not reported); undefined =
 *  not a window anyone looks at (accessibility overlays, split-screen divider). */
export function windowRole(w: HelperWindow, screen: { width: number; height: number }): UiWindowRole | 'bar' | undefined {
  if (w.type === 'ime') return 'keyboard';
  if (w.type === 'app') return w.pip ? 'pip' : 'app';
  if (w.type !== 'system') return undefined;
  const W = screen.width || 1, H = screen.height || 1, b = w.bounds;
  const shade = w.shade || (!!w.title && SHADE_TITLE.test(w.title));
  if (shade) {
    // the pulled-down shade has focus and covers the screen; a heads-up is a card at the top, not focused
    return w.focused || b.width * b.height >= 0.5 * W * H ? 'notifications' : 'heads_up';
  }
  if (w.title && BAR_TITLE.test(w.title)) return 'bar';
  const edge = (b.y <= 0 || b.y + b.height >= H) && b.height <= 0.08 * H && b.width >= 0.5 * W
    || (b.x <= 0 || b.x + b.width >= W) && b.width <= 0.08 * W && b.height >= 0.5 * H;
  if (edge && !w.focused) return 'bar';
  return w.focused ? 'dialog' : 'system';
}

/** Roles a window can have and still be "the screen the user is using". */
const DESCRIBABLE = new Set<UiWindowRole>(['app', 'dialog', 'notifications']);

export interface WindowChoice {
  /** Index of the dumped root to describe. */
  root: number;
  /** The windows on screen, top first, bars left out; the described one has `described: true`. */
  windows: UiWindow[];
}

/** Pick the root to describe and build the overlay list. undefined: no usable window list (keep every root). */
export function chooseWindow(wins: HelperWindow[], rootCount: number, screen: { width: number; height: number }): WindowChoice | undefined {
  if (!wins.length || rootCount <= 0) return undefined;
  const roled = wins.map((w) => ({ w, role: windowRole(w, screen) }));
  const ok = (x: { w: HelperWindow; role: UiWindowRole | 'bar' | undefined } | undefined) =>
    !!x && x.w.root !== undefined && x.w.root < rootCount && !!x.role && x.role !== 'bar' && DESCRIBABLE.has(x.role);
  const focused = roled.find((x) => x.w.focused);
  const active = roled.find((x) => x.w.active);
  const topApp = roled.find((x) => x.role === 'app' && x.w.root !== undefined && x.w.root < rootCount);
  const pick = ok(focused) ? focused : ok(active) ? active : topApp ?? roled.find((x) => x.w.root === 0);
  const root = pick?.w.root ?? 0;
  const windows: UiWindow[] = [];
  for (const { w, role } of roled) {
    if (!role || role === 'bar') continue;
    const bounds = clipToScreen(w.bounds, screen);   // the part on screen (vivo's edge card hangs off the side)
    if (!bounds) continue;
    const described = w === pick?.w;
    const showTexts = role !== 'app' && role !== 'keyboard' && !described && w.texts.length > 0;
    windows.push({
      role, bounds,
      ...(w.pkg ? { package: w.pkg } : {}), ...(w.title ? { title: w.title } : {}),
      ...(w.focused ? { focused: true } : {}), ...(described ? { described: true } : {}),
      ...(showTexts ? { texts: w.texts } : {}),
    });
  }
  return { root, windows };
}

function clipToScreen(b: HelperWindow['bounds'], screen: { width: number; height: number }): HelperWindow['bounds'] | undefined {
  if (!screen.width || !screen.height) return b;
  const x1 = Math.max(0, b.x), y1 = Math.max(0, b.y);
  const x2 = Math.min(screen.width, b.x + b.width), y2 = Math.min(screen.height, b.y + b.height);
  return x2 > x1 && y2 > y1 ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } : undefined;
}

/** One line for get_ui's text: what is over the described window, e.g.
 *  `Over the screen: heads-up (com.android.systemui) "pdtest · hello"; keyboard from y=1500`. '' = nothing. */
export function windowsLine(windows: UiWindow[] | undefined): string {
  if (!windows?.length) return '';
  const di = windows.findIndex((w) => w.described);
  const over = (di < 0 ? windows : windows.slice(0, di)).filter((w) => w.role !== 'app' || w.focused);
  const below = di < 0 ? [] : windows.slice(di + 1).filter((w) => w.role === 'keyboard' || w.role === 'heads_up' || w.role === 'dialog');
  const parts = [...over, ...below].map((w) => {
    const what = w.role === 'keyboard' ? `keyboard from y=${w.bounds.y}`
      : w.role === 'heads_up' ? 'heads-up notification'
      : w.role === 'notifications' ? 'notification shade'
      : w.role === 'dialog' ? 'system dialog'
      : w.role === 'pip' ? 'picture-in-picture'
      : w.role === 'system' ? 'system window' : 'app window';
    const who = w.role === 'keyboard' || w.role === 'heads_up' || w.role === 'notifications' ? '' : w.title && !/^\d+$/.test(w.title) ? ` "${w.title}"` : w.package ? ` (${w.package})` : '';
    const says = w.texts?.length ? `: ${JSON.stringify(w.texts.join(' · '))}` : '';
    // where a window that isn't the keyboard or a notification sits, like an element: @(centre) w×h
    const at = w.role === 'keyboard' || w.role === 'heads_up' || w.role === 'notifications' ? ''
      : ` @(${Math.round(w.bounds.x + w.bounds.width / 2)},${Math.round(w.bounds.y + w.bounds.height / 2)}) ${w.bounds.width}x${w.bounds.height}`;
    return `${what}${who}${at}${says}`;
  });
  return parts.length ? `Over the screen: ${parts.join('; ')}` : '';
}
