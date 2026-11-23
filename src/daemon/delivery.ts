// How far an input got, for every input route's result and error (pure rules + a route wrapper; see
// delivery.test.ts). An agent that sees a failure must know whether sending the same input again is safe:
//   sent      it reached the device (a result; or an error after part of a multi-step input went in)
//   not_sent  nothing reached the device: sending it again is safe (retrySafe: true)
//   unknown   it may have reached the device (a reply was lost, adb died mid-command): look at the screen first
// The daemon never resends an input whose delivery is unknown (src/backends/android-common.ts sendInput).
import { sleep } from '../core/exec.ts';
import { detectPrompt } from '../core/prompts.ts';
import { PhoneDockError, type Delivery, type UiTree } from '../core/types.ts';
import { uiTreeHash } from '../core/ui-hash.ts';
import { actionCount, checkLease, claimInput, deviceLaunchSecrets, getBackend, lastActionAt, noteScreen, splitId, uiCache } from './core.ts';
import { axTree, ocrTree } from './find.ts';
import { deliveryOf, ownershipEpoch, runInput, type InputScope } from './execution.ts';
import { Raw, type Ctx, type Handler } from './http.ts';
import { withRequestReceipt } from './requests.ts';
import { metrics } from './metrics.ts';
import { inputSecretValues, redactInputValue, redactSecretStrings } from '../core/secrets.ts';

export { deliveryOf } from './execution.ts';
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

async function withUiObservation(id: string, result: unknown, settleMs?: number): Promise<unknown> {
  if (!result || typeof result !== 'object' || result instanceof Raw) return result;
  let tree: UiTree | undefined = uiCache.get(id);
  try {
    const at = tree ? Date.parse(tree.capturedAt) : NaN;
    const hasExpect = (result as { expect?: unknown }).expect !== undefined;
    const canReuse = Boolean(
      tree
      && Number.isFinite(at)
      && tree.actionGeneration === (actionCount.get(id) ?? 0)
      && at >= (lastActionAt.get(id) ?? 0)
      && Date.now() - at <= 1000
      && (!settleMs || hasExpect),
    );
    if (!canReuse) {
      if (settleMs && settleMs > 0 && !hasExpect) await sleep(settleMs);
      const { backend, nativeId } = splitId(id);
      const b = getBackend(backend);
      tree = await axTree({ id, b, nid: nativeId }).catch(() => undefined);
      if ((!tree || !tree.root.length) && typeof b.screenshot === 'function') {
        tree = await ocrTree(b, nativeId);
      }
    }
    if (!tree) return { ...result, observationUnavailable: true };
    noteScreen(id, tree.screen?.width, tree.screen?.height);
    if (tree.prompt === undefined) {
      try { tree = { ...tree, prompt: detectPrompt(tree) }; } catch { /* best effort */ }
    }
    if (!tree.screenHash) tree = { ...tree, screenHash: uiTreeHash(tree) };
    return { ...result, ui: tree };
  } catch { return { ...result, observationUnavailable: true }; }
}

/** Wrap an input route: a result (a plain object) gets `delivery` and `retrySafe` (from the actions logged during the
 *  request); a thrown error gets `delivery` (sendError writes both). */
export function inputRoute(h: Handler): Handler {
  const execute = async (c: Ctx) => {
    const id = c.params.id;
    try { checkLease(id, c.owner); } catch (e) { if (e instanceof PhoneDockError) e.delivery = 'not_sent'; throw e; }
    const epoch = ownershipEpoch(id);
    let claim: ReturnType<typeof claimInput> | undefined;
    let released = false;
    let body: any;
    try { body = c.body ? await c.body() : {}; } catch (e) { if (e instanceof PhoneDockError) e.delivery = 'not_sent'; throw e; }
    if (body && typeof body === 'object') {
      if (body.returnUi !== undefined && typeof body.returnUi !== 'boolean') {
        throw new PhoneDockError('returnUi must be a boolean', 'bad_request', 400, undefined, undefined, 'not_sent');
      }
      if (body.settleMs !== undefined && (typeof body.settleMs !== 'number' || !Number.isInteger(body.settleMs) || body.settleMs < 0 || body.settleMs > 10_000)) {
        throw new PhoneDockError('settleMs must be an integer between 0 and 10000', 'bad_request', 400, undefined, undefined, 'not_sent');
      }
    }
    const secrets = inputSecretValues(body);
    const scope: InputScope = { deviceId: id, owner: c.owner, sent: false, uncertain: false, secrets, assertAllowed() {
      if (scope.finished) throw new PhoneDockError('The input request has already ended', 'aborted', 499, undefined, undefined, 'not_sent');
      if (c.res?.destroyed || c.req?.aborted) throw new PhoneDockError('The client disconnected before this input', 'aborted', 499, undefined, undefined, 'not_sent');
      claim?.check();
      checkLease(id, c.owner);
      if (ownershipEpoch(id) !== epoch) throw new PhoneDockError('Device ownership changed during this request', 'lease_conflict', 409,
        ['Read the screen and acquire the device again before sending new input.'], undefined, 'not_sent');
    } };
    if (typeof body?.snapshotId === 'string') scope.snapshotId = body.snapshotId;
    try {
      const queuedAt = performance.now();
      const out = await runInput(scope, async () => {
        metrics.record('phases', 'input.queue', performance.now() - queuedAt);
        claim = claimInput(id, c.owner);
        try {
          const started = performance.now();
          let result: unknown;
          try { result = await h(c); } finally { metrics.record('phases', 'input.execute', performance.now() - started); }
          return body?.returnUi ? await withUiObservation(id, result, body?.settleMs) : result;
        } finally { claim.release(); released = true; }
      });
      if (out && typeof out === 'object' && !(out instanceof Raw) && !Array.isArray(out) && !('delivery' in out)) {
        const d: Delivery = scope.uncertain ? 'unknown' : scope.sent ? 'sent' : 'not_sent';
        const { ui, ...rest } = out as Record<string, unknown>;
        const safeOut = redactInputValue({ ...rest, delivery: d, retrySafe: retrySafe(d) }, secrets);
        if (ui !== undefined) {
          const allSecrets = [...secrets, ...deviceLaunchSecrets(id)];
          (safeOut as Record<string, unknown>).ui = allSecrets.length ? redactSecretStrings(ui, allSecrets) : ui;
        }
        return safeOut;
      }
      return out;
    } catch (e) {
      const d = scope.uncertain ? 'unknown' : deliveryOf(e, scope.sent);
      if (e instanceof PhoneDockError) {
        e.delivery = d; e.message = redactInputValue(e.message, secrets); e.detail = redactInputValue(e.detail, secrets); e.hints = redactInputValue(e.hints, secrets); throw e;
      }
      const err = e as Error;
      throw new PhoneDockError('Something went wrong', 'internal', 500, undefined, redactInputValue(err?.stack ?? err?.message ?? String(e), secrets), d);
    } finally { if (!released) claim?.release(); }
  };
  return (c: Ctx) => withRequestReceipt(c, () => execute(c));
}
