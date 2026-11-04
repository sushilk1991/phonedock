// MCP tool arguments: names cheaper models get wrong, and the shared `expect` parameter (pure; see args.test.ts).
// - Unknown argument names are an error that names them and lists the right ones (the SDK would drop them silently,
//   so swipe(from_x=…) used to swipe from the default place, or fail later with an unrelated message).
// - A few common aliases are renamed instead: swipe's from_x/from_y/to_x/to_y and start_x/start_y/end_x/end_y, and any
//   valid name or alias spelled another way (durationMs, elementId, fromX).
import { z } from 'zod';
import type { Expect, ExpectReport } from '../sdk/client.ts';

/** Per tool: alias → the real argument name. */
export const ARG_ALIASES: Record<string, Record<string, string>> = {
  swipe: {
    from_x: 'x1', from_y: 'y1', to_x: 'x2', to_y: 'y2',
    start_x: 'x1', start_y: 'y1', end_x: 'x2', end_y: 'y2',
    duration: 'duration_ms',
  },
};

function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length; const d = Array.from({ length: n + 1 }, (_v, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= n; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return d[n];
}
/** The valid name an unknown one most likely meant (same letters ignoring case/_/-, a prefix, or ≤2 edits). */
const norm = (s: string) => s.toLowerCase().replace(/[_-]/g, '');
export function closestArg(name: string, valid: string[]): string | undefined {
  const n = norm(name);
  const same = valid.find((v) => norm(v) === n); if (same) return same;
  const pre = valid.find((v) => n.length >= 3 && (norm(v).startsWith(n) || n.startsWith(norm(v)) && norm(v).length >= 3)); if (pre) return pre;
  let best: { v: string; d: number } | undefined;
  for (const v of valid) { const dd = editDistance(n, norm(v)); if (dd <= 2 && (!best || dd < best.d)) best = { v, d: dd }; }
  return best?.v;
}

/** Rename aliases and refuse unknown argument names. Returns a new object; throws an Error whose message names the
 *  unknown arguments and lists the valid ones. */
export function normalizeArgs(tool: string, args: unknown, valid: string[]): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new Error(`Arguments for ${tool} must be an object of named arguments: ${valid.join(', ') || '(none)'}`);
  const aliases = ARG_ALIASES[tool] ?? {};
  const out: Record<string, unknown> = {}; const unknown: string[] = [];
  const set = new Set(valid);
  // the same name in another spelling (durationMs, elementId, toY): no round trip for that
  const spelled = new Map<string, string>();
  for (const v of valid) spelled.set(norm(v), v);
  for (const [a, real] of Object.entries(aliases)) if (!spelled.has(norm(a))) spelled.set(norm(a), real);
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    const real = set.has(k) ? k : aliases[k] ?? spelled.get(norm(k));
    if (!real || !set.has(real)) { unknown.push(k); continue; }
    if (real in out && out[real] !== v) {
      const alias = real === k ? Object.keys(args as object).find((x) => x !== k && (aliases[x] ?? spelled.get(norm(x))) === real) : k;
      throw new Error(`${tool}: ${alias} is another name for ${real}; pass one of them, not both`);
    }
    out[real] = v;
  }
  if (unknown.length) {
    const tips = unknown.map((u) => { const c = closestArg(u, valid); return c ? `${u} (did you mean ${c}?)` : u; });
    throw new Error(`${tool} has no argument${unknown.length > 1 ? 's' : ''} named ${tips.join(', ')}. Valid arguments: ${valid.join(', ') || '(none)'}.`);
  }
  return out;
}

/** The `expect` parameter of input tools. */
export const expectParam = z.strictObject({
  visible: z.string().min(1).optional().describe('Text that should appear'),
  gone: z.string().min(1).optional().describe('Text that should disappear'),
  id: z.string().min(1).optional().describe('Element id (Android resource-id / accessibility identifier) that should appear'),
  changed: z.boolean().optional().describe('true: the screen should change at all'),
  match: z.enum(['contains', 'exact', 'regex']).optional().describe('How text/id match (default contains)'),
  timeout_ms: z.number().int().min(0).max(60000).optional().describe('How long to wait (default 5000)'),
}).optional().describe('Check that the input worked, in the same call: one of {visible:"Welcome"}, {gone:"Loading"}, {id:"submit_button"}, {changed:true}. The result starts "Verified:" or "Not verified: the screen did not change" / "Not verified: the screen changed, but … never appeared". Saves a get_ui/wait_for round trip.');
export type ExpectArg = z.infer<typeof expectParam>;

/** MCP expect → the daemon's (timeout_ms → timeoutMs). undefined: none. Throws when it names no expectation. */
export function toExpect(a: ExpectArg): Expect | undefined {
  if (!a) return undefined;
  const kinds = [a.visible, a.gone, a.id, a.changed ? true : undefined].filter((v) => v !== undefined).length;
  if (kinds !== 1) throw new Error('expect needs exactly one of visible, gone, id or changed:true');
  return {
    ...(a.visible ? { visible: a.visible } : {}), ...(a.gone ? { gone: a.gone } : {}), ...(a.id ? { id: a.id } : {}),
    ...(a.changed ? { changed: true } : {}), ...(a.match ? { match: a.match } : {}), ...(a.timeout_ms !== undefined ? { timeoutMs: a.timeout_ms } : {}),
  };
}

/** The line an input tool adds for its `expect`, and whether the call counts as failed (an unmet expectation: the
 *  input was sent, so the line says not to resend it). */
export function expectLine(r: ExpectReport | undefined, what: string): { line: string; failed: boolean } {
  if (!r) return { line: '', failed: false };
  if (r.ok) return { line: r.message, failed: false };
  return { line: `${r.message} The ${what} was sent: don't resend it blindly.${r.summary ? ` Screen now: ${r.summary}` : ''}`, failed: true };
}
