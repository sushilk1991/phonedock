// The real SDK -> HTTP -> router -> request journal chain, with an in-memory device and a deliberately lost reply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PhoneDockApiError } from '../sdk/client.ts';
import type { Backend } from '../core/types.ts';
process.env.PHONEDOCK_HOME = mkdtempSync(join(tmpdir(), 'pd-recovery-http-'));
const { PhoneDockClient } = await import('../sdk/client.ts');
const core = await import('./core.ts');
const { instrumentBackend } = await import('./metrics.ts');
const { router } = await import('./routes.ts');
const { readBody, sendJson, sendError } = await import('./http.ts');

test('lost input response is recovered after HTTP disconnect without a second device action', async () => {
  let taps = 0; let drop = true;
  const backend = instrumentBackend({ id: 'fake-recovery', platform: 'ios', tap: async () => { taps++; } } as unknown as Backend, 'fake-recovery');
  core.backends.push(backend);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost'); const match = router.match(req.method!, url.pathname);
    if (!match || match === 'method') { res.writeHead(404); res.end(); return; }
    let body: Promise<unknown> | undefined;
    try {
      const out = await match.h({ req, res, url, params: match.params, owner: String(req.headers['x-phonedock-owner']), body: () => body ??= readBody(req), q: (key) => url.searchParams.get(key) ?? undefined });
      if (req.method === 'POST' && drop) { drop = false; res.destroy(); return; }
      sendJson(res, 200, out);
    } catch (e) { sendError(res, e); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const client = new PhoneDockClient({ baseUrl: `http://127.0.0.1:${address.port}`, owner: 'test-http', autoStart: false });
    const id = 'fake-recovery:pdtest-http'; const requestId = 'lost-response';
    const action = { action: 'tap' as const, x: 10, y: 20 };
    await assert.rejects(client.input(id, action, { requestId }), (e: PhoneDockApiError) => e.delivery === 'unknown' && e.requestId === requestId);
    const receipt = await client.requestResult(id, requestId);
    assert.equal(receipt.status, 'completed'); assert.equal(receipt.delivery, 'sent');
    assert.equal((await client.input(id, action, { requestId })).delivery, 'sent');
    assert.equal(taps, 1);
  } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); core.backends.splice(core.backends.indexOf(backend), 1); }
});
