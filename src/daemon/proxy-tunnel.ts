// Zero-dependency HTTP CONNECT and SOCKS5/SOCKS5H tunnel clients + live IP-echo proxy tester.
// Implements RFC 9110 CONNECT (Basic Proxy-Authorization), RFC 1928 (SOCKS5), and RFC 1929 (SOCKS5 user/pass).
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import { PhoneDockError } from '../core/types.ts';
import { formatHostForUrl, redactProxySecrets, type ProxyEndpoint, type ProxyTestResult } from '../core/proxy.ts';

export interface DialOptions {
  timeoutMs?: number;
}

export interface EchoEndpoint {
  url: string;
}

export interface TestProxyOptions {
  timeoutMs?: number;
  endpoints?: EchoEndpoint[];
  /** Test-only TLS options for local fake HTTPS echo servers. */
  ca?: string | Buffer;
  rejectUnauthorized?: boolean;
}

const DEFAULT_DIAL_TIMEOUT_MS = 15_000;
const DEFAULT_TEST_TIMEOUT_MS = 12_000;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_ECHO_BYTES = 64 * 1024;

export const DEFAULT_ECHO_ENDPOINTS: readonly EchoEndpoint[] = [
  { url: 'https://ipinfo.io/json' },
  { url: 'https://api.ipify.org?format=json' },
];

const SOCKS5_ERRORS: Record<number, string> = {
  1: 'general SOCKS server failure',
  2: 'connection not allowed by ruleset',
  3: 'network unreachable',
  4: 'host unreachable',
  5: 'connection refused by destination',
  6: 'TTL expired',
  7: 'command not supported',
  8: 'address type not supported',
};

function proxySecretsOf(p: ProxyEndpoint): string[] {
  const list: string[] = [];
  if (p.password) list.push(p.password);
  if (p.username !== undefined && p.password !== undefined) {
    list.push(`${p.username}:${p.password}`);
    list.push(Buffer.from(`${p.username}:${p.password}`, 'utf8').toString('base64'));
  }
  return list;
}

function scrub(msg: string, p: ProxyEndpoint): string {
  return redactProxySecrets(msg, proxySecretsOf(p));
}

/** Buffered reader over a net.Socket that preserves unread trailing bytes via socket.unshift() on release. */
class SocketReader {
  private readonly socket: net.Socket;
  private buf: Buffer = Buffer.alloc(0);
  private ended = false;
  private err: Error | null = null;
  private waiter: (() => void) | null = null;
  private readonly onData: (chunk: Buffer) => void;
  private readonly onEnd: () => void;
  private readonly onError: (e: Error) => void;

  constructor(socket: net.Socket) {
    this.socket = socket;
    this.onData = (chunk: Buffer) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      this.wake();
    };
    this.onEnd = () => { this.ended = true; this.wake(); };
    this.onError = (e: Error) => { this.err = e; this.ended = true; this.wake(); };
    socket.on('data', this.onData);
    socket.on('end', this.onEnd);
    socket.on('close', this.onEnd);
    socket.on('error', this.onError);
  }

  private wake() {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  private waitMore(): Promise<void> {
    if (this.err) return Promise.reject(this.err);
    if (this.ended) return Promise.reject(new Error('unexpected EOF from proxy'));
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  async readExact(n: number): Promise<Buffer> {
    while (this.buf.length < n) {
      await this.waitMore();
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  async readUntil(delimiter: Buffer, maxBytes: number): Promise<Buffer> {
    while (true) {
      const idx = this.buf.indexOf(delimiter);
      if (idx >= 0) {
        const end = idx + delimiter.length;
        const out = this.buf.subarray(0, end);
        this.buf = this.buf.subarray(end);
        return out;
      }
      if (this.buf.length > maxBytes) {
        throw new Error(`proxy response exceeded ${maxBytes} bytes`);
      }
      await this.waitMore();
    }
  }

  /** Detach listeners and return any buffered leftover bytes to the socket stream. */
  release(): void {
    this.socket.off('data', this.onData);
    this.socket.off('end', this.onEnd);
    this.socket.off('close', this.onEnd);
    this.socket.off('error', this.onError);
    if (this.buf.length > 0) {
      const rest = this.buf;
      this.buf = Buffer.alloc(0);
      this.socket.unshift(rest);
    }
  }
}

function connectTcp(host: string, port: number, deadlineMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) { reject(new Error('timed out connecting to proxy')); return; }
    const socket = net.createConnection({ host, port });
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      socket.destroy();
      reject(new Error('timed out connecting to proxy'));
    }, remaining);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('error', onError);
    };
    const onConnect = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve(socket);
    };
    const onError = (e: Error) => {
      if (done) return;
      done = true;
      cleanup();
      socket.destroy();
      reject(e);
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

function ipv4ToBytes(ip: string): Buffer {
  return Buffer.from(ip.split('.').map((o) => Number(o)));
}

function ipv6ToBytes(ip: string): Buffer {
  const bare = ip.includes('%') ? ip.slice(0, ip.indexOf('%')) : ip;
  const halves = bare.split('::');
  const parsePart = (part: string): number[] => {
    if (!part) return [];
    const tokens = part.split(':');
    const out: number[] = [];
    for (const tok of tokens) {
      if (tok.includes('.')) {
        const v4 = ipv4ToBytes(tok);
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else {
        out.push(parseInt(tok, 16));
      }
    }
    return out;
  };
  const left = parsePart(halves[0]);
  const right = halves.length > 1 ? parsePart(halves[1]) : [];
  const zeros = Math.max(0, 8 - left.length - right.length);
  const groups = [...left, ...new Array<number>(zeros).fill(0), ...right];
  const buf = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) buf.writeUInt16BE(groups[i] ?? 0, i * 2);
  return buf;
}

async function encodeSocks5Address(scheme: 'socks5' | 'socks5h', targetHost: string): Promise<Buffer> {
  const bare = targetHost.startsWith('[') && targetHost.endsWith(']') ? targetHost.slice(1, -1) : targetHost;
  const ipKind = net.isIP(bare);
  if (ipKind === 4) {
    return Buffer.concat([Buffer.from([0x01]), ipv4ToBytes(bare)]);
  }
  if (ipKind === 6) {
    return Buffer.concat([Buffer.from([0x04]), ipv6ToBytes(bare)]);
  }
  if (scheme === 'socks5') {
    const resolved = await lookup(bare);
    if (resolved.family === 4) {
      return Buffer.concat([Buffer.from([0x01]), ipv4ToBytes(resolved.address)]);
    }
    return Buffer.concat([Buffer.from([0x04]), ipv6ToBytes(resolved.address)]);
  }
  const hostBuf = Buffer.from(bare, 'utf8');
  if (hostBuf.length === 0 || hostBuf.length > 255) {
    throw new PhoneDockError('Target host name is too long for SOCKS5', 'bad_request', 400);
  }
  return Buffer.concat([Buffer.from([0x03, hostBuf.length]), hostBuf]);
}

async function negotiateHttpConnect(socket: net.Socket, proxy: ProxyEndpoint, targetHost: string, targetPort: number): Promise<void> {
  const reader = new SocketReader(socket);
  try {
    const target = `${formatHostForUrl(targetHost)}:${targetPort}`;
    const headers = [
      `CONNECT ${target} HTTP/1.1`,
      `Host: ${target}`,
      'Proxy-Connection: Keep-Alive',
    ];
    if (proxy.username !== undefined || proxy.password !== undefined) {
      const cred = Buffer.from(`${proxy.username ?? ''}:${proxy.password ?? ''}`, 'utf8').toString('base64');
      headers.push(`Proxy-Authorization: Basic ${cred}`);
    }
    socket.write(headers.join('\r\n') + '\r\n\r\n');

    const raw = await reader.readUntil(Buffer.from('\r\n\r\n'), MAX_HEADER_BYTES);
    const firstLine = raw.toString('latin1').split('\r\n', 1)[0] ?? '';
    const m = /^HTTP\/1\.[01]\s+(\d{3})(?:\s+(.*))?$/i.exec(firstLine);
    if (!m) {
      throw new PhoneDockError('Proxy returned an invalid HTTP CONNECT response', 'proxy_connect_failed', 502, undefined, scrub(firstLine, proxy));
    }
    const status = Number(m[1]);
    if (status === 407) {
      throw new PhoneDockError('Proxy authentication failed', 'proxy_auth_failed', 502, ['Check the proxy username and password.'], `HTTP 407 ${m[2] ?? ''}`.trim());
    }
    if (status !== 200) {
      throw new PhoneDockError(`Proxy refused CONNECT (HTTP ${status})`, 'proxy_connect_failed', 502, undefined, scrub(firstLine, proxy));
    }
  } finally {
    reader.release();
  }
}

async function negotiateSocks5(socket: net.Socket, proxy: ProxyEndpoint, targetHost: string, targetPort: number): Promise<void> {
  const reader = new SocketReader(socket);
  try {
    const hasAuth = proxy.username !== undefined || proxy.password !== undefined;
    socket.write(hasAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]));

    const methodReply = await reader.readExact(2);
    if (methodReply[0] !== 0x05) {
      throw new PhoneDockError(`Proxy is not a SOCKS5 server (version ${methodReply[0]})`, 'proxy_connect_failed', 502);
    }
    const method = methodReply[1];
    if (method === 0xff) {
      throw new PhoneDockError('Proxy rejected authentication methods', 'proxy_auth_failed', 502, ['Check whether this SOCKS5 proxy requires a username and password.']);
    }
    if (method === 0x02) {
      const userBuf = Buffer.from(proxy.username ?? '', 'utf8');
      const passBuf = Buffer.from(proxy.password ?? '', 'utf8');
      if (userBuf.length > 255 || passBuf.length > 255) {
        throw new PhoneDockError('Proxy credentials exceed SOCKS5 255-byte limit', 'bad_request', 400);
      }
      socket.write(Buffer.concat([Buffer.from([0x01, userBuf.length]), userBuf, Buffer.from([passBuf.length]), passBuf]));
      const authReply = await reader.readExact(2);
      if (authReply[0] !== 0x01 || authReply[1] !== 0x00) {
        throw new PhoneDockError('SOCKS5 proxy authentication failed', 'proxy_auth_failed', 502, ['Check the proxy username and password.']);
      }
    } else if (method !== 0x00) {
      throw new PhoneDockError(`SOCKS5 proxy selected unsupported auth method 0x${method.toString(16)}`, 'proxy_connect_failed', 502);
    }

    const addrBuf = await encodeSocks5Address(proxy.scheme === 'socks5' ? 'socks5' : 'socks5h', targetHost);
    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(targetPort, 0);
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addrBuf, portBuf]));

    const repHead = await reader.readExact(4);
    if (repHead[0] !== 0x05) {
      throw new PhoneDockError('Invalid SOCKS5 connect reply', 'proxy_connect_failed', 502);
    }
    if (repHead[1] !== 0x00) {
      const reason = SOCKS5_ERRORS[repHead[1]] ?? `error code 0x${repHead[1].toString(16)}`;
      throw new PhoneDockError(`SOCKS5 proxy failed to connect: ${reason}`, 'proxy_connect_failed', 502);
    }

    const atyp = repHead[3];
    if (atyp === 0x01) await reader.readExact(4 + 2);
    else if (atyp === 0x04) await reader.readExact(16 + 2);
    else if (atyp === 0x03) {
      const len = (await reader.readExact(1))[0];
      await reader.readExact(len + 2);
    } else {
      throw new PhoneDockError(`Invalid SOCKS5 bound address type ${atyp}`, 'proxy_connect_failed', 502);
    }
  } finally {
    reader.release();
  }
}

/** Establish a TCP tunnel through an HTTP or SOCKS5/SOCKS5H proxy to targetHost:targetPort. */
export async function dialThroughProxy(proxy: ProxyEndpoint, targetHost: string, targetPort: number, opts: DialOptions = {}): Promise<net.Socket> {
  const timeoutMs = Math.max(100, opts.timeoutMs ?? DEFAULT_DIAL_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  let socket: net.Socket | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    socket = await connectTcp(proxy.host, proxy.port, deadline);
    const remaining = Math.max(50, deadline - Date.now());
    const negotiation = (async () => {
      if (proxy.scheme === 'http') {
        await negotiateHttpConnect(socket!, proxy, targetHost, targetPort);
      } else {
        await negotiateSocks5(socket!, proxy, targetHost, targetPort);
      }
    })();
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => {
        socket?.destroy(new Error('proxy handshake timed out'));
        reject(new PhoneDockError('Timed out waiting for proxy handshake', 'proxy_timeout', 504));
      }, remaining);
      timer.unref?.();
      negotiation.then(resolve, reject);
    });
    if (timer) clearTimeout(timer);
    return socket;
  } catch (e) {
    if (timer) clearTimeout(timer);
    socket?.destroy();
    if (e instanceof PhoneDockError) {
      e.message = scrub(e.message, proxy);
      if (e.detail) e.detail = scrub(e.detail, proxy);
      throw e;
    }
    const msg = scrub((e as Error)?.message ?? String(e), proxy);
    if (/timed out/i.test(msg)) {
      throw new PhoneDockError('Timed out connecting to proxy', 'proxy_timeout', 504, undefined, msg);
    }
    throw new PhoneDockError(`Couldn't connect through proxy: ${msg}`, 'proxy_connect_failed', 502, undefined, msg);
  }
}

function decodeChunkedBody(raw: Buffer): Buffer {
  const parts: Buffer[] = [];
  let pos = 0;
  while (pos < raw.length) {
    const crlf = raw.indexOf('\r\n', pos);
    if (crlf < 0) break;
    const sizeHex = raw.subarray(pos, crlf).toString('latin1').split(';', 1)[0].trim();
    const size = parseInt(sizeHex, 16);
    if (!Number.isFinite(size) || size < 0) break;
    pos = crlf + 2;
    if (size === 0) break;
    if (pos + size > raw.length) {
      parts.push(raw.subarray(pos));
      break;
    }
    parts.push(raw.subarray(pos, pos + size));
    pos += size + 2;
  }
  return Buffer.concat(parts);
}

async function fetchJsonViaProxy(proxy: ProxyEndpoint, endpointUrl: string, opts: TestProxyOptions): Promise<Record<string, unknown>> {
  const parsed = new URL(endpointUrl);
  const isHttps = parsed.protocol === 'https:';
  const port = parsed.port ? Number(parsed.port) : (isHttps ? 443 : 80);
  const timeoutMs = Math.max(200, opts.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;

  const rawSocket = await dialThroughProxy(proxy, parsed.hostname, port, { timeoutMs });
  let stream: net.Socket | tls.TLSSocket = rawSocket;

  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error, data?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.destroy();
      rawSocket.destroy();
      if (err) reject(err);
      else resolve(data!);
    };
    const remaining = Math.max(50, deadline - Date.now());
    const timer = setTimeout(() => finish(new PhoneDockError('Timed out waiting for proxy test response', 'proxy_timeout', 504)), remaining);
    timer.unref?.();

    const startHttp = (s: net.Socket | tls.TLSSocket) => {
      const chunks: Buffer[] = [];
      let total = 0;
      s.on('data', (d: Buffer) => {
        total += d.length;
        if (total > MAX_ECHO_BYTES) {
          finish(new Error('echo response exceeded size limit'));
          return;
        }
        chunks.push(d);
      });
      s.on('error', (e: Error) => finish(e));
      s.on('end', () => {
        try {
          const all = Buffer.concat(chunks);
          const sep = all.indexOf('\r\n\r\n');
          if (sep < 0) { finish(new Error('incomplete HTTP response from echo server')); return; }
          const headText = all.subarray(0, sep).toString('latin1');
          const lines = headText.split('\r\n');
          const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})/.exec(lines[0] ?? '');
          const status = statusMatch ? Number(statusMatch[1]) : 0;
          if (status < 200 || status >= 300) {
            finish(new Error(`echo server returned HTTP ${status || 'invalid'}`));
            return;
          }
          const headers = new Map<string, string>();
          for (const line of lines.slice(1)) {
            const idx = line.indexOf(':');
            if (idx > 0) headers.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
          }
          let body: Buffer = all.subarray(sep + 4);
          if (/chunked/i.test(headers.get('transfer-encoding') ?? '')) {
            body = decodeChunkedBody(body);
          }
          const json = JSON.parse(body.toString('utf8')) as unknown;
          if (!json || typeof json !== 'object' || Array.isArray(json)) {
            finish(new Error('echo server did not return a JSON object'));
            return;
          }
          finish(undefined, json as Record<string, unknown>);
        } catch (e) {
          finish(e as Error);
        }
      });

      const hostHeader = parsed.port ? `${formatHostForUrl(parsed.hostname)}:${parsed.port}` : formatHostForUrl(parsed.hostname);
      const path = `${parsed.pathname || '/'}${parsed.search || ''}`;
      s.write([
        `GET ${path} HTTP/1.1`,
        `Host: ${hostHeader}`,
        'User-Agent: PhoneDock/0.7',
        'Accept: application/json',
        'Connection: close',
        '',
        '',
      ].join('\r\n'));
    };

    if (isHttps) {
      const tlsSock = tls.connect({
        socket: rawSocket,
        servername: net.isIP(parsed.hostname) ? undefined : parsed.hostname,
        rejectUnauthorized: opts.rejectUnauthorized ?? true,
        ...(opts.ca ? { ca: opts.ca } : {}),
      });
      stream = tlsSock;
      tlsSock.once('error', (e: Error) => finish(e));
      tlsSock.once('secureConnect', () => startHttp(tlsSock));
    } else {
      startHttp(rawSocket);
    }
  });
}

/** Test a proxy by fetching an HTTPS IP-echo endpoint through it; reports exit IP, country/city/org, and latency. */
export async function testProxy(proxy: ProxyEndpoint, opts: TestProxyOptions = {}): Promise<ProxyTestResult> {
  const endpoints = opts.endpoints?.length ? opts.endpoints : DEFAULT_ECHO_ENDPOINTS;
  const started = performance.now();
  let lastError = 'Proxy test failed';

  for (const ep of endpoints) {
    const t0 = performance.now();
    try {
      const data = await fetchJsonViaProxy(proxy, ep.url, opts);
      const ip = typeof data.ip === 'string' && data.ip.trim() ? data.ip.trim() : undefined;
      if (!ip) {
        lastError = 'Echo server response did not contain an exit IP';
        continue;
      }
      const country = typeof data.country === 'string' && data.country.trim() ? data.country.trim() : undefined;
      const city = typeof data.city === 'string' && data.city.trim() ? data.city.trim() : undefined;
      const org = typeof data.org === 'string' && data.org.trim() ? data.org.trim() : undefined;
      return {
        ok: true,
        ip,
        ...(country ? { country } : {}),
        ...(city ? { city } : {}),
        ...(org ? { org } : {}),
        latencyMs: Math.max(1, Math.round(performance.now() - t0)),
        at: new Date().toISOString(),
      };
    } catch (e) {
      const pe = e instanceof PhoneDockError ? e : undefined;
      lastError = scrub(pe ? pe.message : ((e as Error)?.message ?? String(e)), proxy);
      // Auth failures won't succeed on a fallback echo server.
      if (pe?.code === 'proxy_auth_failed') break;
    }
  }

  return {
    ok: false,
    latencyMs: Math.max(1, Math.round(performance.now() - started)),
    at: new Date().toISOString(),
    error: lastError,
  };
}
