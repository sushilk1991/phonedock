import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';
import { inspectAndroidWebView, type AndroidWebViewDeps, type SocketLike } from './android-webview.ts';

class FakeSocket extends EventTarget implements SocketLike {
  readyState = 0; closed = false; sent: any[] = [];
  constructor(privateReply: (message: any, socket: FakeSocket) => void) {
    super(); this.reply = privateReply; queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
  }
  reply: (message: any, socket: FakeSocket) => void;
  send(data: string) { const msg = JSON.parse(data); this.sent.push(msg); queueMicrotask(() => this.reply(msg, this)); }
  event(message: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }
  close() { this.closed = true; this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
const dom = { viewport: { width: 200, height: 400, offsetLeft: 0, offsetTop: 0, scale: 1 },
  text: 'Hello', elements: [{ tag: 'button', role: 'button', label: 'Continue', bounds: { x: 10, y: 20, width: 80, height: 40 } }] };

function fixture(extra: { targetUrl?: string; socketReply?: (message: any, socket: FakeSocket) => void; socketNames?: string; removeFails?: boolean } = {}) {
  const calls: { serial: string; args: string[] }[] = []; const sockets: FakeSocket[] = [];
  const deps: AndroidWebViewDeps = {
    adb: async (serial, args) => {
      calls.push({ serial, args });
      if (args[0] === 'shell' && args[1] === 'pidof') return { code: 0, stdout: '1234\n', stderr: '' };
      if (args[0] === 'shell') return { code: 0, stdout: extra.socketNames ?? '000 000 000 000 000 000 000 @webview_devtools_remote_1234\n', stderr: '' };
      if (args[1] === 'tcp:0') return { code: 0, stdout: '49231\n', stderr: '' };
      if (extra.removeFails) throw new Error('remove failed');
      return { code: 0, stdout: '', stderr: '' };
    },
    fetchJson: async () => [{ id: 'page-one', type: 'page', title: 'Test app', url: 'https://example.test/?token=hidden', webSocketDebuggerUrl: extra.targetUrl ?? 'ws://127.0.0.1:49231/devtools/page/page-one' }],
    socket: (url) => {
      assert.equal(url, 'ws://127.0.0.1:49231/devtools/page/page-one');
      const s = new FakeSocket(extra.socketReply ?? ((msg, sock) => sock.event({ id: msg.id, result: msg.method === 'Runtime.evaluate' ? { result: { value: dom } } : {} })));
      sockets.push(s); return s;
    },
    wait: async () => {},
  };
  return { deps, calls, sockets };
}

test('debug WebView snapshot binds forwarding to the explicit device and cleans up', async () => {
  const f = fixture();
  const result = await inspectAndroidWebView('pdtest-serial', { appId: 'com.example.test', action: 'snapshot', bounds: { x: 20, y: 100, width: 400, height: 800 } }, f.deps);
  assert.equal(result.action, 'snapshot');
  if (result.action !== 'snapshot') assert.fail('snapshot');
  assert.equal(result.coordinateSpace, 'device');
  assert.deepEqual(result.elements[0].bounds, { x: 40, y: 140, width: 160, height: 80 });
  assert.equal(result.target.url, 'https://example.test/');
  assert.ok(f.calls.every((c) => c.serial === 'pdtest-serial'));
  assert.deepEqual(f.calls.at(-1)?.args, ['forward', '--remove', 'tcp:49231']);
  assert.equal(f.sockets[0].closed, true);
  assert.ok(!f.sockets[0].sent.some((m) => /Input|setValue|click/.test(m.method)));
});

test('invalid app IDs and target URLs are rejected without forwarding arbitrary network addresses', async () => {
  const f = fixture();
  await assert.rejects(inspectAndroidWebView('pdtest-serial', { appId: 'bad;cmd', action: 'snapshot' }, f.deps), (e: any) => e.code === 'bad_request');
  assert.equal(f.calls.length, 0);
  for (const targetUrl of ['ws://evil.test:49231/devtools/page/x', 'ws://127.0.0.1:80/devtools/page/x', 'wss://127.0.0.1:49231/devtools/page/x', 'ws://user:password@127.0.0.1:49231/devtools/page/x']) {
    const x = fixture({ targetUrl });
    await assert.rejects(inspectAndroidWebView('pdtest-serial', { appId: 'com.example.test', action: 'snapshot' }, x.deps), (e: any) => e.code === 'webview_debug_failed');
    assert.deepEqual(x.calls.at(-1)?.args, ['forward', '--remove', 'tcp:49231']);
    assert.equal(x.sockets.length, 0);
  }
});

test('non-debuggable apps and malformed CDP responses fail explicitly with forwarding cleanup', async () => {
  const absent = fixture({ socketNames: '' });
  await assert.rejects(inspectAndroidWebView('pdtest-serial', { appId: 'com.example.test', action: 'snapshot' }, absent.deps), (e: any) => e.code === 'not_supported');
  assert.equal(absent.calls.some((c) => c.args[0] === 'forward'), false);
  const bad = fixture({ socketReply: (m, s) => s.event({ id: m.id, result: { result: { value: { viewport: { width: NaN, height: 20 } } } } }) });
  await assert.rejects(inspectAndroidWebView('pdtest-serial', { appId: 'com.example.test', action: 'snapshot' }, bad.deps), (e: any) => e.code === 'webview_debug_failed');
  assert.deepEqual(bad.calls.at(-1)?.args, ['forward', '--remove', 'tcp:49231']);
});

test('network capture returns bounded metadata without headers, bodies, credentials or query strings', async () => {
  const f = fixture({ socketReply: (m, s) => {
    s.event({ id: m.id, result: {} });
    if (m.method === 'Network.enable') {
      s.event({ method: 'Network.requestWillBeSent', params: { requestId: '1', timestamp: 10, request: { url: 'https://user:secret@example.test/api?token=private#secret', method: 'POST', headers: { Authorization: 'secret' }, postData: 'private-body' } } });
      s.event({ method: 'Network.responseReceived', params: { requestId: '1', response: { status: 500, headers: { cookie: 'secret' } } } });
      s.event({ method: 'Network.loadingFinished', params: { requestId: '1', timestamp: 10.25 } });
    }
  } });
  const result = await inspectAndroidWebView('pdtest-serial', { appId: 'com.example.test', action: 'network', captureMs: 1 }, f.deps);
  assert.equal(result.action, 'network'); if (result.action !== 'network') assert.fail('network');
  assert.deepEqual(result.requests, [{ method: 'POST', url: 'https://example.test/api', status: 500, durationMs: 250 }]);
  assert.ok(!/private|secret|Authorization|postData|cookie/.test(JSON.stringify(result)));
  assert.equal(f.sockets[0].closed, true);
});

test('unknown geometry keeps CSS coordinates and never guesses device positions', async () => {
  const f = fixture();
  const result = await inspectAndroidWebView('pdtest-serial', { appId: 'com.example.test', action: 'snapshot' }, f.deps);
  assert.equal(result.action, 'snapshot'); if (result.action !== 'snapshot') assert.fail('snapshot');
  assert.equal(result.coordinateSpace, 'css'); assert.equal(result.elements[0].bounds, undefined);
  assert.ok(result.warnings.some((s) => /bounds/i.test(s)));
});

test('invalid geometry and capture limits fail before any device command', async () => {
  for (const patch of [{ bounds: { x: -1, y: 0, width: 20, height: 40 } }, { bounds: { x: 0, y: 0, width: Infinity, height: 40 } }, { captureMs: 6000 }, { maxElements: 501 }]) {
    const f = fixture();
    await assert.rejects(inspectAndroidWebView('pdtest-serial', { appId: 'com.example.test', action: 'snapshot', ...patch }, f.deps), (e: any) => e.code === 'bad_request');
    assert.equal(f.calls.length, 0);
  }
  const mismatch = fixture();
  const r = await inspectAndroidWebView('pdtest-serial', { appId: 'com.example.test', action: 'snapshot', bounds: { x: 0, y: 0, width: 400, height: 200 } }, mismatch.deps);
  assert.equal(r.action, 'snapshot'); if (r.action !== 'snapshot') assert.fail('snapshot');
  assert.equal(r.coordinateSpace, 'css'); assert.equal(r.elements[0].bounds, undefined);
});

test('CDP rejection, malformed frames and disconnection reject pending reads and remove the forward', async () => {
  for (const reply of [
    (m: any, s: FakeSocket) => s.event({ id: m.id, error: { message: 'private token is never echoed' } }),
    (_m: any, s: FakeSocket) => s.dispatchEvent(new MessageEvent('message', { data: 'not JSON' })),
    (_m: any, s: FakeSocket) => s.close(),
  ]) {
    const f = fixture({ socketReply: reply });
    await assert.rejects(inspectAndroidWebView('pdtest-serial', { appId: 'com.example.test', action: 'snapshot' }, f.deps), (e: any) => e.code === 'webview_debug_failed' && !/private token/.test(JSON.stringify(e)));
    assert.deepEqual(f.calls.at(-1)?.args, ['forward', '--remove', 'tcp:49231']);
    assert.equal(f.sockets[0].closed, true);
  }
});

test('cleanup failures are explicit and snapshot/network output remains bounded', async () => {
  const f = fixture({ removeFails: true });
  const r = await inspectAndroidWebView('pdtest-serial', { appId: 'com.example.test', action: 'snapshot' }, f.deps);
  assert.ok(r.warnings.some((s) => /Could not remove/.test(s)));
  const n = fixture({ socketReply: (m, s) => {
    s.event({ id: m.id, result: {} });
    if (m.method === 'Network.enable') for (let i = 0; i < 600; i++) s.event({ method: 'Network.requestWillBeSent', params: { requestId: `${i}`, request: { url: 'https://example.test/' + 'a'.repeat(5000), method: 'GET' } } });
  } });
  const out = await inspectAndroidWebView('pdtest-serial', { appId: 'com.example.test', action: 'network', captureMs: 1 }, n.deps);
  assert.equal(out.action, 'network'); if (out.action !== 'network') assert.fail('network');
  assert.equal(out.requests.length, 500); assert.equal(out.truncated, true);
  assert.ok(out.requests.every((x) => x.url.length <= 4096));
});

test('real loopback HTTP and WebSocket exercise the production CDP transport without a device', async () => {
  const sockets = new Set<Socket>(); const commands: string[] = []; const forwards: string[][] = [];
  const server = createServer((_req, res) => {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ id: 'real-fixture', type: 'page', title: 'Fixture', url: 'https://example.test', webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/page/real-fixture` }]));
  });
  const frame = (payload: Buffer, opcode = 1) => {
    const h = Buffer.alloc(payload.length < 126 ? 2 : 4); h[0] = 0x80 | opcode;
    if (h.length === 2) h[1] = payload.length; else { h[1] = 126; h.writeUInt16BE(payload.length, 2); }
    return Buffer.concat([h, payload]);
  };
  server.on('upgrade', (req, socket) => {
    const s = socket as Socket; sockets.add(s); s.on('close', () => sockets.delete(s));
    const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    s.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buf = Buffer.alloc(0);
    s.on('data', (chunk) => {
      buf = Buffer.concat([buf, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
      while (buf.length >= 2) {
        const opcode = buf[0] & 15; let length = buf[1] & 127; let offset = 2;
        if (length === 126) { if (buf.length < 4) return; length = buf.readUInt16BE(2); offset = 4; }
        if (length === 127) { s.destroy(); return; }
        const masked = !!(buf[1] & 128); const mask = masked ? buf.subarray(offset, offset + 4) : undefined;
        if (masked) offset += 4; if (buf.length < offset + length) return;
        const payload = Buffer.from(buf.subarray(offset, offset + length)); buf = buf.subarray(offset + length);
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        if (opcode === 8) { s.end(frame(Buffer.alloc(0), 8)); return; }
        if (opcode !== 1) continue;
        const message = JSON.parse(payload.toString('utf8')); commands.push(message.method);
        s.write(frame(Buffer.from(JSON.stringify({ id: message.id, result: { result: { value: dom } } }))));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const result = await inspectAndroidWebView('pdtest-fixture', { appId: 'com.example.test', action: 'snapshot' }, {
      adb: async (serial, args) => {
        assert.equal(serial, 'pdtest-fixture');
        if (args[1] === 'pidof') return { code: 0, stdout: '1234', stderr: '' };
        if (args[0] === 'shell') return { code: 0, stdout: '@webview_devtools_remote_1234', stderr: '' };
        forwards.push(args); return { code: 0, stdout: args[1] === 'tcp:0' ? String(address.port) : '', stderr: '' };
      },
    });
    assert.equal(result.action, 'snapshot'); assert.deepEqual(commands, ['Runtime.evaluate']);
    assert.deepEqual(forwards.at(-1), ['forward', '--remove', `tcp:${address.port}`]);
  } finally {
    for (const socket of sockets) socket.destroy(); server.closeAllConnections();
    await new Promise<void>((r, reject) => server.close((e) => e ? reject(e) : r()));
  }
});

test('Android WebView measure returns matched elements bounding boxes and computed styles', async () => {
  const measured = {
    viewport: { width: 360, height: 720, offsetLeft: 0, offsetTop: 0, scale: 1 },
    matchCount: 1,
    elements: [{
      tag: 'button', id: 'buy-btn', classes: ['primary', 'lg'], text: 'Buy Now', visible: true,
      bounds: { x: 20, y: 100, width: 320, height: 48 },
      styles: { display: 'flex', fontSize: '16px', color: 'rgb(255, 255, 255)', backgroundColor: 'rgb(0, 122, 255)' },
    }],
    truncated: false,
  };
  const f = fixture({
    socketReply: (m, s) => s.event({ id: m.id, result: { result: { value: measured } } }),
  });
  const res = await inspectAndroidWebView('pdtest-serial', {
    appId: 'com.example.test', action: 'measure', selector: 'button#buy-btn',
    bounds: { x: 0, y: 0, width: 720, height: 1440 },
  }, f.deps);
  assert.equal(res.action, 'measure');
  if (res.action !== 'measure') assert.fail('measure');
  assert.equal(res.matchCount, 1);
  assert.equal(res.coordinateSpace, 'device');
  assert.deepEqual(res.elements[0].bounds, { x: 40, y: 200, width: 640, height: 96 });
  assert.equal(res.elements[0].styles.fontSize, '16px');
  assert.equal(f.sockets[0].closed, true);
});
