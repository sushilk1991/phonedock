import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PhoneDockApiError, PhoneDockClient } from './client.ts';

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
