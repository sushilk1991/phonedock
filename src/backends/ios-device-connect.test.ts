// ios-device.json edits that must keep a phone listed and its setup intact: connecting to the address of an iPhone
// PhoneDock manages, and Stop Control.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeDevicectl } from './fake-devicectl.ts';

const home = mkdtempSync(join(tmpdir(), 'pd-ios-connect-'));
process.env.PHONEDOCK_HOME = home;
process.env.PHONEDOCK_WDA_CLAIMS_DIR = join(home, 'claims');   // never this Mac's real claims
process.env.PHONEDOCK_COMPONENTS_AUTO = '0';
const UDID = '00008020-0000FAKE0000FAKE';
// devicectl answers from a fake: no unit test reaches a real phone.
const fake = fakeDevicectl({ phones: [{ udid: UDID, coreDeviceId: '11111111-2222-3333-4444-555555555555', tunnelIp: 'fd00:0:0:1::1' }], runners: { [UDID]: [91] } });
const { backend, publicConfig } = await import('./ios-device.ts');
after(() => { fake.restore(); rmSync(home, { recursive: true, force: true }); });

const cfgFile = join(home, 'ios-device.json');
const wda = { team: 'TEAMAAAAAA', free: false, bundleId: 'com.facebook.WebDriverAgentRunner', since: '2026-11-01T00:00:00Z' };

test('connect --ios to a managed phone’s address keeps its entry and its wda setup', async () => {
  const srv = createServer((req, res) => {
    const known = req.url === '/status' || req.url === '/wda/device/info';
    res.writeHead(known ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ value: req.url === '/wda/device/info' ? { uuid: 'AAAAAAAA-0000-0000-0000-000000000001' } : { ready: true } }));
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
  assert.deepEqual(r, { udid: UDID, stopped: true, confirmed: true });
  assert.deepEqual(fake.runners(UDID), [], 'the runner on the phone is ended (and confirmed)');
  const e = JSON.parse(readFileSync(cfgFile, 'utf8'))[UDID];
  assert.equal(e.name, 'Old iPhone', 'not forgotten (that is Disconnect)');
  assert.equal(e.wda, undefined, 'no longer managed');
  assert.equal(e.wdaUrl, undefined, 'the runner’s address is gone with it');
  assert.equal(e.wdaStopped.team, wda.team, 'remembered, so setting up again reuses the team and its build');
  assert.equal(e.wdaStopped.since, undefined);
  assert.ok(Date.parse(e.wdaStopped.stoppedAt));
  assert.deepEqual(await backend.wdaStop(UDID), { udid: UDID, stopped: false, confirmed: true }, 'idempotent');
  await assert.rejects(backend.wdaStop('bad/udid'), (err: { code?: string }) => err.code === 'bad_request');
});

test('#2: a manual connection remembers which iPhone answered, so another phone at that address later is noticed', async () => {
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ value: req.url === '/wda/device/info' ? { uuid: 'BBBBBBBB-0000-0000-0000-000000000002' } : { ready: true } }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  try {
    writeFileSync(cfgFile, '{}');
    const r = await backend.connectWda(`http://127.0.0.1:${port}`);
    assert.equal(JSON.parse(readFileSync(cfgFile, 'utf8'))[r.nativeId].wdaDeviceId, 'BBBBBBBB-0000-0000-0000-000000000002');
  } finally { await new Promise<void>((r) => srv.close(() => r())); }
});

test('#12: device info shows a phone’s setup without the API key’s path or IDs', () => {
  const key = { path: '/private/keys/AuthKey_KEYID12345.p8', keyId: 'KEYID12345', issuerId: '69a6de70-0000-47e3-e053-5b8c7c11a4d1' };
  const pub = publicConfig({ udid: UDID, name: 'Old iPhone', wda: { ...wda, apiKey: key }, wdaStopped: { ...wda, apiKey: key, stoppedAt: '2026-11-02T00:00:00Z' } });
  const text = JSON.stringify(pub);
  for (const v of Object.values(key)) assert.ok(!text.includes(v), `${v} leaked`);
  assert.equal((pub as any).wda.signing, 'api-key');
  assert.equal((pub as any).wda.team, wda.team);
});
