// Connecting to the address of an iPhone whose WebDriverAgent PhoneDock manages must keep that phone's entry (and its
// supervision); a plain manual entry for the same address is still replaced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'pd-ios-connect-'));
process.env.PHONEDOCK_HOME = home;
const { backend } = await import('./ios-device.ts');

const UDID = '00008020-0000FAKE0000FAKE';

test('connect --ios to a managed phone’s address keeps its entry and its wda setup', async () => {
  const srv = createServer((req, res) => {
    res.writeHead(req.url === '/status' ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ value: { ready: true } }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  try {
    const wda = { team: 'TEAMAAAAAA', free: false, bundleId: 'com.facebook.WebDriverAgentRunner', since: '2026-11-01T00:00:00Z' };
    writeFileSync(join(home, 'ios-device.json'), JSON.stringify({
      [UDID]: { udid: UDID, wdaUrl: url, wda },
      [`wda-127.0.0.1-${port}`]: { wdaUrl: url, address: '127.0.0.1' },
    }));
    const r = await backend.connectWda(url, { name: 'Old iPhone' });
    assert.equal(r.nativeId, UDID, 'the managed phone, not a new manual entry');
    const saved = JSON.parse(readFileSync(join(home, 'ios-device.json'), 'utf8'));
    assert.deepEqual(saved[UDID].wda, wda, 'still managed');
    assert.equal(saved[UDID].name, 'Old iPhone');
    assert.equal(saved[`wda-127.0.0.1-${port}`], undefined, 'the duplicate manual entry is gone');
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
    rmSync(home, { recursive: true, force: true });
  }
});
