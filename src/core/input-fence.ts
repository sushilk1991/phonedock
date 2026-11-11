// The daemon binds an ownership check for the lifetime of an input request. Transports
// call it immediately before sending, after their own connection/queue waits.
import { AsyncLocalStorage } from 'node:async_hooks';
const checks = new AsyncLocalStorage<() => void>();
export function withInputFence<T>(check: () => void, fn: () => T): T { return checks.run(check, fn); }
export function assertInputFence(): void { checks.getStore()?.(); }
