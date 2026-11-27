// Request-local input accounting and per-device ordering. A lease protects ownership; the queue protects the
// sequence of primitives inside a fill/batch. AsyncLocalStorage keeps another request's logs out of delivery.
import { AsyncLocalStorage } from 'node:async_hooks';
import { PhoneDockError, type Delivery } from '../core/types.ts';
import { withInputFence } from '../core/input-fence.ts';

const BEFORE_SEND = new Set([
  'bad_request', 'stale_ref', 'lease_conflict', 'not_found', 'no_match', 'not_supported', 'unsupported', 'bad_key',
  'unknown_key', 'unsupported_char', 'not_running', 'offline', 'device_unavailable', 'forbidden', 'busy', 'aborted',
  'unauthorized', 'ui_unavailable', 'device_locked', 'passcode_required', 'passcode_tripped', 'passcode_missing',
  'before_first_unlock', 'unattended_unlock_disabled',
]);

/** Classify only known validation/availability failures as safe to retry. */
export function deliveryOf(e: unknown, sentBefore: boolean): Delivery {
  const own = e instanceof PhoneDockError ? e.delivery : undefined;
  if (own === 'unknown') return 'unknown';
  if (sentBefore) return 'sent';
  if (own) return own;
  return e instanceof PhoneDockError && BEFORE_SEND.has(e.code) ? 'not_sent' : 'unknown';
}

export interface InputScope {
  deviceId: string;
  owner?: string;
  sent: boolean;
  uncertain: boolean;
  finished?: boolean;
  snapshotId?: string;
  secrets?: string[];
  assertAllowed: () => void;
}
const storage = new AsyncLocalStorage<InputScope>();
const queues = new Map<string, Promise<unknown>>();
const epochs = new Map<string, number>();
export const inputScope = () => storage.getStore();
export const ownershipEpoch = (id: string) => epochs.get(id) ?? 0;
export const ownershipChangeListeners = new Set<(id: string) => void>();
export function ownershipChanged(id: string): void {
  epochs.set(id, ownershipEpoch(id) + 1);
  for (const fn of ownershipChangeListeners) { try { fn(id); } catch { /* listener error */ } }
}
export function assertInputActive(): void { storage.getStore()?.assertAllowed(); }
export function inputWasSent(id: string, owner: string, action: unknown): void {
  const s = storage.getStore();
  if (!s || s.deviceId !== id || (s.owner && s.owner !== owner)) return;
  const name = (action as { action?: string } | null)?.action ?? '';
  if (/^(tap|doubleTap|longPress|swipe|drag|pinch|type|key|clipboard\.set|app\.launch|app\.terminate)$/.test(name)) s.sent = true;
}
export function runInput<T>(scope: InputScope, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(scope.deviceId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => storage.run(scope, () => withInputFence(scope.assertAllowed, async () => {
    scope.assertAllowed();
    try { return await fn(); } finally { scope.finished = true; }
  })));
  queues.set(scope.deviceId, next);
  void next.catch(() => undefined).finally(() => { if (queues.get(scope.deviceId) === next) queues.delete(scope.deviceId); });
  return next;
}

// Shell calls inside fill include both reads and writes. Fence them, but let the input action log account for
// their actual writes. Every normal input method acknowledges delivery itself, before any diagnostic logging.
const MUTATIONS = new Set(['tap', 'doubleTap', 'longPress', 'swipe', 'drag', 'pinch', 'type', 'key', 'hideKeyboard',
  'installApp', 'uninstallApp', 'launchApp', 'terminateApp', 'openUrl', 'clipboardSet', 'setLocation',
  'pushNotification', 'rotate', 'setAppearance', 'setSettings', 'resetSettings', 'importAppData', 'shell']);
export function guardedBackendCall<T>(backend: string, method: PropertyKey, args: unknown[], fn: () => T): T {
  const scope = storage.getStore();
  if (!scope || !MUTATIONS.has(String(method)) || `${backend}:${args[0]}` !== scope.deviceId) return fn();
  scope.assertAllowed();
  if (method === 'type') {
    const opts = args[2] as { beforeInput?: () => void } | undefined;
    args[2] = { ...opts, beforeInput() { scope.assertAllowed(); opts?.beforeInput?.(); } };
  }
  const sent = () => { if (method !== 'shell') scope.sent = true; };
  const failed = (e: unknown): never => {
    const delivery = deliveryOf(e, false);
    if (delivery === 'unknown') scope.uncertain = true;
    else if (delivery === 'sent') scope.sent = true;
    throw e;
  };
  try {
    const result = fn();
    if (result && typeof (result as any).then === 'function') return Promise.resolve(result).then((v) => { sent(); return v; }, failed) as T;
    sent(); return result;
  } catch (e) { return failed(e); }
}
