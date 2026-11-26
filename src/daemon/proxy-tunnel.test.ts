import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { parseProxyUrl, redactProxySecrets, redactProxyUrl, toProxyView } from '../core/proxy.ts';
import { dialThroughProxy, testProxy } from './proxy-tunnel.ts';
import { startProxyForwarder } from './proxy-forwarder.ts';

// ── helpers: local fake servers (no network) ────────────────────────────────

async function startEchoServer(payload: Record<string, unknown>, opts: { status?: number } = {}) {
  const srv = http.createServer((_req, res) => {
    const body = JSON.stringify(payload);
    res.writeHead(opts.status ?? 200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as net.AddressInfo).port;
  return { port, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

async function startFakeHttpProxy(opts: { expectedAuth?: string; hang?: boolean } = {}) {
  let connectCount = 0;
  let plainCount = 0;
  const sockets = new Set<net.Socket>();
  const srv = http.createServer((req, res) => {
    plainCount++;
    if (opts.expectedAuth) {
      const want = `Basic ${Buffer.from(opts.expectedAuth).toString('base64')}`;
      if (req.headers['proxy-authorization'] !== want) {
        res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="test"' });
        res.end('Proxy auth required');
        return;
      }
    }
    const target = new URL(req.url!);
    const up = http.request({
      host: target.hostname,
      port: Number(target.port || 80),
      method: req.method,
      path: `${target.pathname}${target.search}`,
    }, (upRes) => {
      res.writeHead(upRes.statusCode ?? 200, upRes.headers);
      upRes.pipe(res);
    });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  srv.on('connection', (s) => { sockets.add(s); s.once('close', () => sockets.delete(s)); });
  srv.on('connect', (req, clientSocket, head) => {
    connectCount++;
    sockets.add(clientSocket as net.Socket);
    if (opts.hang) return;
    if (opts.expectedAuth) {
      const want = `Basic ${Buffer.from(opts.expectedAuth).toString('base64')}`;
      if (req.headers['proxy-authorization'] !== want) {
        clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\n\r\n');
        return;
      }
    }
    const [host, portStr] = (req.url ?? '').split(':');
    const up = net.connect(Number(portStr), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(clientSocket);
      clientSocket.pipe(up);
    });
    sockets.add(up);
    up.once('close', () => sockets.delete(up));
    up.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => up.destroy());
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as net.AddressInfo).port;
  return {
    port,
    stats: () => ({ connectCount, plainCount }),
    close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); srv.close(() => r()); }),
  };
}

async function startFakeSocks5Proxy(opts: { username?: string; password?: string; hang?: boolean } = {}) {
  const seenAtypes: number[] = [];
  const sockets = new Set<net.Socket>();
  const requireAuth = opts.username !== undefined || opts.password !== undefined;

  const srv = net.createServer((client) => {
    sockets.add(client);
    client.once('close', () => sockets.delete(client));
    if (opts.hang) return;

    let buf = Buffer.alloc(0);
    let stage: 'greeting' | 'auth' | 'request' | 'relay' = 'greeting';
    let upstream: net.Socket | undefined;

    const fail = () => { client.destroy(); upstream?.destroy(); };

    const processBuf = () => {
      while (stage !== 'relay') {
        if (stage === 'greeting') {
          if (buf.length < 2) return;
          const nmethods = buf[1];
          if (buf.length < 2 + nmethods) return;
          const methods = [...buf.subarray(2, 2 + nmethods)];
          buf = buf.subarray(2 + nmethods);
          if (requireAuth) {
            if (!methods.includes(0x02)) { client.write(Buffer.from([0x05, 0xff])); fail(); return; }
            client.write(Buffer.from([0x05, 0x02]));
            stage = 'auth';
          } else {
            client.write(Buffer.from([0x05, 0x00]));
            stage = 'request';
          }
        } else if (stage === 'auth') {
          if (buf.length < 2) return;
          const ulen = buf[1];
          if (buf.length < 2 + ulen + 1) return;
          const plen = buf[2 + ulen];
          if (buf.length < 3 + ulen + plen) return;
          const u = buf.subarray(2, 2 + ulen).toString('utf8');
          const p = buf.subarray(3 + ulen, 3 + ulen + plen).toString('utf8');
          buf = buf.subarray(3 + ulen + plen);
          if (u !== (opts.username ?? '') || p !== (opts.password ?? '')) {
            client.write(Buffer.from([0x01, 0x01]));
            fail();
            return;
          }
          client.write(Buffer.from([0x01, 0x00]));
          stage = 'request';
        } else if (stage === 'request') {
          if (buf.length < 4) return;
          const atyp = buf[3];
          let host = '';
          let headerLen = 0;
          if (atyp === 0x01) {
            if (buf.length < 10) return;
            host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
            headerLen = 10;
          } else if (atyp === 0x03) {
            if (buf.length < 5) return;
            const dlen = buf[4];
            if (buf.length < 5 + dlen + 2) return;
            host = buf.subarray(5, 5 + dlen).toString('utf8');
            headerLen = 5 + dlen + 2;
          } else {
            client.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            fail();
            return;
          }
          const port = buf.readUInt16BE(headerLen - 2);
          const leftover = buf.subarray(headerLen);
          buf = Buffer.alloc(0);
          seenAtypes.push(atyp);
          stage = 'relay';

          const targetHost = host === 'echo.local' ? '127.0.0.1' : host;
          upstream = net.connect(port, targetHost, () => {
            client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
            if (leftover.length) upstream!.write(leftover);
            client.pipe(upstream!);
            upstream!.pipe(client);
          });
          sockets.add(upstream);
          upstream.once('close', () => sockets.delete(upstream!));
          upstream.on('error', () => {
            client.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            fail();
          });
        }
      }
    };

    client.on('data', (rawChunk) => {
      if (stage === 'relay') return;
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      processBuf();
    });
    client.on('error', fail);
  });

  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as net.AddressInfo).port;
  return {
    port,
    seenAtypes,
    close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); srv.close(() => r()); }),
  };
}

// ── URL parsing & redaction ─────────────────────────────────────────────────

test('parseProxyUrl parses http, socks5, socks5h, encoded auth, and IPv6', () => {
  const a = parseProxyUrl('http://alice:s3cr%40t!@proxy.example.com:8080');
  assert.deepEqual(a, { scheme: 'http', host: 'proxy.example.com', port: 8080, username: 'alice', password: 's3cr@t!' });
  assert.equal(redactProxyUrl(a), 'http://alice:***@proxy.example.com:8080');

  const b = parseProxyUrl('socks5h://[::1]:1080');
  assert.deepEqual(b, { scheme: 'socks5h', host: '::1', port: 1080 });
  assert.equal(redactProxyUrl(b), 'socks5h://[::1]:1080');

  const view = toProxyView({ ...a, id: 'px_1', name: 'US', createdAt: '2026-01-01', updatedAt: '2026-01-01' });
  assert.equal(view.hasAuth, true);
  assert.equal('password' in view, false);
  assert.equal(JSON.stringify(view).includes('s3cr'), false);
});

test('parseProxyUrl rejects invalid schemes, missing port, whitespace, and paths', () => {
  assert.throws(() => parseProxyUrl('ftp://host:21'), /Unsupported proxy scheme/);
  assert.throws(() => parseProxyUrl('http://host'), /explicit port/);
  assert.throws(() => parseProxyUrl('http://host:99999'), /between 1 and 65535/);
  assert.throws(() => parseProxyUrl('http://host:0'), /between 1 and 65535/);
  assert.throws(() => parseProxyUrl('socks5://host:1080/path'), /must not include a path/);
  assert.throws(() => parseProxyUrl('http://bad host:8080'), /whitespace/);
});

test('redactProxySecrets scrubs raw, percent-encoded, base64, and URL-embedded passwords', () => {
  const secret = 'p@ss!word99';
  const b64 = Buffer.from(secret).toString('base64');
  const raw = `failed http://bob:${encodeURIComponent(secret)}@1.2.3.4:8080 raw=${secret} b64=${b64}`;
  const scrubbed = redactProxySecrets(raw, [secret]);
  assert.equal(scrubbed.includes(secret), false);
  assert.equal(scrubbed.includes(encodeURIComponent(secret)), false);
  assert.equal(scrubbed.includes(b64), false);
  assert.ok(scrubbed.includes('http://bob:***@1.2.3.4:8080'));
});

// ── HTTP CONNECT & SOCKS5 clients ───────────────────────────────────────────

test('testProxy works through HTTP CONNECT with and without auth, fails on wrong auth, and supports fallback', async () => {
  const echo = await startEchoServer({ ip: '198.51.100.7', country: 'US', city: 'Boston', org: 'AS64500 TestNet', loc: '42.3584,-71.0598', timezone: 'America/New_York' });
  const badEcho = await startEchoServer({ error: 'rate limited' }, { status: 429 });
  const openProxy = await startFakeHttpProxy();
  const authProxy = await startFakeHttpProxy({ expectedAuth: 'user1:topsecret' });
  try {
    // Open HTTP proxy with fallback from failing first echo to second echo
    const r1 = await testProxy(
      { scheme: 'http', host: '127.0.0.1', port: openProxy.port },
      { endpoints: [{ url: `http://127.0.0.1:${badEcho.port}/json` }, { url: `http://127.0.0.1:${echo.port}/json` }] },
    );
    assert.equal(r1.ok, true);
    assert.equal(r1.ip, '198.51.100.7');
    assert.equal(r1.country, 'US');
    assert.equal(r1.city, 'Boston');
    assert.equal(r1.timezone, 'America/New_York');
    assert.equal(r1.lat, 42.3584);
    assert.equal(r1.lon, -71.0598);

    // Authenticated HTTP proxy (right password)
    const r2 = await testProxy(
      { scheme: 'http', host: '127.0.0.1', port: authProxy.port, username: 'user1', password: 'topsecret' },
      { endpoints: [{ url: `http://127.0.0.1:${echo.port}/json` }] },
    );
    assert.equal(r2.ok, true);
    assert.equal(r2.ip, '198.51.100.7');

    // Wrong password -> fails cleanly, never echoes secret
    const r3 = await testProxy(
      { scheme: 'http', host: '127.0.0.1', port: authProxy.port, username: 'user1', password: 'wrongpassword123' },
      { endpoints: [{ url: `http://127.0.0.1:${echo.port}/json` }] },
    );
    assert.equal(r3.ok, false);
    assert.match(r3.error ?? '', /authentication/i);
    assert.equal((r3.error ?? '').includes('wrongpassword123'), false);
  } finally {
    await Promise.all([echo.close(), badEcho.close(), openProxy.close(), authProxy.close()]);
  }
});

test('SOCKS5 and SOCKS5H clients handle no-auth, RFC 1929 auth, wrong auth, atyp, and timeout', async () => {
  const echo = await startEchoServer({ ip: '203.0.113.42', country: 'US', city: 'Boston' });
  const openSocks = await startFakeSocks5Proxy();
  const authSocks = await startFakeSocks5Proxy({ username: 'suser', password: 'spassword!' });
  const hangSocks = await startFakeSocks5Proxy({ hang: true });
  try {
    // socks5h sends domain name (ATYP 0x03)
    const rH = await testProxy(
      { scheme: 'socks5h', host: '127.0.0.1', port: openSocks.port },
      { endpoints: [{ url: `http://echo.local:${echo.port}/json` }] },
    );
    assert.equal(rH.ok, true);
    assert.equal(rH.ip, '203.0.113.42');
    assert.equal(openSocks.seenAtypes.at(-1), 0x03);

    // socks5 resolves localhost locally (ATYP 0x01 or 0x04)
    const rLocal = await testProxy(
      { scheme: 'socks5', host: '127.0.0.1', port: openSocks.port },
      { endpoints: [{ url: `http://127.0.0.1:${echo.port}/json` }] },
    );
    assert.equal(rLocal.ok, true);
    assert.equal(openSocks.seenAtypes.at(-1), 0x01);

    // Authenticated SOCKS5
    const rAuth = await testProxy(
      { scheme: 'socks5h', host: '127.0.0.1', port: authSocks.port, username: 'suser', password: 'spassword!' },
      { endpoints: [{ url: `http://echo.local:${echo.port}/json` }] },
    );
    assert.equal(rAuth.ok, true);

    // Wrong password
    const rBad = await testProxy(
      { scheme: 'socks5h', host: '127.0.0.1', port: authSocks.port, username: 'suser', password: 'bad-secret-value' },
      { endpoints: [{ url: `http://echo.local:${echo.port}/json` }] },
    );
    assert.equal(rBad.ok, false);
    assert.match(rBad.error ?? '', /authentication/i);
    assert.equal((rBad.error ?? '').includes('bad-secret-value'), false);

    // Bounded timeout on hanging proxy
    await assert.rejects(
      () => dialThroughProxy({ scheme: 'socks5', host: '127.0.0.1', port: hangSocks.port }, '127.0.0.1', echo.port, { timeoutMs: 250 }),
      /Timed out/i,
    );
  } finally {
    await Promise.all([echo.close(), openSocks.close(), authSocks.close(), hangSocks.close()]);
  }
});

// ── Local 127.0.0.1 forwarder end-to-end ────────────────────────────────────

test('startProxyForwarder chains CONNECT and plain HTTP to both HTTP and SOCKS5 upstreams', async () => {
  const echo = await startEchoServer({ ip: '198.51.100.88', country: 'US', city: 'Boston' });
  const httpUp = await startFakeHttpProxy({ expectedAuth: 'u:p' });
  const socksUp = await startFakeSocks5Proxy({ username: 'su', password: 'sp' });
  const fwHttp = await startProxyForwarder({ scheme: 'http', host: '127.0.0.1', port: httpUp.port, username: 'u', password: 'p' });
  const fwSocks = await startProxyForwarder({ scheme: 'socks5h', host: '127.0.0.1', port: socksUp.port, username: 'su', password: 'sp' });

  const fetchPlainViaForwarder = (fwPort: number, url: string) => new Promise<string>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: fwPort, method: 'GET', path: url }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.end();
  });

  try {
    // 1. CONNECT through local forwarder -> authenticated HTTP upstream -> echo
    const c1 = await testProxy(
      { scheme: 'http', host: '127.0.0.1', port: fwHttp.port },
      { endpoints: [{ url: `http://127.0.0.1:${echo.port}/json` }] },
    );
    assert.equal(c1.ok, true);
    assert.equal(c1.ip, '198.51.100.88');
    assert.equal(httpUp.stats().connectCount, 1);

    // 2. Plain HTTP through local forwarder -> authenticated HTTP upstream -> echo
    const p1 = JSON.parse(await fetchPlainViaForwarder(fwHttp.port, `http://127.0.0.1:${echo.port}/json`));
    assert.equal(p1.ip, '198.51.100.88');
    assert.equal(httpUp.stats().plainCount, 1);

    // 3. CONNECT through local forwarder -> authenticated SOCKS5H upstream -> echo
    const c2 = await testProxy(
      { scheme: 'http', host: '127.0.0.1', port: fwSocks.port },
      { endpoints: [{ url: `http://echo.local:${echo.port}/json` }] },
    );
    assert.equal(c2.ok, true);
    assert.equal(c2.ip, '198.51.100.88');

    // 4. Plain HTTP through local forwarder -> authenticated SOCKS5H upstream -> echo
    const p2 = JSON.parse(await fetchPlainViaForwarder(fwSocks.port, `http://echo.local:${echo.port}/json`));
    assert.equal(p2.ip, '198.51.100.88');
  } finally {
    await Promise.all([fwHttp.close(), fwSocks.close(), httpUp.close(), socksUp.close(), echo.close()]);
  }
});

test('HTTP CONNECT accepts 1xx informational responses and any 2xx final status (RFC 9110)', async () => {
  const echo = await startEchoServer({ ip: '198.51.100.99', country: 'US' });
  const srv = net.createServer((client) => {
    let head = '';
    const onData = (chunk: Buffer) => {
      head += chunk.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      client.off('data', onData);
      const first = head.split('\r\n', 1)[0] ?? '';
      const target = first.split(' ')[1] ?? '';
      const [host, portStr] = target.split(':');
      const up = net.connect(Number(portStr), host, () => {
        client.write('HTTP/1.1 103 Early Hints\r\nLink: </>\r\n\r\nHTTP/1.1 204 No Content\r\n\r\n');
        client.pipe(up);
        up.pipe(client);
      });
      up.on('error', () => client.destroy());
      client.on('error', () => up.destroy());
    };
    client.on('data', onData);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as net.AddressInfo).port;
  try {
    const r = await testProxy(
      { scheme: 'http', host: '127.0.0.1', port },
      { endpoints: [{ url: `http://127.0.0.1:${echo.port}/json` }] },
    );
    assert.equal(r.ok, true);
    assert.equal(r.ip, '198.51.100.99');
  } finally {
    await Promise.all([new Promise<void>((r) => srv.close(() => r())), echo.close()]);
  }
});
