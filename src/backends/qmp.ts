// Minimal QMP (QEMU Machine Protocol) client over a unix socket. No deps.
// QEMU's QMP chardev serves one client at a time, so calls per socket are serialized by a promise chain
// and every call uses a short-lived connection (robust across daemon restarts and VM reboots).
import { createConnection } from 'node:net';
import { PhoneDockError } from '../core/types.ts';

const chains = new Map<string, Promise<unknown>>();

/** Serialize work per QMP socket path. */
function serialize<T>(sock: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(sock) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  chains.set(sock, next.catch(() => {}));
  return next;
}

export interface QmpCommand { execute: string; arguments?: Record<string, unknown> }

/** Run one or more QMP commands on a fresh connection; returns each command's `return` value. */
export function qmpBatch(sock: string, cmds: QmpCommand[], timeoutMs = 15_000): Promise<unknown[]> {
  return serialize(sock, () => new Promise<unknown[]>((resolve, reject) => {
    const conn = createConnection(sock);
    const results: unknown[] = [];
    let buf = '';
    let stage = -1; // -1 = waiting greeting, 0 = waiting caps reply, 1..n = waiting cmd[i-1]
    let done = false;
    const finish = (err?: Error) => {
      if (done) return; done = true; clearTimeout(timer); conn.destroy();
      if (err) reject(err); else resolve(results);
    };
    const timer = setTimeout(() => finish(new PhoneDockError("The virtual device action timed out", 'timeout', 504, undefined, `QMP timeout (${cmds.map((c) => c.execute).join(',')})`)), timeoutMs);
    const send = (o: unknown) => conn.write(JSON.stringify(o) + '\n');
    conn.on('error', (e) => finish(new PhoneDockError("Couldn’t connect to the virtual device", 'qmp_unavailable', 409, undefined, `QMP connect ${sock}: ${e.message}`)));
    conn.on('close', () => { if (!done) finish(new PhoneDockError("The virtual device connection closed", 'qmp_closed', 500, undefined, 'QMP connection closed')); });
    conn.on('data', (d) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let msg: Record<string, any>;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.event) continue; // async events are ignored
        if (stage === -1) { if (msg.QMP) { stage = 0; send({ execute: 'qmp_capabilities' }); } continue; }
        if (msg.error) { finish(new PhoneDockError("Couldn’t complete the virtual device action", 'qmp_error', 500, undefined, `QMP ${stage === 0 ? 'qmp_capabilities' : cmds[stage - 1].execute}: ${msg.error.desc ?? msg.error.class}`)); return; }
        if (stage > 0) results.push(msg.return);
        if (stage < cmds.length) { send(cmds[stage]); stage++; } else { finish(); return; }
      }
    });
  }));
}

export async function qmp<T = unknown>(sock: string, execute: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
  const [r] = await qmpBatch(sock, [{ execute, ...(args ? { arguments: args } : {}) }], timeoutMs);
  return r as T;
}

/** Run an HMP (human monitor) command through QMP; throws if the output looks like an error. */
export async function hmp(sock: string, commandLine: string, timeoutMs = 120_000): Promise<string> {
  const out = String(await qmp<string>(sock, 'human-monitor-command', { 'command-line': commandLine }, timeoutMs) ?? '');
  if (/^(Error|error)[: ]|Could not|does not support|not supported|No block device/m.test(out)) {
    throw new PhoneDockError("Couldn’t complete the virtual device action", 'hmp_error', 409, undefined, `${commandLine.split(' ')[0]}: ${out.trim()}`);
  }
  return out;
}
