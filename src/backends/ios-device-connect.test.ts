// ios-device.json edits that must keep a phone listed and its setup intact: connecting to the address of an iPhone
// PhoneDock manages, and Stop Control.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'pd-ios-connect-'));
process.env.PHONEDOCK_HOME = home;
const { backend } = await import('./ios-device.ts');
after(() => rmSync(home, { recursive: true, force: true }));

const UDID = '00008020-0000FAKE0000FAKE';
const cfgFile = join(home, 'ios-device.json');
const wda = { team: 'TEAMAAAAAA', free: false, bundleId: 'com.facebook.WebDriverAgentRunner', since: '2026-11-01T00:00:00Z' };

test('connect --ios to a managed phone’s address keeps its entry and its wda setup', async () => {
  const srv = createServer((req, res) => {
    res.writeHead(req.url === '/status' ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ value: { ready: true } }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  try {
    writeFileSync(cfgFile, JSON.stringify({
      [UDID]: { udid: UDID, wdaUrl: url, wda },
      [`wda-127.0.0.1-${port}`]: { wdaUrl: url, address: '127.0.0.1' },
    }));
    const r = await backend.connectWda(url, { name: 'Old iPhone' });
    assert.equal(r.nativeId, UDID, 'the managed phone, not a new manual entry');
    const saved = JSON.parse(readFileSync(cfgFile, 'utf8'));
    assert.deepEqual(saved[UDID].wda, wda, 'still managed');
    assert.equal(saved[UDID].name, 'Old iPhone');
    assert.equal(saved[`wda-127.0.0.1-${port}`], undefined, 'the duplicate manual entry is gone');
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

test('Stop Control ends management but keeps the phone’s entry, name and setup for the next Set Up Control', async () => {
  writeFileSync(cfgFile, JSON.stringify({ [UDID]: { udid: UDID, name: 'Old iPhone', wdaUrl: 'http://192.0.2.10:8100', wda } }));
  const r = await backend.wdaStop(UDID);
  assert.deepEqual(r, { udid: UDID, stopped: true });
  const e = JSON.parse(readFileSync(cfgFile, 'utf8'))[UDID];
  assert.equal(e.name, 'Old iPhone', 'not forgotten (that is Disconnect)');
  assert.equal(e.wda, undefined, 'no longer managed');
  assert.equal(e.wdaUrl, undefined, 'the runner’s address is gone with it');
  assert.equal(e.wdaStopped.team, wda.team, 'remembered, so setting up again reuses the team and its build');
  assert.equal(e.wdaStopped.since, undefined);
  assert.ok(Date.parse(e.wdaStopped.stoppedAt));
  assert.deepEqual(await backend.wdaStop(UDID), { udid: UDID, stopped: false }, 'idempotent');
  await assert.rejects(backend.wdaStop('bad/udid'), (err: { code?: string }) => err.code === 'bad_request');
});
