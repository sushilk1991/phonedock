// What the daemon saw, for `flow save` (src/core/flow.ts flowFromLog): a per-device observations.jsonl next to
// actions.jsonl. Reads (get_ui, find, wait) are not actions, so they never go into the action log (the app's
// Activity list shows that file); this one is internal:
//   {at, kind:'screen', sig, texts, screen}         a fresh UI tree the daemon read (only when it changed, or after an action)
//   {at, kind:'wait', owner, until, query, ok, …}    POST /wait finished (ok) or timed out
//   {at, kind:'scroll_to', owner, query, found, …}   POST /scroll-to finished
// The screens give `flow save` its automatic assertions and its undo detection; the waits and scroll_tos become steps.
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { stateDir } from '../core/paths.ts';
import { PhoneDockError, type UiElement, type UiTree } from '../core/types.ts';
import type { Observation, Selector } from '../core/flow.ts';
import type { Ctx, Handler } from './http.ts';
import { flatten, isEditable, keyboardInfo } from './media.ts';
import { lastActionAt, safeId, uiCacheListeners } from './core.ts';

const MAX_BYTES = 2 * 1024 * 1024;   // then observations.jsonl becomes observations.1.jsonl (one old file kept)
const file = (id: string, n = '') => join(stateDir('devices', safeId(id)), `observations${n}.jsonl`);
const shortType = (t?: string) => (t ?? '').split('.').pop() ?? '';
const CLOCKISH = /^(\d{1,2}[:.]\d{2}(\s?[AP]M)?|\d{1,3}\s?%|[\d\s:./-]+)$/i;
// Not text a person reads: the app element, icons (iOS images are labelled with symbol names such as "chevron.forward").
const NOT_TEXT = /^(Application|Image|ImageView|Icon)$/i;

/** A text field (its text is what was typed, not a label). "TextView" is an iOS multi-line field but an Android label:
 *  only a field when it has a value or a placeholder. */
const isField = (e: UiElement) => isEditable(e) && (shortType(e.type) !== 'TextView' || e.value !== undefined || e.placeholder !== undefined);

/** The screen's visible texts (top to bottom, no keyboard, no status bar, no typed field contents) and a signature of
 *  everything on it (texts, values, toggle states) that changes when the screen does. */
export function screenDigest(tree: UiTree): { sig: string; texts: string[] } {
  const W = tree.screen?.width || 0, H = tree.screen?.height || 0;
  const kb = keyboardInfo(tree); const kbKeys = new Set(kb.node ? flatten([kb.node]) : []);
  const parts: string[] = []; const texts: string[] = []; const seen = new Set<string>();
  for (const e of flatten(tree.root)) {
    if (kbKeys.has(e)) continue;
    const b = e.bounds;
    if (/^com\.android\.systemui:/.test(e.id ?? '')) continue;                         // status bar / navigation bar
    if (H && b && b.y + b.height <= H * 0.04) continue;                                // iOS status bar strip
    const t = (e.text ?? e.label ?? '').replace(/\s+/g, ' ').trim();
    if (t || e.value || e.checked !== undefined || e.selected) parts.push([shortType(e.type), t, e.value ?? '', e.checked ? 1 : 0, e.selected ? 1 : 0].join('\u0001'));
    const onScreen = !W || !H || !b || (b.x < W && b.y < H && b.x + b.width > 0 && b.y + b.height > 0);
    if (!t || !onScreen || isField(e) || NOT_TEXT.test(shortType(e.type)) || seen.has(t) || t.length > 80 || CLOCKISH.test(t)) continue;
    seen.add(t); if (texts.length < 60) texts.push(t);
  }
  return { sig: createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 16), texts };
}

function append(id: string, o: Observation) {
  try {
    const f = file(id);
    if (existsSync(f) && statSync(f).size > MAX_BYTES) renameSync(f, file(id, '.1'));
    appendFileSync(f, JSON.stringify(o) + '\n');
  } catch { /* observations are best effort */ }
}

const lastScreen = new Map<string, { sig: string; at: number }>();
/** Note a fresh tree: when the screen changed, or when an action was logged since the last note (so a flow can
 *  tell "tapped, then back to the same screen"). */
export function noteScreen(id: string, tree: UiTree) {
  if (!tree?.root) return;
  const { sig, texts } = screenDigest(tree);
  if (!texts.length) return;   // nothing readable (an app still launching, an empty tree): says nothing about the screen
  const prev = lastScreen.get(id); const now = Date.now();
  if (prev && prev.sig === sig && (lastActionAt.get(id) ?? 0) <= prev.at) return;
  lastScreen.set(id, { sig, at: now });
  append(id, { at: new Date(now).toISOString(), kind: 'screen', sig, texts, ...(tree.screen?.width ? { screen: [tree.screen.width, tree.screen.height] as [number, number] } : {}) });
}
uiCacheListeners.push(noteScreen);

const query = (b: Record<string, unknown>): Selector => {
  const q: Selector = {};
  for (const k of ['text', 'id', 'type'] as const) if (typeof b[k] === 'string' && b[k]) q[k] = b[k] as string;
  if (b.match === 'exact' || b.match === 'regex') q.match = b.match;
  return q;
};

/** Wrap POST /wait: note what was waited for and whether it came. */
export function observeWait(h: Handler): Handler {
  return async (c: Ctx) => {
    const t0 = Date.now();
    const note = async (ok: boolean, elapsedMs?: number) => {
      const b = await c.body().catch(() => ({})) as Record<string, unknown>;
      const until = String(b.until ?? '') as 'visible' | 'gone' | 'idle';
      if (!['visible', 'gone', 'idle'].includes(until)) return;
      append(c.params.id, { at: new Date().toISOString(), kind: 'wait', owner: c.owner, until, ...(until === 'idle' ? {} : { query: query(b) }), ok, elapsedMs: elapsedMs ?? Date.now() - t0 });
    };
    try {
      const res = await h(c) as { ok?: boolean; elapsedMs?: number } | undefined;
      await note(res?.ok !== false, res?.elapsedMs);
      return res;
    } catch (e) {
      if (e instanceof PhoneDockError && e.code === 'wait_timeout') await note(false);
      throw e;
    }
  };
}

/** Wrap POST /scroll-to: note what was scrolled to and whether it was found. */
export function observeScrollTo(h: Handler): Handler {
  return async (c: Ctx) => {
    const res = await h(c) as { found?: boolean; scrolls?: number; direction?: string } | undefined;
    const b = await c.body().catch(() => ({})) as Record<string, unknown>;
    const direction = typeof b.direction === 'string' ? b.direction as 'up' | 'down' | 'left' | 'right' : undefined;
    append(c.params.id, { at: new Date().toISOString(), kind: 'scroll_to', owner: c.owner, query: query(b), ...(direction ? { direction } : {}), found: !!res?.found, scrolls: res?.scrolls ?? 0 });
    return res;
  };
}

/** Observations since `sinceMs` (both files, oldest first). */
export function readObservations(id: string, sinceMs = 0): Observation[] {
  const out: Observation[] = [];
  for (const f of [file(id, '.1'), file(id)]) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue;
      try { const o = JSON.parse(line) as Observation; if (Date.parse(o.at) >= sinceMs) out.push(o); } catch { /* */ }
    }
  }
  return out;
}
