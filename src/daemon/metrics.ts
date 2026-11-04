// Bounded, in-memory latency samples. Percentiles describe the most recent samples;
// count and maximum cover the lifetime of the daemon.
export class Histogram {
  private samples: number[] = [];
  private next = 0;
  private count = 0;
  private max = 0;
  private capacity: number;
  constructor(capacity = 1024) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be positive');
    this.capacity = capacity;
  }
  record(ms: number) {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.count++;
    this.max = Math.max(this.max, ms);
    if (this.samples.length < this.capacity) this.samples.push(ms);
    else { this.samples[this.next] = ms; this.next = (this.next + 1) % this.capacity; }
  }
  snapshot() {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const percentile = (p: number) => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : 0;
    return { count: this.count, p50: percentile(0.5), p95: percentile(0.95), max: this.max };
  }
}

export class Metrics {
  private routes = new Map<string, Histogram>();
  private backends = new Map<string, Histogram>();
  record(kind: 'routes' | 'backends', key: string, ms: number) {
    const map = this[kind];
    let histogram = map.get(key);
    if (!histogram) { histogram = new Histogram(); map.set(key, histogram); }
    histogram.record(ms);
  }
  snapshot() {
    const entries = (map: Map<string, Histogram>) => Object.fromEntries([...map].map(([key, h]) => [key, h.snapshot()]));
    return { unit: 'ms', sampleWindow: 1024, routes: entries(this.routes), backends: entries(this.backends) };
  }
}
export const metrics = new Metrics();

/** Preserve backend method return types and receiver, including synchronous methods. */
export function instrumentBackend<T extends object>(backend: T, id: string, collector = metrics): T {
  const wrappers = new Map<PropertyKey, { original: Function; wrapped: Function }>();
  return new Proxy(backend, {
    get(target, key, receiver) {
      const original = Reflect.get(target, key, receiver);
      if (typeof original !== 'function') return original;
      const cached = wrappers.get(key);
      if (cached?.original === original) return cached.wrapped;
      const wrapped = (...args: unknown[]) => {
        const start = performance.now();
        const record = () => collector.record('backends', `${id}.${String(key)}`, performance.now() - start);
        try {
          const result = Reflect.apply(original, target, args);
          if (result && typeof result.then === 'function') return Promise.resolve(result).finally(record);
          record(); return result;
        } catch (error) { record(); throw error; }
      };
      wrappers.set(key, { original, wrapped });
      return wrapped;
    },
  });
}
