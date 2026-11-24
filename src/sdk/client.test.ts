import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhoneDockApiError, PhoneDockClient, parseWokeHeader, wakeNoticeText } from './client.ts';

test('canonical device resolution bypasses aggregate discovery; names wait for initial inventory', async () => {
  const c = new PhoneDockClient({ autoStart: false });
  const device = { id: 'ios-simulator:pdtest-cold', nativeId: 'pdtest-cold', name: 'test-phone' } as any;
  c.device = async (id) => { assert.equal(id, device.id); return device; };
  c.devices = async () => { throw new Error('Canonical lookup touched aggregate discovery'); };
  assert.equal(await c.resolveDevice(device.id), device);
  let lists = 0, polls = 0;
  c.devices = async () => ++lists === 1 ? [] : [device];
  c.inventoryStatus = async () => ({ ios: { refreshing: ++polls === 1, devices: 1, ...(polls > 1 ? { at: 1 } : {}) } });
  assert.equal(await c.resolveDevice('test-phone'), device);
  assert.equal(lists, 2);
  lists = 0; polls = 0;
  c.devices = async () => ++lists === 1 ? [device] : [device, { ...device, id: 'android-device:pdtest-other' }];
  c.inventoryStatus = async () => ({ ios: { refreshing: ++polls === 1, devices: 1, ...(polls > 1 ? { at: 1 } : {}) } });
  await assert.rejects(c.resolveDevice('test-phone'), (e: any) => e.code === 'ambiguous_device');
  c.inventoryStatus = async () => ({ ios: { refreshing: false, devices: 0, error: 'Provider failed' } });
  await assert.rejects(c.resolveDevice('test-phone'), (e: any) => e.code === 'inventory_incomplete');
  lists = 0;
  c.devices = async () => ++lists === 1 ? [] : [device];
  c.inventoryStatus = async () => ({ ios: { refreshing: false, devices: 1, at: 1 } });
  assert.equal(await c.resolveDevice('test-phone'), device, 'provider finishing between initial list and status must refresh the list');
});

test('SDK retains daemon error detail', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_found', message: 'File missing', hints: ['Check the file'], detail: 'File not found: /missing.apk' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const client = new PhoneDockClient({ baseUrl: `http://127.0.0.1:${address.port}`, autoStart: false });
    await assert.rejects(client.install('device', '/missing.apk'), (e: unknown) => {
      assert.ok(e instanceof PhoneDockApiError);
      assert.equal(e.detail, 'File not found: /missing.apk');
      assert.deepEqual(e.hints, ['Check the file']);
      return true;
    });
  } finally { await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())); }
});

test('jobErrorText: object errors read as message plus hints; strings pass through', async () => {
  const { jobErrorText } = await import('./client.ts');
  assert.equal(jobErrorText({ code: 'no_image', message: 'iOS 27.0 isn’t ready to use on this Mac', hints: ['Download it again.'] }),
    'iOS 27.0 isn’t ready to use on this Mac. Download it again.');
  assert.equal(jobErrorText('boot failed'), 'boot failed');
  assert.equal(jobErrorText(undefined), '');
  assert.ok(!jobErrorText({ code: 'x', message: 'm' }).includes('[object Object]'));
});

async function serve(handler: RequestListener, check: (baseUrl: string) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await check(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  }
}

test('input: consumed request then disconnect is unknown, never resent, and carries its recovery id', async () => {
  let calls = 0; let starts = 0; let requestId: string | undefined;
  await serve((req, res) => {
    req.resume(); req.on('end', () => {
      calls++; requestId = req.headers['x-phonedock-request-id'] as string;
      res.destroy();
    });
  }, async (baseUrl) => {
    const c = new PhoneDockClient({ baseUrl, autoStart: true });
    c.ensureDaemon = async () => { starts++; };
    await assert.rejects(c.tap('pdtest-mock', 1, 2), (e: unknown) => {
      assert.ok(e instanceof PhoneDockApiError);
      assert.equal(e.delivery, 'unknown'); assert.equal(e.retrySafe, false);
      assert.match(e.requestId!, /^[A-Za-z0-9._-]{1,128}$/);
      assert.equal(e.requestId, requestId);
      return true;
    });
    assert.equal(calls, 1); assert.equal(starts, 0);
  });
});

test('clipboard PUT loss is an input outcome and is never resent', async () => {
  let calls = 0;
  await serve((req, res) => { req.resume(); req.on('end', () => { calls++; assert.equal(req.method, 'PUT'); assert.ok(req.headers['x-phonedock-request-id']); res.destroy(); }); }, async (baseUrl) => {
    const c = new PhoneDockClient({ baseUrl, autoStart: true });
    c.ensureDaemon = async () => { assert.fail('Lost clipboard response must not trigger a retry'); };
    await assert.rejects(c.setClipboard('pdtest-clipboard', 'private text'), (e: any) => e.delivery === 'unknown' && !!e.requestId);
    assert.equal(calls, 1);
  });
});

test('input: truncated success and malformed JSON keep delivery unknown without retry', async () => {
  for (const truncated of [true, false]) {
    let calls = 0;
    await serve((req, res) => {
      req.resume(); req.on('end', () => {
        calls++;
        res.writeHead(200, { 'content-type': 'application/json', ...(truncated ? { 'content-length': '100' } : {}) });
        if (truncated) { res.write('{"ok":'); setTimeout(() => res.destroy(), 10); }
        else res.end('not json');
      });
    }, async (baseUrl) => {
      const c = new PhoneDockClient({ baseUrl, autoStart: true });
      c.ensureDaemon = async () => { assert.fail('must not start a daemon after a response'); };
      await assert.rejects(c.tap('pdtest-mock', 1, 2), (e: unknown) => {
        assert.ok(e instanceof PhoneDockApiError);
        assert.equal(e.delivery, 'unknown'); assert.equal(e.retrySafe, false);
        assert.ok(e.requestId); return true;
      });
      assert.equal(calls, 1);
    });
  }
});

test('input: daemon delivery on HTTP errors is preserved; missing delivery is conservative', async () => {
  for (const delivery of ['sent', 'not_sent', undefined]) {
    await serve((req, res) => {
      req.resume(); req.on('end', () => {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'rejected', message: 'Rejected', delivery } }));
      });
    }, async (baseUrl) => {
      const c = new PhoneDockClient({ baseUrl, autoStart: false });
      await assert.rejects(c.tap('pdtest-mock', 1, 2), (e: unknown) => {
        assert.ok(e instanceof PhoneDockApiError);
        assert.equal(e.delivery, delivery ?? 'unknown'); assert.equal(e.status, 409);
        assert.ok(e.requestId); return true;
      });
    });
  }
});

test('input: timeout after dispatch and interrupted error bodies remain unknown', async () => {
  for (const timeout of [true, false]) {
    let calls = 0;
    await serve((req, res) => {
      req.resume(); req.on('end', () => {
        calls++;
        if (!timeout) {
          res.writeHead(409, { 'content-type': 'application/json', 'content-length': '200' });
          res.write('{"error":'); setTimeout(() => res.destroy(), 10);
        }
      });
    }, async (baseUrl) => {
      const c = new PhoneDockClient({ baseUrl, autoStart: true });
      c.ensureDaemon = async () => { assert.fail('must not restart or retry accepted input'); };
      await assert.rejects(c.request('POST', '/v1/devices/pdtest-mock/input', { input: true, body: {}, ...(timeout ? { signal: AbortSignal.timeout(40) } : {}) }), (e: unknown) => {
        assert.ok(e instanceof PhoneDockApiError); assert.equal(e.delivery, 'unknown'); assert.ok(e.requestId); return true;
      });
      assert.equal(calls, 1);
    });
  }
});

test('input: token refresh retries use the same request id', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pdtest-sdk-token-'));
  const info = join(home, process.env.PHONEDOCK_PORT && process.env.PHONEDOCK_PORT !== '47420' ? `daemon-${process.env.PHONEDOCK_PORT}.json` : 'daemon.json');
  const ids: unknown[] = []; let calls = 0;
  writeFileSync(info, JSON.stringify({ port: 1, token: 'old' }));
  try {
    await serve((req, res) => {
      req.resume(); req.on('end', () => {
        ids.push(req.headers['x-phonedock-request-id']); calls++;
        if (calls === 1) {
          writeFileSync(info, JSON.stringify({ port: 1, token: 'new' }));
          res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"code":"unauthorized"}}');
        } else {
          assert.equal(req.headers.authorization, 'Bearer new');
          res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"delivery":"sent"}');
        }
      });
    }, async (baseUrl) => {
      const c = new PhoneDockClient({ baseUrl, home, autoStart: false });
      assert.equal((await c.tap('pdtest-mock', 1, 2)).delivery, 'sent');
      assert.equal(calls, 2); assert.ok(ids[0]); assert.equal(ids[0], ids[1]);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('input: refusal before connection is safe, and pre-aborted calls send nothing', async () => {
  let baseUrl = '';
  await serve((_req, res) => res.end(), async (url) => { baseUrl = url; });
  const c = new PhoneDockClient({ baseUrl, autoStart: false });
  await assert.rejects(c.tap('pdtest-mock', 1, 2), (e: unknown) => {
    assert.ok(e instanceof PhoneDockApiError); assert.equal(e.delivery, 'not_sent'); assert.equal(e.retrySafe, true); return true;
  });
  await assert.rejects(c.request('POST', '/v1/devices/pdtest-mock/input', { input: true, body: {}, signal: AbortSignal.abort() }), (e: unknown) => {
    assert.ok(e instanceof PhoneDockApiError); assert.equal(e.delivery, 'not_sent'); assert.equal(e.code, 'aborted'); return true;
  });
});

test('input: a failed daemon startup retains not_sent and the request id', async () => {
  let baseUrl = '';
  await serve((_req, res) => res.end(), async (url) => { baseUrl = url; });
  const c = new PhoneDockClient({ baseUrl, autoStart: true });
  c.ensureDaemon = async () => { throw new PhoneDockApiError('Unavailable', 'daemon_start_timeout'); };
  await assert.rejects(c.tap('pdtest-mock', 1, 2), (e: unknown) => {
    assert.ok(e instanceof PhoneDockApiError); assert.equal(e.delivery, 'not_sent');
    assert.equal(e.code, 'daemon_start_timeout'); assert.ok(e.requestId); return true;
  });
});

test('input: explicit request ids and result lookup are encoded and validated', async () => {
  const seen: string[] = [];
  await serve((req, res) => {
    req.resume(); req.on('end', () => {
      seen.push(req.url!);
      if (req.method === 'POST') assert.equal(req.headers['x-phonedock-request-id'], 'pdtest-recover');
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
    });
  }, async (baseUrl) => {
    const c = new PhoneDockClient({ baseUrl, autoStart: false });
    await c.request('POST', '/v1/devices/pdtest-mock/input', { body: {}, input: true, requestId: 'pdtest-recover' });
    await c.requestResult('android-emulator:pdtest-mock', 'pdtest-recover');
    await assert.rejects(c.request('POST', '/unused', { input: true, requestId: 'bad\nheader' }), (e: unknown) => {
      assert.ok(e instanceof PhoneDockApiError); assert.equal(e.delivery, 'not_sent'); return true;
    });
    assert.equal(seen.length, 2);
    assert.match(seen[1], /android-emulator%3Apdtest-mock\/requests\/pdtest-recover$/);
  });
});

test('components: lists status and installs component job', async () => {
  const seen: string[] = [];
  await serve((req, res) => {
    req.resume(); req.on('end', () => {
      seen.push(`${req.method} ${req.url}`);
      res.writeHead(req.method === 'POST' ? 202 : 200, { 'content-type': 'application/json' });
      if (req.url === '/v1/components') {
        res.end(JSON.stringify([{ id: 'ios-tools', displayName: 'iPhone Control', description: '', state: 'missing', pinnedVersion: '11.63.1', source: 'none', updateAvailable: false, estimatedBytes: 277000000 }]));
      } else if (req.url === '/v1/components/ios-tools/install') {
        res.end(JSON.stringify({ job: { id: 'job-comp-1', kind: 'install-component', state: 'running', progress: [], startedAt: '2026-11-24T00:00:00Z' }, component: { id: 'ios-tools', state: 'installing' } }));
      } else if (req.url === '/v1/jobs/job-comp-1') {
        res.end(JSON.stringify({ id: 'job-comp-1', kind: 'install-component', state: 'done', progress: ['done'], startedAt: '2026-11-24T00:00:00Z', endedAt: '2026-11-24T00:00:01Z' }));
      } else {
        res.end('{}');
      }
    });
  }, async (baseUrl) => {
    const c = new PhoneDockClient({ baseUrl, autoStart: false });
    const list = await c.components();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'ios-tools');
    const job = await c.installComponent('ios-tools', { wait: true });
    assert.equal(job.id, 'job-comp-1');
    assert.equal(job.state, 'done');
    assert.deepEqual(seen, ['GET /v1/components', 'POST /v1/components/ios-tools/install', 'GET /v1/jobs/job-comp-1']);
  });
});

test('wake notice: a phone that started fresh says its previous screen is gone (idle sleep)', () => {
  const resumed = parseWokeHeader('7213; name=Pixel%208', '/v1/devices/android-emulator%3Apdtest-a/input');
  assert.deepEqual(resumed, { ms: 7213, name: 'Pixel 8', deviceId: 'android-emulator:pdtest-a' });
  assert.equal(wakeNoticeText(resumed!), 'Woke Pixel 8 (7.2 s)');
  const fresh = parseWokeHeader('21000; name=Pixel%208; fresh=1');
  assert.equal(fresh?.name, 'Pixel 8');
  assert.equal(fresh?.fresh, true);
  assert.equal(wakeNoticeText(fresh!), 'Woke Pixel 8 (21.0 s), started fresh; its previous screen is gone');
});
