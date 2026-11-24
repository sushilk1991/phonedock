// Older iPhones v1 through the ios-device backend, against fake-devicectl.ts (DEVELOPER_DIR): input routing to the
// tunnel address read fresh from devicectl, and Stop Control. No phone is reachable from these tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    // Its Wi-Fi address is this fake's own: the device list's probe of <Wi-Fi>:8100 reaches it, so it reads as shared.
    if (req.url === '/status') { res.end(JSON.stringify({ value: { ready: true, ios: { ip: '127.0.0.1' } } })); return; }
    if (req.url === '/session') { res.end(JSON.stringify({ sessionId: 's1', value: { sessionId: 's1' } })); return; }
    if (req.url === '/wda/activeAppInfo') { res.end(JSON.stringify({ value: { bundleId: 'com.example.app', name: 'Example' } })); return; }
    res.end(JSON.stringify({ value: { width: 375, height: 812 } }));
  });
  const bound = await new Promise<boolean>((r) => { server.once('error', () => r(false)); server.listen(8100, '127.0.0.1', () => r(true)); });
  if (!bound) { t.skip('port 8100 is in use on this Mac'); return; }
  const savedEnv = process.env.PHONEDOCK_WDA_URL;
  delete process.env.PHONEDOCK_WDA_URL;
  try {
    fake.scenario.phones = [{ udid: UDID, coreDeviceId: CORE_ID, tunnelIp: '127.0.0.1' }]; fake.save();
    writeCfg(setUpCfg);                                              // no saved address
    const listed = (await backend.listDevices()).find((d) => d.nativeId === UDID)!;
    assert.deepEqual([listed.meta?.wdaUrl, listed.meta?.wdaReady, listed.meta?.wdaTeam], ['http://127.0.0.1:8100', true, 'AAAAA11111']);
    assert.deepEqual([listed.meta?.wdaSharing, listed.meta?.wdaSharedUrl], ['shared', 'http://127.0.0.1:8100'], 'answers on its Wi-Fi address: shared');
    await backend.tap!(UDID, 10, 10);
    const sent = hits.filter((h) => h.startsWith('POST')).length;
    assert.ok(sent > 0, 'the tap reached WebDriverAgent at the tunnel address');
    assert.deepEqual(await backend.foregroundApp!(UDID), { id: 'com.example.app', name: 'Example' }, 'the foreground app comes from it too');

    // The tunnel moves (nothing listens at the new address): nothing goes to the old one.
    fake.scenario.phones = [{ udid: UDID, coreDeviceId: CORE_ID, tunnelIp: '::1' }]; fake.save();
    const moved = (await backend.listDevices()).find((d) => d.nativeId === UDID)!;
    assert.deepEqual([moved.meta?.wdaReady, moved.meta?.wdaSharing], [false, null], 'control off: no sharing claim either way');
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

test('a phone whose tunnel idled down: input brings it up (devicectl’s details answer has the address before the list does)', async (t) => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/status') { res.end(JSON.stringify({ value: { ready: true, ios: { ip: null } } })); return; }
    if (req.url === '/session') { res.end(JSON.stringify({ sessionId: 's1', value: { sessionId: 's1' } })); return; }
    res.end(JSON.stringify({ value: { width: 375, height: 812 } }));
  });
  const bound = await new Promise<boolean>((r) => { server.once('error', () => r(false)); server.listen(8100, '127.0.0.1', () => r(true)); });
  if (!bound) { t.skip('port 8100 is in use on this Mac'); return; }
  try {
    writeCfg(setUpCfg);
    // The details answer carries the address; the list still shows none for a while.
    fake.scenario.phones = [{ udid: UDID, coreDeviceId: CORE_ID, wakesTo: '127.0.0.1', listLag: 5 }]; fake.scenario.runners = {}; fake.save();
    await backend.listDevices();
    await backend.tap!(UDID, 10, 10);
    // The details answer has no address: the list is read again until it shows one (within ~10 s).
    fake.scenario.phones = [{ udid: UDID, coreDeviceId: CORE_ID, wakesTo: '127.0.0.1', listLag: 2, detailsOmitsTunnel: true }]; fake.save();
    await backend.listDevices();
    await new Promise((r) => setTimeout(r, 3100));                     // past the list cache
    await backend.tap!(UDID, 10, 10);
    // Gone (not listed, devicectl can’t reach it): refused at once, not after ten seconds.
    fake.scenario.phones = []; fake.save();
    await backend.listDevices();
    const t0 = Date.now();
    assert.equal((await errOf(backend.tap!(UDID, 10, 10)))?.code, 'no_device');
    assert.ok(Date.now() - t0 < 5000, `refused in ${Date.now() - t0} ms`);
  } finally { server.closeAllConnections?.(); server.close(); }
});

// ── review round 2 (t1ct's Codex pass on df816f7) ──

const SIM = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE', OTHER_SIM = 'FFFFFFFF-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
/** main's simulator path, kept off the network: an existing clone, and no Xcode behind the fake developer dir. */
function mainPathOffline() { mkdirSync(join(home, 'wda', 'WebDriverAgent', 'WebDriverAgent.xcodeproj'), { recursive: true }); }
const within = <T,>(p: Promise<T>, ms = 20_000) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timed out')), ms).unref())]);

test('#5: conflicting targets are refused before anything runs or is saved', async () => {
  mainPathOffline();
  fake.scenario.phones = [{ udid: UDID, coreDeviceId: CORE_ID, tunnelIp: 'fd00:0:0:1::1' }]; fake.scenario.runners = {}; fake.save();
  writeCfg({});
  for (const [id, destination] of [[UDID, `platform=iOS Simulator,id=${SIM}`], [UDID, `platform=iOS Simulator,id=${UDID}`], [SIM, `platform=iOS Simulator,id=${OTHER_SIM}`], [SIM, 'platform=iOS Simulator,name=iPhone 16']] as const) {
    const progress: string[] = [];
    const e = await within(errOf(backend.wdaSetup(id, { destination }, (l) => progress.push(l))));
    assert.equal(e?.code, 'bad_request', `${id} + ${destination}: ${e?.message}`);
    assert.deepEqual(progress, [], 'nothing ran');
  }
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'ios-device.json'), 'utf8')), {}, 'nothing saved');
});

test('#8: same-target destination forms keep working, as on main', async () => {
  mainPathOffline();
  fake.scenario.phones = [{ udid: UDID, coreDeviceId: CORE_ID, tunnelIp: 'fd00:0:0:1::1' }]; fake.save();
  // An iPhone named the long way: Set Up Control (here it stops at preflight, with a cause), not a refusal.
  const phone = await within(errOf(backend.wdaSetup(UDID, { destination: `platform=iOS,id=${UDID}` })));
  assert.notEqual(phone?.code, 'bad_request', String(phone?.message));
  assert.ok(phone?.cause, 'Set Up Control’s error, with its cause');
  // A simulator named by id alone, or by platform and id: main's path (it says so, then fails here for want of Xcode).
  for (const destination of [`id=${SIM}`, `platform=iOS Simulator,id=${SIM}`]) {
    const progress: string[] = [];
    await within(errOf(backend.wdaSetup(SIM, { destination }, (l) => progress.push(l))));
    assert.ok(progress.some((l) => /using existing clone/.test(l)), `${destination}: main's path (${progress.join(' | ')})`);
  }
});

test('#9: an explicit PHONEDOCK_WDA_URL keeps main’s precedence; an iPhone now on iOS 27 isn’t routed to WebDriverAgent', async (t) => {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/status') { res.end(JSON.stringify({ value: { ready: true, ios: { ip: null } } })); return; }
    if (req.url === '/session') { res.end(JSON.stringify({ sessionId: 's1', value: { sessionId: 's1' } })); return; }
    res.end(JSON.stringify({ value: { width: 375, height: 812 } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const envUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const savedEnv = process.env.PHONEDOCK_WDA_URL;
  try {
    writeCfg(setUpCfg);
    fake.scenario.phones = [{ udid: UDID, coreDeviceId: CORE_ID, tunnelIp: 'fd00:0:0:1::1' }]; fake.save();
    process.env.PHONEDOCK_WDA_URL = envUrl;
    const listed = (await backend.listDevices()).find((d) => d.nativeId === UDID)!;
    assert.equal(listed.meta?.wdaUrl, envUrl);
    await backend.tap!(UDID, 10, 10);
    assert.ok(hits.some((h) => h.startsWith('POST')), 'the tap went to the explicit URL');
    delete process.env.PHONEDOCK_WDA_URL;
    fake.scenario.phones = [{ udid: UDID, coreDeviceId: CORE_ID, tunnelIp: 'fd00:0:0:1::1', osVersion: '27.0' }]; fake.save();
    const upgraded = (await backend.listDevices()).find((d) => d.nativeId === UDID)!;
    assert.deepEqual([upgraded.meta?.wdaUrl, upgraded.meta?.wdaSharing], [null, null], 'iOS 27: native input, no WebDriverAgent route');
  } finally {
    if (savedEnv === undefined) delete process.env.PHONEDOCK_WDA_URL; else process.env.PHONEDOCK_WDA_URL = savedEnv;
    server.closeAllConnections?.(); server.close();
  }
});

test('the tunnel address comes from Xcode 27’s devicectl shape (properties.connection.tunnelIPAddressString), and from the older one', async () => {
  writeCfg(setUpCfg);
  for (const legacyOnly of [false, true]) {
    fake.scenario.phones = [{ udid: UDID, coreDeviceId: CORE_ID, tunnelIp: 'fd00:0:0:1::1', legacyOnly }]; fake.scenario.runners = {}; fake.save();
    const d = (await backend.listDevices()).find((x) => x.nativeId === UDID)!;
    assert.equal(d.meta?.wdaUrl, 'http://[fd00:0:0:1::1]:8100', legacyOnly ? 'connectionProperties.tunnelIPAddress' : 'properties.connection.tunnelIPAddressString');
  }
});
