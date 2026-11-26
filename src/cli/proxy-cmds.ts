// `phonedock proxy ...` CLI subcommands. Accepts `-` for URLs to read from stdin so credentials stay out of shell history.
import type { PhoneDockClient, ProxyTestResult, ProxyView, DeviceProxyState } from '../sdk/client.ts';
import { table, type ParsedArgs } from './args.ts';

export const PROXY_USAGE =
  'proxy ls | add <name> <url|-> [--test] | test <url|id|-> | rm <id> | attach <device> <id> | detach <device> | show <device>';

async function readStdinLine(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const ch of process.stdin) chunks.push(Buffer.isBuffer(ch) ? ch : Buffer.from(ch));
  return Buffer.concat(chunks).toString('utf8').trim();
}

function fmtTest(r: ProxyTestResult | undefined): string {
  if (!r) return '';
  if (!r.ok) return `failed: ${r.error ?? 'error'} (${r.latencyMs} ms)`;
  const loc = [r.city, r.country].filter(Boolean).join(', ');
  return `${r.ip ?? '?'}${loc ? ` (${loc})` : ''}${r.org ? ` · ${r.org}` : ''} · ${r.latencyMs} ms`;
}

function fmtDeviceProxy(st: DeviceProxyState, name: string): string {
  if (!st.supported) return `${name}: proxy not supported (${st.reason ?? 'unsupported platform'})`;
  if (!st.proxy) return `${name}: no proxy attached`;
  const status = st.error ? `error: ${st.error}` : st.applied ? `active (127.0.0.1:${st.localPort})` : 'saved (applies on boot)';
  const exit = st.proxy.lastTest?.ok ? ` · exit ${fmtTest(st.proxy.lastTest)}` : '';
  return `${name}: ${st.proxy.name} [${st.proxy.id}] ${st.proxy.url} — ${status}${exit}${st.note ? `\n  ${st.note}` : ''}`;
}

async function resolveUrlArg(raw: string): Promise<string> {
  if (raw !== '-') return raw;
  const line = await readStdinLine();
  if (!line) throw new Error('Expected proxy URL on stdin');
  return line;
}

export async function proxyCmd(c: PhoneDockClient, a: ParsedArgs, jsonOut: boolean): Promise<number> {
  const p = a.positionals;
  const sub = (p[1] ?? 'ls').toLowerCase();
  const emit = (data: unknown, human?: () => string): void => {
    if (jsonOut || !human) { process.stdout.write(JSON.stringify(data ?? null, null, 2) + '\n'); return; }
    const s = human();
    process.stdout.write(s + (s.endsWith('\n') ? '' : '\n'));
  };

  switch (sub) {
    case 'ls': case 'list': {
      const list = await c.proxies();
      emit(list, () => list.length
        ? table(list.map((x: ProxyView) => ({
            id: x.id, name: x.name, url: x.url,
            exit: x.lastTest ? fmtTest(x.lastTest) : 'untested',
          })), ['id', 'name', 'url', 'exit'])
        : 'No saved proxies. Add one with: phonedock proxy add <name> <url|-> [--test]');
      return 0;
    }
    case 'add': {
      if (p.length < 4) throw new Error(`Usage: phonedock proxy add <name> <url|-> [--test]`);
      const name = p[2];
      const url = await resolveUrlArg(p[3]);
      const test = a.flags.test === true;
      const saved = await c.addProxy(name, url, { test });
      emit(saved, () => `Saved proxy ${saved.name} [${saved.id}] (${saved.url})${saved.lastTest ? `\n  test: ${fmtTest(saved.lastTest)}` : ''}`);
      return saved.lastTest && !saved.lastTest.ok ? 1 : 0;
    }
    case 'test': {
      if (p.length < 3) throw new Error('Usage: phonedock proxy test <url|id|->');
      const arg = await resolveUrlArg(p[2]);
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(arg)) {
        const res = await c.testProxyUrl(arg);
        emit(res, () => res.ok ? `OK: ${fmtTest(res)}` : `FAILED: ${fmtTest(res)}`);
        return res.ok ? 0 : 1;
      }
      const res = await c.testProxy(arg);
      emit(res, () => `${res.proxy.name} [${res.proxy.id}]: ${res.result.ok ? 'OK' : 'FAILED'} — ${fmtTest(res.result)}`);
      return res.result.ok ? 0 : 1;
    }
    case 'rm': case 'remove': case 'delete': {
      if (p.length < 3) throw new Error('Usage: phonedock proxy rm <id>');
      const res = await c.deleteProxy(p[2]);
      emit(res, () => `Removed proxy ${p[2]}${res.detachedDevices.length ? ` (detached from ${res.detachedDevices.length} device${res.detachedDevices.length === 1 ? '' : 's'})` : ''}`);
      return 0;
    }
    case 'attach': {
      if (p.length < 4) throw new Error('Usage: phonedock proxy attach <device> <proxyId>');
      const d = await c.resolveDevice(p[2]);
      const st = await c.attachProxy(d.id, p[3]);
      emit(st, () => fmtDeviceProxy(st, d.name));
      return 0;
    }
    case 'detach': {
      if (p.length < 3) throw new Error('Usage: phonedock proxy detach <device>');
      const d = await c.resolveDevice(p[2]);
      const st = await c.detachProxy(d.id);
      emit(st, () => fmtDeviceProxy(st, d.name));
      return 0;
    }
    case 'show': case 'status': {
      if (p.length < 3) throw new Error('Usage: phonedock proxy show <device>');
      const d = await c.resolveDevice(p[2]);
      const st = await c.deviceProxy(d.id);
      emit(st, () => fmtDeviceProxy(st, d.name));
      return 0;
    }
    default:
      throw new Error(`Unknown proxy subcommand "${sub}". Usage: phonedock ${PROXY_USAGE}`);
  }
}
