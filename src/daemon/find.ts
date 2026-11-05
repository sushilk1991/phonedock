// Find elements on screen now, and poll until one shows up or goes away: shared by POST /find, /wait, /fill,
// /scroll-to (routes-extra.ts) and the `expect` check of input routes (expect.ts).
import { sleep } from '../core/exec.ts';
import type { Backend, ElementMatch, UiElement, UiTree } from '../core/types.ts';
import { ocrUiTree, warmOcr } from '../core/ocr.ts';
import { uiCache } from './core.ts';
import { badRequest, notSupported } from './http.ts';
import { cleanTree, findElements, type FindQuery, type MatchMode } from './media.ts';
import { noteScreen } from './observe.ts';

export type Dev = { id: string; b: Backend; nid: string };

export async function ocrTree(b: Backend, nid: string): Promise<UiTree> {
  // Static import: the app's bundled daemon has no src/core/ocr.ts to import() at run time (OCR silently never ran).
  return ocrUiTree(await b.screenshot(nid));
}
/** Cleaned accessibility tree (cached for tap-by-ref like GET /ui), or undefined when the backend has none. */
export async function axTree(d: Dev): Promise<UiTree | undefined> {
  if (!d.b.uiTree) return undefined;
  const t = cleanTree(await readUiTree(d));
  uiCache.set(d.id, t);
  return t;
}

// Every backend tree read (GET /ui, axTree) goes through readUiTree, so a tap by ref (refcheck.ts) can use one that is
// in flight or just done instead of paying for its own read.
const reading = new Map<string, { startedAt: number; p: Promise<UiTree> }>();
const lastRead = new Map<string, UiTree>();
/** The backend's raw tree (b.uiTree must exist), noted as in flight while it is read and as the latest read after. */
export function readUiTree(d: Dev): Promise<UiTree> {
  const r = { startedAt: Date.now(), p: d.b.uiTree!(d.nid) };
  reading.set(d.id, r);
  void r.p.then((t) => {
    const prev = lastRead.get(d.id);
    if (t?.root && (!prev || !(Date.parse(t.capturedAt) < Date.parse(prev.capturedAt)))) lastRead.set(d.id, t);
  }, () => undefined).catch(() => undefined).finally(() => { if (reading.get(d.id) === r) reading.delete(d.id); });
  return r.p;
}
/** A cleaned tree that shows the screen as it is now, read at or after `since` (the last input): the latest read when
 *  it was captured under `maxAgeMs` ago (`recent`), else one in flight that started at or after `since` (`joined`),
 *  else a new read (`read`). Never cached: refs keep naming the tree the client read. undefined: no tree on this
 *  backend. */
export async function recentTree(d: Dev, since: number, maxAgeMs: number): Promise<{ tree: UiTree; via: 'recent' | 'joined' | 'read' } | undefined> {
  if (!d.b.uiTree) return undefined;
  const last = lastRead.get(d.id); const at = last ? Date.parse(last.capturedAt) : NaN;
  if (last && at >= since && Date.now() - at < maxAgeMs) return { tree: cleanTree(last), via: 'recent' };
  const r = reading.get(d.id);
  if (r && r.startedAt >= since) { try { return { tree: cleanTree(await r.p), via: 'joined' }; } catch { /* read it ourselves */ } }
  return { tree: cleanTree(await readUiTree(d)), via: 'read' };
}

export interface FindOpts extends FindQuery { ocrFallback?: boolean }
const MODES = new Set(['contains', 'exact', 'regex']);
export function parseFind(body: Record<string, unknown>, requireCriteria = true): FindOpts {
  const s = (k: string) => (typeof body[k] === 'string' && body[k] !== '' ? String(body[k]) : undefined);
  const q: FindOpts = { text: s('text'), id: s('id'), type: s('type') };
  const m = s('match'); if (m && !MODES.has(m)) throw badRequest('match must be contains | exact | regex');
  q.match = (m as MatchMode | undefined) ?? 'contains';
  q.ocrFallback = body.ocrFallback === undefined ? true : !!body.ocrFallback;
  if (requireCriteria && !q.text && !q.id && !q.type) throw badRequest('Pass at least one of text, id, type');
  return q;
}

export interface FindResult { tree: UiTree; matches: ElementMatch[]; ocrTried: boolean; ocrError?: string }
/** Search the cleaned accessibility tree; fall back to OCR when there is no tree, it is empty, or (for text
 *  queries) nothing matched. OCR matches text only (type is ignored) and has no refs. */
export async function findOnce(d: Dev, q: FindOpts): Promise<FindResult> {
  let tree: UiTree | undefined; let err: unknown;
  try { tree = await axTree(d); } catch (e) { err = e; }
  let matches = tree ? findElements(tree, q) : [];
  let ocrTried = false; let ocrError: string | undefined;
  const empty = !tree || !tree.root.length;
  if (tree && !empty) warmOcr();
  if (q.ocrFallback !== false && (empty || (!matches.length && q.text && !q.id))) {
    if (q.text || empty) {
      ocrTried = true;
      try {
        const ot = await ocrTree(d.b, d.nid);
        const om = q.text ? findElements(ot, { text: q.text, match: q.match, editable: q.editable }) : [];
        if (om.length || empty) { tree = ot; matches = om; }
        if (empty) noteScreen(d.id, ot);   // the screen as read by OCR (flow save; not cached: OCR has no refs)
      } catch (e) {
        if (!tree) throw e;
        // a tree exists but OCR failed: say so instead of a bare "no match" for text that is plainly on screen
        ocrError = (e as { detail?: string }).detail ?? (e as Error).message;
        console.error(`[find] OCR fallback failed for ${d.id}: ${ocrError}`);
      }
    }
  }
  if (!tree) throw err ?? notSupported('UI tree', d.b.id, ['Pass ocrFallback:true to search OCR text']);
  return { tree, matches, ocrTried, ...(ocrError ? { ocrError } : {}) };
}

export function describe(m: ElementMatch | UiElement): string {
  const t = m.text ?? m.label ?? m.value;
  return `${m.ref ?? 'ocr'} ${String(m.type).split('.').pop()}${t ? ` ${JSON.stringify(t.length > 60 ? t.slice(0, 59) + '…' : t)}` : ''}${m.id ? ` id=${m.id.replace(/^.*:id\//, '')}` : ''}`;
}
export function queryText(q: FindQuery): string {
  return [q.text && `text ${JSON.stringify(q.text)}${q.match && q.match !== 'contains' ? ` (${q.match})` : ''}`, q.id && `id ${JSON.stringify(q.id)}`, q.type && `type ${q.type}`].filter(Boolean).join(' + ');
}

export interface PollResult { ok: boolean; polls: number; elapsedMs: number; last: FindResult; visible: ElementMatch[] }
/** Poll findOnce until a match is visible (`visible`) or none is (`gone`) for `stableMs`, or `timeoutMs` passes
 *  (ok: false, with the last look). `onLook` sees every tree read; `also` is a further condition (after onLook).
 *  POST /wait and `expect` use it. */
export async function pollFind(d: Dev, q: FindOpts, until: 'visible' | 'gone',
  o: { timeoutMs: number; intervalMs: number; stableMs?: number; aborted?: () => boolean; onLook?: (tree: UiTree) => void; abortError?: () => Error; also?: () => boolean }): Promise<PollResult> {
  const t0 = Date.now(); const deadline = t0 + o.timeoutMs; const stableMs = o.stableMs ?? 0;
  let polls = 0; let okSince = 0; let last: FindResult;
  for (;;) {
    if (o.aborted?.()) throw o.abortError?.() ?? new Error('aborted');
    const at = Date.now();
    last = await findOnce(d, q);
    polls++;
    o.onLook?.(last.tree);
    const visible = last.matches.filter((m) => m.visible);
    const hit = (until === 'visible' ? visible.length > 0 : visible.length === 0) && (o.also?.() ?? true);
    if (hit) {
      okSince ||= at;
      if (at - okSince >= stableMs) return { ok: true, polls, elapsedMs: Date.now() - t0, last, visible };
    } else okSince = 0;
    if (Date.now() >= deadline) return { ok: false, polls, elapsedMs: Date.now() - t0, last, visible };
    await sleep(Math.max(0, o.intervalMs - (Date.now() - at)));
  }
}
