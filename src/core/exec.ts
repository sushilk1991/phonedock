// Shared subprocess helpers. Always pass argv arrays (never shell strings) to avoid injection.
import { spawn, type SpawnOptions } from 'node:child_process';
import type { ExecResult } from './types.ts';
import { PhoneDockError } from './types.ts';
import { assertInputFence } from './input-fence.ts';

export interface RunOptions extends SpawnOptions {
  input?: string | Buffer;
  failureMessage?: string;    // human-readable description of the failed action
  timeoutMs?: number;          // default 60s; 0 = none
  allowFail?: boolean;         // don't throw on non-zero exit
  maxBuffer?: number;          // bytes, default 256MB
}

/** Run a command, capture stdout as Buffer. Throws PhoneDockError on failure unless allowFail. */
export function runBuffer(cmd: string, args: string[], opts: RunOptions = {}): Promise<{ stdout: Buffer; stderr: string; code: number }> {
  const { input, failureMessage = 'Couldn’t complete the operation', timeoutMs = 60_000, allowFail = false, maxBuffer = 256 * 1024 * 1024, ...spawnOpts } = opts;
  return new Promise((resolve, reject) => {
    assertInputFence();
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], ...spawnOpts });
    const out: Buffer[] = []; let outLen = 0; let err = '';
    let stdinErr: NodeJS.ErrnoException | undefined;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs > 0) timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.stdin!.on('error', (e: NodeJS.ErrnoException) => { stdinErr = e; });
    child.stdout!.on('data', (d: Buffer) => { outLen += d.length; if (outLen <= maxBuffer) out.push(d); });
    child.stderr!.on('data', (d: Buffer) => { if (err.length < 1_000_000) err += d.toString(); });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(new PhoneDockError(failureMessage, 'exec_failed', 500, undefined, `${cmd} ${args.join(' ')}: ${e.message}`));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      let stderr = err;
      if (stdinErr && input !== undefined) {
        stderr = stderr ? `${stderr}\nstdin write error: ${stdinErr.message}` : `stdin write error: ${stdinErr.message}`;
      }
      const c = code !== null && code !== 0 ? code : (signal ? 137 : stdinErr && input !== undefined ? 1 : (code ?? 1));
      const res = { stdout: Buffer.concat(out), stderr, code: c };
      if (c !== 0 && !allowFail) {
        reject(new PhoneDockError(failureMessage, 'exec_failed', 500, undefined, `${cmd} ${args.join(' ')} exited ${c}${signal ? ` (${signal})` : ''}: ${Buffer.from(stderr.trim()).subarray(0, 2048).toString('utf8')}`));
      } else resolve(res);
    });
    if (input !== undefined) child.stdin!.end(input); else child.stdin!.end();
  });
}

export async function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<ExecResult> {
  const r = await runBuffer(cmd, args, opts);
  return { stdout: r.stdout.toString('utf8'), stderr: r.stderr, code: r.code };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns a truthy value or the timeout elapses. */
export async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs: number, intervalMs = 1000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try { const v = await fn(); if (v) return v as T; } catch (e) { lastErr = e; }
    await sleep(intervalMs);
  }
  const detail = lastErr ? [lastErr instanceof Error ? lastErr.message : String(lastErr), lastErr instanceof PhoneDockError ? lastErr.detail : undefined].filter(Boolean).join('\n') : undefined;
  throw new PhoneDockError(`Timed out waiting for ${what}.`, 'timeout', 504, undefined, detail);
}
