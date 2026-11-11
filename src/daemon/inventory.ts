// Independent backend discovery with bounded waits. Timing out the caller never pretends an underlying
// listDevices call was cancelled: it stays single-flight until it settles, even when a provider hangs.
import type { Device } from '../core/types.ts';

export interface InventoryBackend { id: string; listDevices(): Promise<Device[]> }
export interface InventoryOptions {
  initialWaitMs?: number; maxAgeMs?: number; timeoutMs?: number; retryDelayMs?: number;
  now?: () => number; onUpdate?: (backend: string) => void;
}
export interface InventoryStatus { refreshing: boolean; at?: number; error?: string; timedOut?: boolean; devices: number }
interface Entry {
  backend: InventoryBackend; devices?: Device[]; at?: number; lastAttempt?: number;
  revision: number;
  pending?: Promise<void>; timer?: NodeJS.Timeout; error?: string; timedOut?: boolean; signature?: string;
}
export class BackendInventory {
  private entries = new Map<string, Entry>();
  private opts: Required<Pick<InventoryOptions, 'initialWaitMs' | 'maxAgeMs' | 'timeoutMs' | 'retryDelayMs'>> & InventoryOptions;
  private closed = false;
  constructor(opts: InventoryOptions = {}) {
    this.opts = { initialWaitMs: 250, maxAgeMs: 2000, timeoutMs: 30_000, retryDelayMs: 2000, ...opts };
    for (const key of ['initialWaitMs', 'maxAgeMs', 'timeoutMs', 'retryDelayMs'] as const) {
      if (!Number.isFinite(this.opts[key]) || this.opts[key] < 0) throw new RangeError(`${key} must be a non-negative duration`);
    }
  }
  private now(): number { return (this.opts.now ?? Date.now)(); }
  private notify(id: string): void { if (!this.closed) { try { this.opts.onUpdate?.(id); } catch { /* consumer invalidation is best effort */ } } }
  private start(id: string, entry: Entry): void {
    entry.lastAttempt = this.now();
    const backend = entry.backend;
    const revision = entry.revision;
    // Assign pending before invoking the provider, including a provider that throws synchronously.
    const work = Promise.resolve().then(() => backend.listDevices());
    const finish = work.then((devices) => {
      if (this.closed || this.entries.get(id) !== entry) return;
      if (entry.revision !== revision) {
        entry.pending = undefined; entry.lastAttempt = undefined;
        if (entry.timer) clearTimeout(entry.timer); entry.timer = undefined;
        this.notify(id); return;
      }
      if (!Array.isArray(devices)) throw new TypeError(`${id}.listDevices returned a non-array result`);
      const signature = JSON.stringify(devices);
      const changed = entry.signature !== signature || !!entry.error || !!entry.timedOut;
      entry.devices = devices.map((d) => this.copy(d)); entry.signature = signature;
      entry.at = this.now(); entry.error = undefined; entry.timedOut = undefined;
      entry.pending = undefined; if (entry.timer) clearTimeout(entry.timer); entry.timer = undefined;
      if (changed) this.notify(id);
    }).catch((error: unknown) => {
      if (this.closed || this.entries.get(id) !== entry) return;
      if (entry.revision !== revision) {
        entry.pending = undefined; entry.lastAttempt = undefined;
        if (entry.timer) clearTimeout(entry.timer); entry.timer = undefined;
        this.notify(id); return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const changed = entry.error !== message || !!entry.timedOut;
      entry.error = message; entry.timedOut = undefined; entry.pending = undefined;
      if (entry.timer) clearTimeout(entry.timer); entry.timer = undefined;
      if (changed) this.notify(id);
    });
    entry.pending = finish;
    if (this.opts.timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        if (this.closed || this.entries.get(id) !== entry || entry.pending !== finish) return;
        entry.timedOut = true; entry.error = `${id}.listDevices timed out after ${this.opts.timeoutMs} ms; the provider is still running`;
        this.notify(id);
      }, this.opts.timeoutMs);
      entry.timer.unref();
    }
    // onUpdate may throw in a consumer; never let a provider callback create an unhandled rejection.
    void finish.catch(() => undefined);
  }
  private copy(d: Device): Device {
    return { ...d, capabilities: [...d.capabilities], ...(d.meta ? { meta: { ...d.meta } } : {}), ...(d.screen ? { screen: { ...d.screen } } : {}) };
  }
  async list(backends: readonly InventoryBackend[], opts: { fresh?: boolean; backend?: string; waitMs?: number } = {}): Promise<Device[]> {
    if (this.closed) throw new Error('Inventory is closed');
    const selected = backends.filter((b) => !opts.backend || b.id === opts.backend);
    const entries: [string, Entry][] = [];
    for (const backend of selected) {
      let e = this.entries.get(backend.id);
      if (!e) {
        e = { backend, revision: 0 };
        this.entries.set(backend.id, e);
      } else if (e.backend !== backend) {
        // Replacing the provider invalidates its old result but does not cancel or overlap an old call.
        e.backend = backend; e.revision++; e.at = undefined; e.lastAttempt = undefined;
      }
      const age = e.at === undefined ? Infinity : this.now() - e.at;
      const due = e.lastAttempt === undefined || this.now() - e.lastAttempt >= this.opts.retryDelayMs;
      if (!e.pending && (opts.fresh || age >= this.opts.maxAgeMs) && (opts.fresh || due)) this.start(backend.id, e);
      entries.push([backend.id, e]);
    }
    const wait = opts.waitMs ?? this.opts.initialWaitMs;
    if (!Number.isFinite(wait) || wait < 0) throw new RangeError('waitMs must be a non-negative duration');
    const pending = entries.filter(([, e]) => e.pending && (opts.fresh || !e.devices)).map(([, e]) => e.pending!);
    if (pending.length && wait > 0) {
      let timer: NodeJS.Timeout | undefined;
      try { await Promise.race([Promise.allSettled(pending), new Promise<void>((r) => { timer = setTimeout(r, wait); })]); }
      finally { if (timer) clearTimeout(timer); }
    }
    const out: Device[] = [];
    for (const [, e] of entries) {
      const stale = !!e.pending || !!e.error || e.at === undefined || this.now() - e.at >= this.opts.maxAgeMs;
      for (const source of e.devices ?? []) {
        const d = this.copy(source);
        if (stale) d.meta = { ...d.meta, stale: true, ...(e.pending ? { refreshing: true } : {}), ...(e.error ? { listError: e.error } : {}) };
        out.push(d);
      }
    }
    return out;
  }
  status(): Record<string, InventoryStatus> {
    return Object.fromEntries([...this.entries].map(([id, e]) => [id, {
      refreshing: !!e.pending, ...(e.at !== undefined ? { at: e.at } : {}), ...(e.error ? { error: e.error } : {}),
      ...(e.timedOut ? { timedOut: true } : {}), devices: e.devices?.length ?? 0,
    }]));
  }
  invalidate(backend?: string): void {
    for (const [id, e] of this.entries) if (!backend || id === backend) { e.at = undefined; e.lastAttempt = undefined; e.revision++; }
  }
  /** Stop timers and ignore late provider results; this cannot cancel a provider's own subprocess or request. */
  close(): void { this.closed = true; for (const e of this.entries.values()) if (e.timer) clearTimeout(e.timer); this.entries.clear(); }
}
