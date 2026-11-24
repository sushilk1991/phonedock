// Older iPhones v1 through the ios-device backend, against fake-devicectl.ts (DEVELOPER_DIR): input routing to the
// tunnel address read fresh from devicectl, and Stop Control. No phone is reachable from these tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PhoneDockError } from '../core/types.ts';
import { fakeDevicectl } from './fake-devicectl.ts';

const UDID = '00008020-0000AAAA0000BBBB';
const CORE_ID = '11111111-2222-3333-4444-555555555555';
const home = mkdtempSync(join(tmpdir(), 'pd-v1-device-'));
process.env.PHONEDOCK_HOME = home;
process.env.PHONEDOCK_COMPONENTS_AUTO = '0';
const fake = fakeDevicectl({ phones: [], runners: {} });
const { backend } = await import('./ios-device.ts');
const writeCfg = (v: unknown) => writeFileSync(join(home, 'ios-device.json'), JSON.stringify(v));
const setUpCfg = { [UDID]: { udid: UDID, wdaTeam: { team: 'AAAAA11111', free: false, bundleId: 'com.facebook.WebDriverAgentRunner' } } };
const errOf = (p: Promise<unknown>) => p.then(() => undefined, (e) => e as PhoneDockError);
test.after(() => { fake.restore(); rmSync(home, { recursive: true, force: true }); });

test('input to a phone set up here goes to the tunnel address devicectl reports now; gone means no_device, not running means wda_not_ready', async (t) => {
  // A WebDriverAgent at the phone's end of the tunnel: the fake reports 127.0.0.1 as the tunnel address.
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/status') { res.end(JSON.stringify({ value: { ready: true, ios: { ip: null } } })); return; }
    if (req.url === '/session') { res.end(JSON.stringify({ sessionId: 's1', value: { sessionId: 's1' } })); return; }
    if (req.url === '/wda/activeAppInfo') { res.end(JSON.stringify({ value: { bundleId: 'com.example.app', name: 'Example' } })); return; }
    res.end(JSON.stringify({ value: { width: 375, height: 812 } }));
  });
  const bound = await new Promise<boolean>((r) => { server.once('error', () => r(false)); server.listen(8100, '127.0.0.1', () => r(true)); });
  if (!bound) { t.skip('port 8100 is in use on this Mac'); return; }
  const savedEnv = process.env.PHONEDOCK_WDA_URL;
  process.env.PHONEDOCK_WDA_URL = 'http://127.0.0.1:1';           // never used for a phone set up here
  try {
    fake.scenario.phones = [{ udid: UDID, coreDeviceId: CORE_ID, tunnelIp: '127.0.0.1' }]; fake.save();
    writeCfg(setUpCfg);                                              // no saved address
    const listed = (await backend.listDevices()).find((d) => d.nativeId === UDID)!;
    assert.deepEqual([listed.meta?.wdaUrl, listed.meta?.wdaReady, listed.meta?.wdaTeam], ['http://127.0.0.1:8100', true, 'AAAAA11111']);
    await backend.tap!(UDID, 10, 10);
    const sent = hits.filter((h) => h.startsWith('POST')).length;
    assert.ok(sent > 0, 'the tap reached WebDriverAgent at the tunnel address');
    assert.deepEqual(await backend.foregroundApp!(UDID), { id: 'com.example.app', name: 'Example' }, 'the foreground app comes from it too');

    // The tunnel moves (nothing listens at the new address): nothing goes to the old one.
    fake.scenario.phones = [{ udid: UDID, coreDeviceId: CORE_ID, tunnelIp: '::1' }]; fake.save();
    await backend.listDevices();
    const e = await errOf(backend.tap!(UDID, 10, 10));
    assert.equal(e?.code, 'wda_not_ready');
    assert.match(e!.hints![0], /Set Up Control|wda-setup/);
    assert.equal(hits.filter((h) => h.startsWith('POST')).length, sent, 'no input at the old address');
    assert.equal((await errOf(backend.foregroundApp!(UDID)))?.code, 'wda_not_ready', 'control off: says how to set it up');

    // devicectl doesn't list the phone: no input at all.
    fake.scenario.phones = []; fake.save();
    await backend.listDevices();
    assert.equal((await errOf(backend.tap!(UDID, 10, 10)))?.code, 'no_device');
  } finally {
    if (savedEnv === undefined) delete process.env.PHONEDOCK_WDA_URL; else process.env.PHONEDOCK_WDA_URL = savedEnv;
    server.closeAllConnections?.(); server.close();
  }
});

test('Stop Control ends every WebDriverAgent on the phone, whoever started it, and confirms none is left', async () => {
  fake.scenario.phones = [{ udid: UDID, coreDeviceId: CORE_ID, tunnelIp: 'fd00:0:0:1::1' }]; fake.scenario.runners = { [UDID]: [80, 81] }; fake.save();
  writeCfg(setUpCfg);
  assert.deepEqual(await backend.wdaStop(UDID), { udid: UDID, stopped: true, confirmed: true });
  assert.deepEqual(fake.runners(UDID), []);
  assert.deepEqual(await backend.wdaStop(UDID), { udid: UDID, stopped: false, confirmed: true }, 'nothing running: still confirmed');
  fake.scenario.phones = []; fake.save();
  assert.equal((await backend.wdaStop(UDID)).confirmed, false, 'devicectl can’t see the phone: not confirmed');
});

test('setup names a phone by its UDID: a CoreDevice identifier is refused, with the UDID to use', async () => {
  fake.scenario.phones = [{ udid: UDID, coreDeviceId: CORE_ID, tunnelIp: 'fd00:0:0:1::1' }]; fake.scenario.runners = {}; fake.save();
  await backend.listDevices();
  const e = await errOf(backend.wdaSetup(CORE_ID, {}));
  assert.equal(e?.code, 'bad_request');
  assert.match(e!.hints![0], new RegExp(UDID));
  // A destination that only mentions "simulator" in a name is still an iPhone destination: refused, not main's path.
  assert.equal((await errOf(backend.wdaSetup(UDID, { destination: 'platform=iOS,name=simulator rig' })))?.code, 'bad_request');
});

test('a device destination other than this phone’s id is refused before anything runs', async () => {
  const e = await errOf(backend.wdaSetup(UDID, { destination: 'platform=iOS,name=Other iPhone' }));
  assert.equal(e?.code, 'bad_request');
});
