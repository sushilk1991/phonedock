// Local 127.0.0.1-only HTTP proxy forwarder for Android devices (reached via `adb reverse`).
// Chains CONNECT and absolute-form plain HTTP requests exclusively to the configured upstream proxy.
import http from 'node:http';
import net from 'node:net';
import { formatHostForUrl, type ProxyEndpoint } from '../core/proxy.ts';
import { dialThroughProxy } from './proxy-tunnel.ts';

export interface ProxyForwarder {
  readonly port: number;
  close(): Promise<void>;
}

const DIAL_TIMEOUT_MS = 20_000;
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function parseAuthority(raw: string): { host: string; port: number } | null {
  const s = raw.trim();
  if (!s || /[\s\r\n]/.test(s)) return null;
  if (s.startsWith('[')) {
    const m = /^\[([^\]]+)\]:(\d+)$/.exec(s);
    if (!m) return null;
    const port = Number(m[2]);
    return port >= 1 && port <= 65535 ? { host: m[1], port } : null;
  }
  const idx = s.lastIndexOf(':');
  if (idx <= 0) return null;
  const host = s.slice(0, idx);
  const port = Number(s.slice(idx + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

function buildPlainHttpHeaders(req: http.IncomingMessage, extra: Record<string, string>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const conn = String(req.headers.connection ?? '');
  const connTokens = new Set(conn.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean));
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    const low = k.toLowerCase();
    if (low === 'proxy-authorization' || low === 'proxy-connection' || connTokens.has(low)) continue;
    if (low === 'connection') continue;
    if (low === 'keep-alive' || low === 'upgrade') continue;
    // Preserve transfer-encoding / content-length for request body framing.
    out[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) out[k] = v;
  return out;
}

function wireTunnel(a: net.Socket, b: net.Socket, onClose: () => void): void {
  let closed = false;
  const teardown = () => {
    if (closed) return;
    closed = true;
    a.destroy();
    b.destroy();
    onClose();
  };
  a.on('error', teardown);
  b.on('error', teardown);
  a.on('close', teardown);
  b.on('close', teardown);
  a.pipe(b);
  b.pipe(a);
}

/** Start a local HTTP proxy bound strictly to 127.0.0.1 on an ephemeral port, relaying only to `upstream`. */
export async function startProxyForwarder(upstream: ProxyEndpoint): Promise<ProxyForwarder> {
  const sockets = new Set<net.Socket>();
  const track = (s: net.Socket) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  };

  const server = http.createServer((req, res) => {
    void handlePlainHttp(req, res, upstream, track);
  });

  server.on('connection', (sock) => track(sock));

  server.on('connect', (req, clientSocket, head) => {
    track(clientSocket as net.Socket);
    void handleConnect(req, clientSocket as net.Socket, head, upstream, track);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    server.close();
    throw new Error('Failed to bind local proxy forwarder on 127.0.0.1');
  }

  return {
    port: addr.port,
    close(): Promise<void> {
      return new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        server.close(() => resolve());
      });
    },
  };
}

async function handleConnect(
  req: http.IncomingMessage,
  clientSocket: net.Socket,
  head: Buffer,
  upstream: ProxyEndpoint,
  track: (s: net.Socket) => void,
): Promise<void> {
  const target = parseAuthority(req.url ?? '');
  if (!target) {
    clientSocket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return;
  }

  let upstreamSocket: net.Socket | undefined;
  try {
    upstreamSocket = await dialThroughProxy(upstream, target.host, target.port, { timeoutMs: DIAL_TIMEOUT_MS });
    track(upstreamSocket);
    if (clientSocket.destroyed) {
      upstreamSocket.destroy();
      return;
    }
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) upstreamSocket.write(head);
    wireTunnel(clientSocket, upstreamSocket, () => {});
  } catch {
    upstreamSocket?.destroy();
    if (!clientSocket.destroyed) {
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    }
  }
}

async function handlePlainHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstream: ProxyEndpoint,
  track: (s: net.Socket) => void,
): Promise<void> {
  let targetUrl: URL;
  try {
    targetUrl = new URL(req.url ?? '');
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain', Connection: 'close' });
    res.end('Absolute HTTP URL required');
    return;
  }
  if (targetUrl.protocol !== 'http:') {
    res.writeHead(400, { 'Content-Type': 'text/plain', Connection: 'close' });
    res.end('Only http:// URLs or CONNECT tunnels are supported');
    return;
  }

  const targetPort = targetUrl.port ? Number(targetUrl.port) : 80;
  const hostHeader = targetUrl.port ? `${formatHostForUrl(targetUrl.hostname)}:${targetUrl.port}` : formatHostForUrl(targetUrl.hostname);

  if (upstream.scheme === 'http') {
    // Chain directly to upstream HTTP proxy in absolute-form with upstream Proxy-Authorization.
    const extra: Record<string, string> = { Host: hostHeader, Connection: 'close' };
    if (upstream.username !== undefined || upstream.password !== undefined) {
      const cred = Buffer.from(`${upstream.username ?? ''}:${upstream.password ?? ''}`, 'utf8').toString('base64');
      extra['Proxy-Authorization'] = `Basic ${cred}`;
    }
    const headers = buildPlainHttpHeaders(req, extra);
    const upReq = http.request({
      host: upstream.host,
      port: upstream.port,
      method: req.method,
      path: targetUrl.toString(),
      headers,
      timeout: DIAL_TIMEOUT_MS,
    }, (upRes) => {
      const respHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (v !== undefined && !HOP_BY_HOP.has(k.toLowerCase())) respHeaders[k] = v;
      }
      res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, respHeaders);
      upRes.pipe(res);
    });
    upReq.on('socket', (s) => track(s));
    upReq.on('timeout', () => upReq.destroy(new Error('upstream proxy timed out')));
    upReq.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain', Connection: 'close' });
        res.end('Bad Gateway');
      } else {
        res.destroy();
      }
    });
    req.pipe(upReq);
    return;
  }

  // Upstream is SOCKS5 / SOCKS5H: dial target through SOCKS5 and forward via Node's HTTP client for clean framing.
  let upstreamSocket: net.Socket | undefined;
  try {
    upstreamSocket = await dialThroughProxy(upstream, targetUrl.hostname, targetPort, { timeoutMs: DIAL_TIMEOUT_MS });
    track(upstreamSocket);
    const headers = buildPlainHttpHeaders(req, { Host: hostHeader, Connection: 'close' });
    const originPath = `${targetUrl.pathname || '/'}${targetUrl.search || ''}`;
    const sock = upstreamSocket;
    const upReq = http.request({
      method: req.method,
      path: originPath,
      headers,
      createConnection: () => sock,
      timeout: DIAL_TIMEOUT_MS,
    }, (upRes) => {
      const respHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (v !== undefined && !HOP_BY_HOP.has(k.toLowerCase())) respHeaders[k] = v;
      }
      res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, respHeaders);
      upRes.pipe(res);
    });
    upReq.on('timeout', () => upReq.destroy(new Error('upstream proxy timed out')));
    upReq.on('error', () => {
      sock.destroy();
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain', Connection: 'close' });
        res.end('Bad Gateway');
      } else {
        res.destroy();
      }
    });
    req.pipe(upReq);
  } catch {
    upstreamSocket?.destroy();
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain', Connection: 'close' });
      res.end('Bad Gateway');
    }
  }
}
