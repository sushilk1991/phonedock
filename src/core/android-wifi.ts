// Android Wireless debugging helpers: find phones on the LAN through macOS `dns-sd`, choose which one to pair or
// connect, and explain adb "No route to host" failures (macOS Local Network privacy).
// Parsing, choice and diagnosis are pure or take injected dependencies, so they are unit-tested without a network.
import { spawn } from 'node:child_process';
import { connect as tcpConnect } from 'node:net';
import { PhoneDockError } from './types.ts';

export const CONNECT_SERVICE = '_adb-tls-connect._tcp';
export const PAIRING_SERVICE = '_adb-tls-pairing._tcp';

/** One phone found on the network. `connected`: it is already in `adb devices`. */
export interface AndroidPhone {
  serial: string;
  model?: string;
  host?: string;           // mDNS host name, e.g. Android-7.local
  ip?: string;             // IPv4
  connectPort?: number;    // advertised while Wireless debugging is on
  pairingPort?: number;    // advertised only while "Pair device with pairing code" (or QR) is open on the phone
  connected: boolean;
  /** Bonjour instance names (for diagnostics and QR pairing). */
  connectInstance?: string;
  pairingInstance?: string;
}

export interface Resolved { host?: string; port?: number; txt: Record<string, string> }

// ── parsing (dns-sd output) ─────────────────────────────────────────────────

/** Instance names from `dns-sd -B` output (Add lines only; a name that was added and then removed is dropped). */
export function parseBrowse(out: string): string[] {
  const names = new Set<string>();
  for (const line of out.split('\n')) {
    const m = /^\s*\d+:\d+:\d+\.\d+\s+(Add|Rmv)\s+\d+\s+\d+\s+\S+\s+\S+\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    if (m[1] === 'Add') names.add(m[2]); else names.delete(m[2]);
  }
  return [...names];
}

/** `dns-sd -L` output: "… can be reached at Android-7.local.:44995 (interface 15)" then " api= name=V2246 v=1". */
export function parseLookup(out: string): Resolved {
  const res: Resolved = { txt: {} };
  const lines = out.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /can be reached at\s+(\S+?):(\d+)(?:\s|$)/.exec(lines[i]);
    if (!m) continue;
    res.host = m[1].replace(/\.$/, ''); res.port = Number(m[2]);
    // The TXT record follows on the next line; values may contain spaces, so a value runs up to the next " key=".
    const txt = (lines[i + 1] ?? '').trim();
    const keys = [...txt.matchAll(/(?:^|\s)([A-Za-z][\w.-]*)=/g)];
    keys.forEach((k, n) => {
      const start = k.index! + k[0].length;
      const end = n + 1 < keys.length ? keys[n + 1].index! : txt.length;
      res.txt[k[1]] = txt.slice(start, end).trim();
    });
    break;
  }
  return res;
}

/** First IPv4 address in `dns-sd -G v4` output. */
export function parseAddress(out: string): string | undefined {
  for (const line of out.split('\n')) {
    const m = /^\s*\d+:\d+:\d+\.\d+\s+Add\s+\S+\s+\d+\s+\S+\s+(\d{1,3}(?:\.\d{1,3}){3})\s/.exec(line + ' ');
    if (m) return m[1];
  }
  return undefined;
}

/** "adb-AB12CD34EF56789-x7q2pf" → "AB12CD34EF56789". Any other name (a QR pairing name) is its own identity. */
export function serialOf(instance: string): string {
  const clean = instance.replace(/\s\(\d+\)$/, '');
  const m = /^adb-(.+)-([A-Za-z0-9]+)$/.exec(clean);
  return m ? m[1] : clean;
}

/** The model name from a TXT record; adb shows underscores for spaces elsewhere, so do the same here. */
export function modelOf(txt: Record<string, string>): string | undefined {
  const n = txt.name?.trim();
  return n ? n.replace(/_/g, ' ') : undefined;
}

// ── combining ───────────────────────────────────────────────────────────────

export interface AdbEntry { serial: string; state: string }
export interface ServiceFound { type: 'connect' | 'pairing'; instance: string; resolved: Resolved; ip?: string }

/** True when the phone already shows up in `adb devices` as an online device (USB serial, ip:port, or mDNS name). */
export function isConnected(p: Pick<AndroidPhone, 'serial' | 'ip' | 'connectPort'>, adb: AdbEntry[]): boolean {
  return adb.some((d) => d.state === 'device' && (
    d.serial === p.serial || d.serial.startsWith(`adb-${p.serial}-`) ||
    (p.ip !== undefined && (d.serial === p.ip || (d.serial.startsWith(`${p.ip}:`) && (p.connectPort === undefined || d.serial === `${p.ip}:${p.connectPort}`))))));
}

/** Merge connect and pairing services of the same phone (same serial) into one entry each. */
export function mergeServices(found: ServiceFound[], adb: AdbEntry[]): AndroidPhone[] {
  const bySerial = new Map<string, AndroidPhone>();
  for (const s of found) {
    const serial = serialOf(s.instance);
    const p = bySerial.get(serial) ?? { serial, connected: false };
    p.host ??= s.resolved.host;
    p.ip ??= s.ip;
    p.model ??= modelOf(s.resolved.txt);
    if (s.type === 'connect') { p.connectPort = s.resolved.port; p.connectInstance = s.instance; }
    else { p.pairingPort = s.resolved.port; p.pairingInstance = s.instance; }
    bySerial.set(serial, p);
  }
  const list = [...bySerial.values()];
  for (const p of list) p.connected = isConnected(p, adb);
  return list.sort((a, b) => (a.model ?? a.serial).localeCompare(b.model ?? b.serial) || a.serial.localeCompare(b.serial));
}

// ── choosing ────────────────────────────────────────────────────────────────

export type Choice<T> = { kind: 'one'; phone: T } | { kind: 'none' } | { kind: 'many'; phones: T[] };

const sameSerial = (p: AndroidPhone, serial: string) => p.serial === serial || p.serial.toLowerCase() === serial.toLowerCase() || p.ip === serial;

/** Which phone to pair with: the only one showing a pairing screen, or the one named by `serial`. */
export function choosePairing(phones: AndroidPhone[], serial?: string): Choice<AndroidPhone> {
  const c = phones.filter((p) => p.pairingPort !== undefined && (!serial || sameSerial(p, serial)));
  return c.length === 0 ? { kind: 'none' } : c.length === 1 ? { kind: 'one', phone: c[0] } : { kind: 'many', phones: c };
}

/** Which phone to connect to: the one named by `serial`, else the only phone advertising Wireless debugging.
 *  Phones already connected are only considered when named explicitly. */
export function chooseConnect(phones: AndroidPhone[], serial?: string): Choice<AndroidPhone> {
  const c = phones.filter((p) => p.connectPort !== undefined && (serial ? sameSerial(p, serial) : !p.connected));
  return c.length === 0 ? { kind: 'none' } : c.length === 1 ? { kind: 'one', phone: c[0] } : { kind: 'many', phones: c };
}

/** After pairing `paired`, find its connect service: same serial, else (a QR pairing name differs) same IP. */
export function matchConnectService(phones: AndroidPhone[], paired: Pick<AndroidPhone, 'serial' | 'ip'>): AndroidPhone | undefined {
  return phones.find((p) => p.connectPort !== undefined && p.serial === paired.serial)
    ?? (paired.ip ? phones.find((p) => p.connectPort !== undefined && p.ip === paired.ip) : undefined);
}

export function describePhone(p: AndroidPhone): string {
  return `${p.model ?? 'Android phone'} (${p.serial}${p.ip ? `, ${p.ip}` : ''})`;
}

export const OPEN_PAIRING_HINT = 'Open Wireless debugging › Pair device with pairing code on the phone and keep it open';

export function noPairingError(serial?: string): PhoneDockError {
  return new PhoneDockError(
    serial ? `No pairing screen is open on ${serial}` : 'No phone is waiting to be paired',
    'no_pairing_service', 404, [OPEN_PAIRING_HINT, 'Phone and Mac must be on the same Wi-Fi'],
    'No _adb-tls-pairing._tcp service found. It is advertised only while the pairing dialog is open on the phone.');
}
export function manyPhonesError(what: 'pair' | 'connect', phones: AndroidPhone[]): PhoneDockError {
  const flag = phones.map((p) => `--serial ${p.serial}`).join(' or ');
  return new PhoneDockError(`More than one phone is available to ${what}`, 'ambiguous_phone', 409,
    [`Choose one: ${flag}`], phones.map(describePhone).join('\n'));
}
export function noConnectError(serial?: string): PhoneDockError {
  return new PhoneDockError(serial ? `${serial} isn’t advertising Wireless debugging` : 'No phone with Wireless debugging was found', 'no_connect_service', 404,
    ['Turn on Settings › Developer options › Wireless debugging on the phone', 'Phone and Mac must be on the same Wi-Fi'],
    'No _adb-tls-connect._tcp service found. Run `phonedock discover --android` to see what is visible.');
}

// ── Local Network diagnosis ─────────────────────────────────────────────────

export const isNoRoute = (out: string) => /no route to host|EHOSTUNREACH/i.test(out);

/** RFC 1918, link-local and mDNS names: the addresses macOS Local Network privacy covers. */
export function isPrivateHost(host: string): boolean {
  if (/\.local\.?$/i.test(host)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** Host part of "host:port" (IPv6 not supported by adb pair anyway). */
export function hostOf(address: string): string { return address.replace(/:\d+$/, ''); }

/** TCP connect from this process: does the daemon itself have a route to the phone? */
export function tcpProbe(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = tcpConnect({ host, port });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** The app macOS holds responsible for this process: a terminal when the daemon was started from one. */
export function responsibleApp(env: NodeJS.ProcessEnv = process.env): string {
  const t = env.TERM_PROGRAM;
  if (!t) return 'PhoneDock';
  const names: Record<string, string> = { Apple_Terminal: 'Terminal', 'iTerm.app': 'iTerm', vscode: 'Visual Studio Code', ghostty: 'Ghostty', WarpTerminal: 'Warp', WezTerm: 'WezTerm', Hyper: 'Hyper', Alacritty: 'Alacritty' };
  return names[t] ?? t;
}

export function blockedAdbError(host: string, afterRestart = false): PhoneDockError {
  return new PhoneDockError(
    afterRestart ? 'adb still can’t reach the phone after restarting' : 'adb can’t reach the phone, but PhoneDock can',
    'adb_blocked_local_network', 502,
    afterRestart ? ['Quit and reopen the app that started adb, or restart this Mac’s adb from PhoneDock.app'] : ['Restart adb and try again (restartAdb: true, CLI --restart-adb). This briefly disconnects other adb users, such as Android Studio.'],
    `The adb server on this Mac was started by an app that macOS doesn’t allow onto your local network (Local Network privacy), so it gets “No route to host” for ${host}, while PhoneDock’s own connection works.`);
}

export function permissionError(host: string, app = responsibleApp()): PhoneDockError {
  return new PhoneDockError(
    `${app} isn’t allowed to reach devices on your network`,
    'local_network_denied', 502,
    [`Open System Settings › Privacy & Security › Local Network and turn on ${app}`, 'Phone and Mac must be on the same Wi-Fi'],
    `macOS blocked a connection to ${host} (No route to host). ${app === 'PhoneDock' ? 'PhoneDock' : `The daemon was started from ${app}, so ${app}`} needs Local Network permission.`);
}

export interface DiagnoseDeps {
  probe: (host: string, port: number) => Promise<boolean>;
  restartAdb: () => Promise<void>;
  responsible?: () => string;
}

/**
 * Run one adb Wi-Fi command (`attempt` returns adb's output and whether it worked). On "No route to host" for a private
 * address, probe the phone from this process to tell the two causes apart. adb is only ever restarted when
 * `restartAdb` was asked for explicitly.
 * Returns the output on success; otherwise throws the diagnosis, or returns undefined with the failed output left to
 * the caller (`failure`) when the failure isn't a routing problem.
 */
export async function runWithDiagnosis(
  attempt: () => Promise<{ ok: boolean; out: string }>,
  target: { host: string; port: number },
  opts: { restartAdb?: boolean }, deps: DiagnoseDeps,
): Promise<{ ok: true; out: string } | { ok: false; out: string }> {
  let r = await attempt();
  if (r.ok) return { ok: true, out: r.out };
  if (!isNoRoute(r.out) || !isPrivateHost(target.host)) return { ok: false, out: r.out };
  const reachable = await deps.probe(target.host, target.port);
  if (!reachable) throw permissionError(target.host, (deps.responsible ?? responsibleApp)());
  if (!opts.restartAdb) throw blockedAdbError(target.host);
  await deps.restartAdb();
  r = await attempt();
  if (r.ok) return { ok: true, out: r.out };
  if (isNoRoute(r.out)) throw blockedAdbError(target.host, true);
  return { ok: false, out: r.out };
}

// ── dns-sd ──────────────────────────────────────────────────────────────────

/** Run `dns-sd <args>` and stop it after `ms` (or earlier when `until` matches the output). dns-sd never exits on its own,
 *  and only flushes piped output on SIGINT. */
export function dnsSd(args: string[], ms: number, until?: (out: string) => boolean): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    let finished = false;
    let child;
    try { child = spawn('/usr/bin/dns-sd', args, { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { resolve(''); return; }
    const stop = () => {
      if (finished) return; finished = true; clearTimeout(timer);
      child.once('close', () => resolve(out));
      child.kill('SIGINT');
      setTimeout(() => { child.kill('SIGKILL'); resolve(out); }, 700).unref();
    };
    const timer = setTimeout(stop, ms);
    child.on('error', () => { finished = true; clearTimeout(timer); resolve(''); });
    child.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
    if (until) child.stdout!.on('data', () => { if (until(out)) setTimeout(stop, 150); });
  });
}

export interface DiscoverDeps {
  browse: (type: string) => Promise<string[]>;
  lookup: (instance: string, type: string) => Promise<Resolved>;
  address: (host: string) => Promise<string | undefined>;
  adbDevices: () => Promise<AdbEntry[]>;
}

export const realDiscoverDeps = (browseMs = 2200): Omit<DiscoverDeps, 'adbDevices'> => ({
  browse: async (type) => parseBrowse(await dnsSd(['-B', type, 'local.'], browseMs)),
  lookup: async (instance, type) => parseLookup(await dnsSd(['-L', instance, type, 'local.'], 2000, (o) => { const r = parseLookup(o); return !!r.host && Object.keys(r.txt).length > 0; })),
  address: async (host) => parseAddress(await dnsSd(['-G', 'v4', host.replace(/\.?$/, '.')], 1500, (o) => parseAddress(o) !== undefined)),
});

/** Browse both service types, resolve every instance, and merge them per phone. */
export async function discoverAndroid(deps: DiscoverDeps): Promise<AndroidPhone[]> {
  const [connects, pairings, adb] = await Promise.all([deps.browse(CONNECT_SERVICE), deps.browse(PAIRING_SERVICE), deps.adbDevices().catch(() => [] as AdbEntry[])]);
  const todo = [...connects.map((i) => ({ type: 'connect' as const, instance: i })), ...pairings.map((i) => ({ type: 'pairing' as const, instance: i }))];
  const found = await Promise.all(todo.map(async (t): Promise<ServiceFound | undefined> => {
    const resolved = await deps.lookup(t.instance, t.type === 'connect' ? CONNECT_SERVICE : PAIRING_SERVICE);
    if (!resolved.host || !resolved.port) return undefined;
    return { ...t, resolved, ip: await deps.address(resolved.host) };
  }));
  return mergeServices(found.filter((f): f is ServiceFound => !!f), adb);
}
