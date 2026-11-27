// `phonedock passcode ...` and `phonedock unlock <device>` CLI subcommands.
// Passcodes are read only from masked TTY input or `--stdin` (never as CLI arguments) so they stay out of shell history and `ps`.
import type { PasscodeStatus, PhoneDockClient } from '../sdk/client.ts';
import type { ParsedArgs } from './args.ts';

export const PASSCODE_USAGE =
  'passcode set <device> [--stdin] [--disabled] | status <device> | enable <device> | disable <device> | rm <device>';

async function readStdinPasscode(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const ch of process.stdin) chunks.push(Buffer.isBuffer(ch) ? ch : Buffer.from(ch));
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function promptPasscode(label: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return readStdinPasscode();
  }
  return new Promise<string>((resolve, reject) => {
    const stdin = process.stdin;
    const stderr = process.stderr;
    stderr.write(label);
    const wasRaw = Boolean(stdin.isRaw);
    stdin.setRawMode?.(true);
    stdin.resume();
    let buf = '';
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode?.(wasRaw);
      stdin.pause();
    };
    const onData = (chunk: Buffer | string) => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const ch of s) {
        if (ch === '\u0003') { // Ctrl-C
          cleanup();
          stderr.write('\n');
          reject(new Error('Cancelled'));
          return;
        }
        if (ch === '\r' || ch === '\n') {
          cleanup();
          stderr.write('\n');
          resolve(buf);
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (buf.length > 0) buf = buf.slice(0, -1);
          continue;
        }
        if (ch >= '\x20' && ch <= '\x7e') {
          buf += ch;
        }
      }
    };
    stdin.on('data', onData);
  });
}

function fmtStatus(st: PasscodeStatus, deviceName: string): string {
  if (!st.supported) return `${deviceName}: unattended unlock not supported — ${st.reason ?? 'unsupported device'}`;
  if (!st.hasPasscode) return `${deviceName}: no passcode saved (unattended unlock off).`;
  const where = st.storage === 'keychain' ? 'macOS Keychain' : 'local 0600 store';
  const lines: string[] = [];
  if (st.tripped) {
    lines.push(`${deviceName}: PAUSED (circuit breaker tripped at ${st.tripped.at}) — ${st.tripped.reason}`);
    lines.push('  Re-save the passcode with `phonedock passcode set <device>` to re-enable.');
  } else {
    lines.push(`${deviceName}: passcode saved in ${where} — unattended unlock ${st.enabled ? 'ON' : 'OFF'}`);
  }
  if (st.lastUnlock) {
    lines.push(`  last unlock: ${st.lastUnlock.ok ? 'OK' : 'FAILED'}${st.lastUnlock.method ? ` (${st.lastUnlock.method})` : ''}${st.lastUnlock.error ? ` — ${st.lastUnlock.error}` : ''} at ${st.lastUnlock.at}`);
  }
  return lines.join('\n');
}

export async function passcodeCmd(c: PhoneDockClient, a: ParsedArgs, jsonOut: boolean): Promise<number> {
  const p = a.positionals;
  const sub = (p[1] ?? '').toLowerCase();
  const emit = (data: unknown, human?: () => string): void => {
    if (jsonOut || !human) { process.stdout.write(JSON.stringify(data ?? null, null, 2) + '\n'); return; }
    const s = human();
    process.stdout.write(s + (s.endsWith('\n') ? '' : '\n'));
  };

  switch (sub) {
    case 'set': case 'save': {
      if (p.length < 3) throw new Error('Usage: phonedock passcode set <device> [--stdin] [--disabled]');
      if (p.length > 3) throw new Error('Do not pass the passcode as a CLI argument (it would be saved in shell history). Omit it to be prompted, or pipe it with --stdin.');
      const d = await c.resolveDevice(p[2]);
      const passcode = a.flags.stdin === true
        ? await readStdinPasscode()
        : await promptPasscode(`Enter passcode for ${d.name} (hidden): `);
      if (!passcode) throw new Error('Passcode cannot be empty');
      const enabled = a.flags.disabled === true ? false : true;
      const st = await c.setPasscode(d.id, { passcode, enabled });
      emit(st, () => fmtStatus(st, d.name));
      return 0;
    }
    case 'status': case 'show': {
      if (p.length < 3) throw new Error('Usage: phonedock passcode status <device>');
      const d = await c.resolveDevice(p[2]);
      const st = await c.passcodeStatus(d.id);
      emit(st, () => fmtStatus(st, d.name));
      return 0;
    }
    case 'enable': case 'on': {
      if (p.length < 3) throw new Error('Usage: phonedock passcode enable <device>');
      const d = await c.resolveDevice(p[2]);
      const st = await c.setPasscode(d.id, { enabled: true });
      emit(st, () => fmtStatus(st, d.name));
      return 0;
    }
    case 'disable': case 'off': {
      if (p.length < 3) throw new Error('Usage: phonedock passcode disable <device>');
      const d = await c.resolveDevice(p[2]);
      const st = await c.setPasscode(d.id, { enabled: false });
      emit(st, () => fmtStatus(st, d.name));
      return 0;
    }
    case 'rm': case 'remove': case 'delete': {
      if (p.length < 3) throw new Error('Usage: phonedock passcode rm <device>');
      const d = await c.resolveDevice(p[2]);
      const res = await c.removePasscode(d.id);
      emit(res, () => res.removed ? `Removed saved passcode for ${d.name}.` : `No passcode was saved for ${d.name}.`);
      return 0;
    }
    default:
      throw new Error(`Unknown passcode subcommand "${sub}". Usage: phonedock ${PASSCODE_USAGE}`);
  }
}

export async function unlockCmd(c: PhoneDockClient, a: ParsedArgs, jsonOut: boolean): Promise<number> {
  const p = a.positionals;
  if (p.length < 2) throw new Error('Usage: phonedock unlock <device>');
  const d = await c.resolveDevice(p[1]);
  const res = await c.unlock(d.id);
  if (jsonOut) {
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
  } else {
    const detail = res.alreadyUnlocked ? 'already unlocked' : `unlocked${res.method ? ` (${res.method})` : ''}`;
    process.stdout.write(`${d.name}: ${detail}\n`);
  }
  return 0;
}
