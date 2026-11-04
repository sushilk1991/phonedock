// How far an input got, for every input route's result and error (pure rules + a route wrapper; see
// delivery.test.ts). An agent that sees a failure must know whether sending the same input again is safe:
//   sent      it reached the device (a result; or an error after part of a multi-step input went in)
//   not_sent  nothing reached the device: sending it again is safe (retrySafe: true)
//   unknown   it may have reached the device (a reply was lost, adb died mid-command): look at the screen first
// The daemon never resends an input whose delivery is unknown (src/backends/android-common.ts sendInput).
import { PhoneDockError, type Delivery } from '../core/types.ts';
import { actionCount } from './core.ts';
import { Raw, type Ctx, type Handler } from './http.ts';

/** Error codes raised before anything is sent to the device (validation, lookup, leases, unsupported, stopped). */
const BEFORE_SEND = new Set([
  'bad_request', 'stale_ref', 'lease_conflict', 'not_found', 'no_match', 'not_supported', 'unsupported', 'bad_key',
  'unknown_key', 'unsupported_char', 'not_running', 'offline', 'device_unavailable', 'forbidden', 'busy', 'aborted',
  'unauthorized', 'ui_unavailable',
]);

/** The delivery of a failed input request: the error's own word when it is 'unknown'; 'sent' when an earlier step of
 *  the same request went in; else the error's own word, or (none) not_sent for errors raised before sending and
 *  unknown for the rest. */
export function deliveryOf(e: unknown, sentBefore: boolean): Delivery {
  const own = e instanceof PhoneDockError ? e.delivery : undefined;
  if (own === 'unknown') return 'unknown';
  if (sentBefore) return 'sent';
  if (own) return own;
  return e instanceof PhoneDockError && BEFORE_SEND.has(e.code) ? 'not_sent' : 'unknown';
}
export const retrySafe = (d: Delivery): boolean => d === 'not_sent';

/** Several inputs in one request: not_sent only when none went in; unknown when any may have; else sent. */
export function combineDelivery(parts: Delivery[]): Delivery {
  if (parts.includes('unknown')) return 'unknown';
  return parts.includes('sent') ? 'sent' : 'not_sent';
}

/** One short sentence for messages: "Not sent: safe to retry." etc. */
export function deliveryWords(d: Delivery): string {
  return d === 'not_sent' ? 'Nothing was sent to the device: safe to retry.'
    : d === 'unknown' ? 'It may have reached the device: look at the screen before retrying.'
    : 'It was sent to the device: don’t resend it blindly.';
}

/** Wrap an input route: a result (a plain object) gets `delivery` and `retrySafe` (from the actions logged during the
 *  request); a thrown error gets `delivery` (sendError writes both). */
export function inputRoute(h: Handler): Handler {
  return async (c: Ctx) => {
    const id = c.params.id; const n0 = actionCount.get(id) ?? 0;
    const sent = () => (actionCount.get(id) ?? 0) > n0;
    try {
      const out = await h(c);
      if (out && typeof out === 'object' && !(out instanceof Raw) && !Array.isArray(out) && !('delivery' in out)) {
        const d: Delivery = sent() ? 'sent' : 'not_sent';
        return { ...(out as Record<string, unknown>), delivery: d, retrySafe: retrySafe(d) };
      }
      return out;
    } catch (e) {
      const d = deliveryOf(e, sent());
      if (e instanceof PhoneDockError) { e.delivery = d; throw e; }
      const err = e as Error;
      throw new PhoneDockError('Something went wrong', 'internal', 500, undefined, err?.stack ?? err?.message ?? String(e), d);
    }
  };
}
