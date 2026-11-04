// `expect` on input routes (POST /input, /fill, /swipe, /apps/:id/launch): after the input, wait (like POST /wait)
// until the screen shows what the caller expected, and say plainly how it went:
//   verified           the expectation was met
//   screen_unchanged   not met, and the screen never changed after the input (it probably did nothing)
//   changed_not_found  not met, but the screen changed (it did something else, or the target is named differently)
// One shape for every input: { visible: "text" } | { gone: "text" } | { id: "resource-id" } | { changed: true },
// plus match (contains | exact | regex) and timeoutMs (default 5000). The input was sent either way: an unmet
// expectation is a result (expect.ok false), never an error, and never a reason to resend the input.
import { PhoneDockError, type ElementMatch, type Expect, type ExpectReport, type UiTree } from '../core/types.ts';
import { sleep } from '../core/exec.ts';
import { lastActionAt, uiCache } from './core.ts';
import { badRequest } from './http.ts';
import { findElements, screenSummary, type MatchMode } from './media.ts';
import { screenDigest } from './observe.ts';
import { axTree, ocrTree, pollFind, type Dev, type FindOpts } from './find.ts';

export type { Expect, ExpectReport };
export type ExpectOutcome = ExpectReport['outcome'];

const KEYS = new Set(['visible', 'gone', 'id', 'changed', 'match', 'timeoutMs']);
const MODES = new Set(['contains', 'exact', 'regex']);
/** Validate `expect` (undefined: none). Throws bad_request before anything is sent. */
export function parseExpect(raw: unknown): Expect | undefined {
  if (raw === undefined || raw === null || raw === false) return undefined;
  if (typeof raw === 'string') return raw ? { visible: raw } : undefined;   // shorthand: the text to see
  if (typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('expect must be an object: {visible: "text"} | {gone: "text"} | {id: "id"} | {changed: true}, plus match and timeoutMs');
  const o = raw as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !KEYS.has(k));
  if (extra.length) throw badRequest(`Unknown expect key${extra.length > 1 ? 's' : ''} ${extra.join(', ')}: use visible, gone, id or changed, plus match and timeoutMs`);
  const str = (k: string) => { const v = o[k]; if (v === undefined) return undefined; if (typeof v !== 'string' || !v) throw badRequest(`expect.${k} must be a non-empty string`); return v; };
  const e: Expect = { visible: str('visible'), gone: str('gone'), id: str('id') };
  if (o.changed !== undefined) { if (typeof o.changed !== 'boolean') throw badRequest('expect.changed must be true'); if (o.changed) e.changed = true; }
  const kinds = [e.visible, e.gone, e.id, e.changed].filter((v) => v !== undefined).length;
  if (kinds !== 1) throw badRequest('expect needs exactly one of visible, gone, id, changed');
  if (o.match !== undefined) { if (typeof o.match !== 'string' || !MODES.has(o.match)) throw badRequest('expect.match must be contains | exact | regex'); e.match = o.match as MatchMode; }
  if (o.timeoutMs !== undefined) {
    const t = Number(o.timeoutMs);
    if (!Number.isFinite(t) || t < 0) throw badRequest('expect.timeoutMs must be a number of milliseconds');
    e.timeoutMs = Math.min(t, 60_000);
  }
  for (const k of ['visible', 'gone', 'id'] as const) if (e[k] === undefined) delete e[k];
  return e;
}

/** The query for visible / gone / id. */
export function expectQuery(e: Expect): FindOpts | undefined {
  if (e.visible) return { text: e.visible, match: e.match ?? 'contains', ocrFallback: true };
  if (e.gone) return { text: e.gone, match: e.match ?? 'contains', ocrFallback: true };
  if (e.id) return { id: e.id, match: e.match ?? 'contains', ocrFallback: false };
  return undefined;
}
export function expectWords(e: Expect): string {
  if (e.changed) return 'the screen to change';
  if (e.gone) return `${JSON.stringify(e.gone)} gone`;
  if (e.id) return `id ${e.id} visible`;
  return `${JSON.stringify(e.visible)} visible`;
}
const secs = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

/** The outcome from what was seen (pure). met: the expectation held at the end; changed: the screen's signature
 *  differed from the one before the input at some look (null: no reading before). */
export function judgeExpect(e: Expect, met: boolean, changed: boolean | null, elapsedMs: number, wasThere?: boolean): Pick<ExpectReport, 'ok' | 'outcome' | 'message'> {
  const what = e.gone ? JSON.stringify(e.gone) : e.id ? `id ${e.id}` : e.visible ? JSON.stringify(e.visible) : '';
  if (met) {
    const msg = e.changed ? `Verified: the screen changed (${secs(elapsedMs)}).`
      : e.gone ? `Verified: ${what} is gone (${secs(elapsedMs)}).`
      : `Verified: ${what} is on screen (${secs(elapsedMs)})${wasThere && changed === false ? ', but it was already there before the input and the screen did not change' : wasThere ? ' (it was there before too; the screen changed)' : ''}.`;
    return { ok: true, outcome: 'verified', message: msg };
  }
  if (changed === false) {
    const tail = e.changed ? '' : e.gone ? `; ${what} is still there` : `; ${what} is not on it`;
    return { ok: false, outcome: 'screen_unchanged', message: `Not verified: the screen did not change in ${secs(elapsedMs)}${tail}.` };
  }
  // changed === null: there was no reading before the input, so whether it changed is unknown (outcome as if it did)
  const head = changed === null ? 'Not verified:' : 'Not verified: the screen changed, but';
  const msg = e.changed ? `Not verified: no change seen in ${secs(elapsedMs)}.`
    : e.gone ? `${head} ${what} is still there after ${secs(elapsedMs)}.`
    : `${head} ${what} never appeared (${secs(elapsedMs)}).`;
  return { ok: false, outcome: 'changed_not_found', message: msg };
}

/** Before the input: the expectation and the screen as it is (the cached tree when it was read after the last
 *  action and is fresh, else a new read). Throws bad_request for a malformed `expect` (nothing sent yet). */
export interface PendingExpect { e: Expect; sig?: string; wasThere?: boolean }
export async function prepareExpect(d: Dev, raw: unknown): Promise<PendingExpect | undefined> {
  const e = parseExpect(raw);
  if (!e) return undefined;
  let tree: UiTree | undefined;
  const cached = uiCache.get(d.id);
  const at = cached ? Date.parse(cached.capturedAt) : NaN;
  if (cached && Number.isFinite(at) && at >= (lastActionAt.get(d.id) ?? 0) && Date.now() - at < 15_000) tree = cached;
  else {
    try { tree = await axTree(d); } catch { tree = undefined; }
    if (!tree || !tree.root.length) { try { tree = await ocrTree(d.b, d.nid); } catch { /* no reading: outcomes can't say whether it changed */ } }
  }
  if (!tree) return { e };
  const q = expectQuery(e);
  const wasThere = q ? findElements(tree, q).some((m) => m.visible) : undefined;
  return { e, sig: screenDigest(tree).sig, ...(wasThere !== undefined ? { wasThere } : {}) };
}

/** After the input: poll until the expectation holds or its timeout passes. Never throws for an unmet expectation. */
export async function finishExpect(d: Dev, p: PendingExpect, aborted?: () => boolean): Promise<ExpectReport> {
  const e = p.e; const timeoutMs = e.timeoutMs ?? 5000; const t0 = Date.now();
  const seen = { changed: (p.sig === undefined ? null : false) as boolean | null };
  const look = (t: UiTree) => { if (p.sig !== undefined && screenDigest(t).sig !== p.sig) seen.changed = true; };
  const q = expectQuery(e);
  let met = false; let polls = 0; let match: ElementMatch | undefined; let last: UiTree | undefined;
  if (q) {
    // Already visible before the input: only a screen that changed (and still shows it) proves the input worked, so
    // wait for that; at the timeout it still counts as met, with that said in the message.
    const needChange = !!p.wasThere && !e.gone && p.sig !== undefined;
    const r = await pollFind(d, q, e.gone ? 'gone' : 'visible', { timeoutMs, intervalMs: 300, aborted, onLook: look,
      abortError: () => new PhoneDockError('The client disconnected', 'aborted', 499), ...(needChange ? { also: () => seen.changed === true } : {}) });
    met = r.ok || (needChange && r.visible.length > 0); polls = r.polls; last = r.last.tree; if (!e.gone) match = r.visible[0];
  } else {
    // changed: the screen's signature differs from the one before the input
    const deadline = t0 + timeoutMs;
    for (;;) {
      if (aborted?.()) throw new PhoneDockError('The client disconnected', 'aborted', 499);
      const at = Date.now();
      try { last = (await axTree(d)) ?? undefined; } catch { last = undefined; }
      if (!last || !last.root.length) { try { last = await ocrTree(d.b, d.nid); } catch { /* */ } }
      polls++;
      if (last) look(last);
      if (seen.changed || p.sig === undefined || Date.now() >= deadline) break;
      await sleep(Math.max(0, 300 - (Date.now() - at)));
    }
    met = seen.changed === true;
  }
  const elapsedMs = Date.now() - t0;
  const j = judgeExpect(e, met, seen.changed, elapsedMs, p.wasThere);
  return {
    ...j, expected: expectWords(e), elapsedMs, polls, changed: seen.changed,
    ...(p.wasThere !== undefined ? { wasThere: p.wasThere } : {}), ...(match ? { match } : {}),
    ...(!j.ok && last ? { summary: screenSummary(last) } : {}),
  };
}
