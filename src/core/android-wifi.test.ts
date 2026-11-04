import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import {
  blockedAdbError, chooseConnect, choosePairing, discoverAndroid, isConnected, isNoRoute, isPrivateHost, manyPhonesError, matchConnectService,
  mergeServices, modelOf, noPairingError, parseAddress, parseBrowse, parseLookup, responsibleApp, runWithDiagnosis, serialOf, tcpProbe,
  type AndroidPhone, type DiagnoseDeps, type DiscoverDeps,
} from './android-wifi.ts';
import { PhoneDockError } from './types.ts';

// Captured from a real phone (dns-sd on macOS).
const BROWSE = `Browsing for _adb-tls-connect._tcp.local.
DATE: ---Wed 04 Nov 2026---
19:01:32.728  ...STARTING...
Timestamp     A/R    Flags  if Domain               Service Type         Instance Name
19:01:32.730  Add        2  15 local.               _adb-tls-connect._tcp. adb-AB12CD34EF56789-x7q2pf
19:01:33.100  Add        2  15 local.               _adb-tls-connect._tcp. adb-OTHER99-abcdef
19:01:34.100  Rmv        0  15 local.               _adb-tls-connect._tcp. adb-OTHER99-abcdef
`;
const LOOKUP = `Lookup adb-AB12CD34EF56789-x7q2pf._adb-tls-connect._tcp.local.
DATE: ---Wed 04 Nov 2026---
19:01:40.941  ...STARTING...
19:01:40.942  adb-AB12CD34EF56789-x7q2pf._adb-tls-connect._tcp.local. can be reached at Android-7.local.:44995 (interface 15)
 api= name=V2246 v=1
`;
const ADDRESS = `DATE: ---Wed 04 Nov 2026---
19:01:40.942  ...STARTING...
Timestamp     A/R  Flags         IF  Hostname                               Address                                      TTL
19:01:40.943  Add  40000002      15  Android-7.local.                       192.168.0.42                                  120
`;

test('parseBrowse lists added instances and drops removed ones', () => {
  assert.deepEqual(parseBrowse(BROWSE), ['adb-AB12CD34EF56789-x7q2pf']);
  assert.deepEqual(parseBrowse(''), []);
});

test('parseLookup reads host, port and the TXT model', () => {
  const r = parseLookup(LOOKUP);
  assert.equal(r.host, 'Android-7.local');
  assert.equal(r.port, 44995);
  assert.deepEqual(r.txt, { api: '', name: 'V2246', v: '1' });
  assert.equal(modelOf(r.txt), 'V2246');
  assert.deepEqual(parseLookup('Lookup x\n...STARTING...\n'), { txt: {} });
});

test('parseLookup keeps spaces inside a TXT value', () => {
  const r = parseLookup('12:00:00.000  adb-X-abc._adb-tls-connect._tcp.local. can be reached at P.local.:1234 (interface 4)\n api=34 name=Pixel 8 Pro v=1\n');
  assert.equal(r.txt.name, 'Pixel 8 Pro');
  assert.equal(r.txt.v, '1');
  assert.equal(modelOf({ name: 'Pixel_8' }), 'Pixel 8');
});

test('parseAddress returns the IPv4 address', () => {
  assert.equal(parseAddress(ADDRESS), '192.168.0.42');
  assert.equal(parseAddress('no addresses'), undefined);
});

test('serialOf strips the adb- prefix and random suffix, and leaves QR names alone', () => {
  assert.equal(serialOf('adb-AB12CD34EF56789-x7q2pf'), 'AB12CD34EF56789');
  assert.equal(serialOf('adb-ABC-DEF-xyz123 (2)'), 'ABC-DEF');
  assert.equal(serialOf('pd-qrname'), 'pd-qrname');
});

const phone = (o: Partial<AndroidPhone>): AndroidPhone => ({ serial: 'S1', connected: false, ...o });

test('mergeServices joins the connect and pairing services of one phone by serial', () => {
  const list = mergeServices([
    { type: 'connect', instance: 'adb-S1-aaa', resolved: { host: 'A.local', port: 40000, txt: { name: 'V2246' } }, ip: '192.168.0.42' },
    { type: 'pairing', instance: 'adb-S1-bbb', resolved: { host: 'A.local', port: 41000, txt: {} }, ip: '192.168.0.42' },
    { type: 'connect', instance: 'adb-S2-ccc', resolved: { host: 'B.local', port: 40001, txt: { name: 'Pixel_8' } }, ip: '192.168.1.4' },
  ], [{ serial: '192.168.1.4:40001', state: 'device' }]);
  assert.equal(list.length, 2);
  const s1 = list.find((p) => p.serial === 'S1')!;
  assert.deepEqual([s1.model, s1.ip, s1.connectPort, s1.pairingPort, s1.connected], ['V2246', '192.168.0.42', 40000, 41000, false]);
  const s2 = list.find((p) => p.serial === 'S2')!;
  assert.deepEqual([s2.model, s2.connected, s2.pairingPort], ['Pixel 8', true, undefined]);
});

test('isConnected: online only, by serial, mDNS name or ip:port', () => {
  const p = { serial: 'S1', ip: '10.0.0.5', connectPort: 4000 };
  assert.equal(isConnected(p, [{ serial: '10.0.0.5:4000', state: 'device' }]), true);
  assert.equal(isConnected(p, [{ serial: 'adb-S1-xyz._adb-tls-connect._tcp', state: 'device' }]), true);
  assert.equal(isConnected(p, [{ serial: 'S1', state: 'device' }]), true);
  assert.equal(isConnected(p, [{ serial: '10.0.0.5:4000', state: 'offline' }]), false);
  assert.equal(isConnected(p, [{ serial: '10.0.0.5:9999', state: 'device' }]), false);
  assert.equal(isConnected(p, []), false);
});

test('choosePairing: none, one or several pairing screens; --serial narrows', () => {
  const a = phone({ serial: 'A', pairingPort: 1, connectPort: 2 });
  const b = phone({ serial: 'B', pairingPort: 3 });
  const c = phone({ serial: 'C', connectPort: 4 });
  assert.deepEqual(choosePairing([c], undefined), { kind: 'none' });
  assert.deepEqual(choosePairing([], undefined), { kind: 'none' });
  assert.deepEqual(choosePairing([a, c], undefined), { kind: 'one', phone: a });
  assert.equal(choosePairing([a, b, c], undefined).kind, 'many');
  assert.deepEqual(choosePairing([a, b], 'B'), { kind: 'one', phone: b });
  assert.deepEqual(choosePairing([a, b], 'nope'), { kind: 'none' });
});

test('chooseConnect: skips connected phones unless named', () => {
  const a = phone({ serial: 'A', connectPort: 1 });
  const done = phone({ serial: 'D', connectPort: 2, connected: true });
  assert.deepEqual(chooseConnect([a, done]), { kind: 'one', phone: a });
  assert.equal(chooseConnect([a, phone({ serial: 'B', connectPort: 5 })]).kind, 'many');
  assert.deepEqual(chooseConnect([done]), { kind: 'none' });
  assert.deepEqual(chooseConnect([a, done], 'D'), { kind: 'one', phone: done });
  assert.deepEqual(chooseConnect([phone({ serial: 'P', pairingPort: 9 })]), { kind: 'none' });
});

test('matchConnectService: same serial first, then same IP (QR pairing names differ)', () => {
  const connect = phone({ serial: 'REAL', ip: '10.0.0.7', connectPort: 5000 });
  const other = phone({ serial: 'OTHER', ip: '10.0.0.8', connectPort: 5001 });
  assert.equal(matchConnectService([other, connect], { serial: 'REAL', ip: '10.0.0.7' }), connect);
  assert.equal(matchConnectService([other, connect], { serial: 'pd-qr', ip: '10.0.0.7' }), connect);
  assert.equal(matchConnectService([other], { serial: 'pd-qr', ip: '10.0.0.7' }), undefined);
  assert.equal(matchConnectService([phone({ serial: 'REAL' })], { serial: 'REAL' }), undefined);
});

test('error messages tell the user what to open or choose', () => {
  assert.match(noPairingError().hints!.join(' '), /Open Wireless debugging › Pair device with pairing code on the phone and keep it open/);
  const e = manyPhonesError('pair', [phone({ serial: 'A', model: 'X' }), phone({ serial: 'B' })]);
  assert.equal(e.code, 'ambiguous_phone');
  assert.match(e.hints!.join(' '), /--serial A or --serial B/);
});

test('discoverAndroid browses both services with injected fakes', async () => {
  const deps: DiscoverDeps = {
    browse: async (type) => type === '_adb-tls-connect._tcp' ? ['adb-S1-aaa'] : ['adb-S1-bbb'],
    lookup: async (inst) => ({ host: 'A.local', port: inst.endsWith('aaa') ? 40000 : 41000, txt: (inst.endsWith('aaa') ? { name: 'V2246' } : {}) as Record<string, string> }),
    address: async () => '192.168.0.42',
    adbDevices: async () => [],
  };
  const list = await discoverAndroid(deps);
  assert.deepEqual(list, [{ serial: 'S1', connected: false, host: 'A.local', ip: '192.168.0.42', model: 'V2246', connectPort: 40000, connectInstance: 'adb-S1-aaa', pairingPort: 41000, pairingInstance: 'adb-S1-bbb' }]);
  // A service that fails to resolve is skipped, and an adb failure doesn't break discovery.
  const list2 = await discoverAndroid({ ...deps, lookup: async () => ({ txt: {} }), adbDevices: async () => { throw new Error('x'); } });
  assert.deepEqual(list2, []);
});

test('private-address and no-route detection', () => {
  assert.equal(isNoRoute('failed to connect to 192.168.0.42:44995: No route to host'), true);
  assert.equal(isNoRoute('EHOSTUNREACH'), true);
  assert.equal(isNoRoute('connection refused'), false);
  for (const h of ['192.168.0.42', '10.1.2.3', '172.16.0.1', '172.31.255.1', '169.254.1.1', 'Android-7.local']) assert.equal(isPrivateHost(h), true, h);
  for (const h of ['8.8.8.8', '172.32.0.1', 'example.com']) assert.equal(isPrivateHost(h), false, h);
  assert.equal(responsibleApp({}), 'PhoneDock');
  assert.equal(responsibleApp({ TERM_PROGRAM: 'Apple_Terminal' }), 'Terminal');
  assert.equal(responsibleApp({ TERM_PROGRAM: 'iTerm.app' }), 'iTerm');
});

// ── diagnosis branches ──────────────────────────────────────────────────────

const NO_ROUTE = 'failed to connect to 192.168.0.42:44995: No route to host';
function fakes(opts: { reachable: boolean; results: { ok: boolean; out: string }[] }) {
  const log: string[] = [];
  const results = [...opts.results];
  const deps: DiagnoseDeps = {
    probe: async (h, p) => { log.push(`probe ${h}:${p}`); return opts.reachable; },
    restartAdb: async () => { log.push('restart'); },
    responsible: () => 'Terminal',
  };
  const attempt = async () => { log.push('attempt'); return results.shift() ?? { ok: false, out: NO_ROUTE }; };
  return { deps, attempt, log };
}
const target = { host: '192.168.0.42', port: 44995 };

test('diagnosis: success needs no probe', async () => {
  const f = fakes({ reachable: true, results: [{ ok: true, out: 'connected' }] });
  assert.deepEqual(await runWithDiagnosis(f.attempt, target, {}, f.deps), { ok: true, out: 'connected' });
  assert.deepEqual(f.log, ['attempt']);
});

test('diagnosis: ordinary failures are handed back, with no probe', async () => {
  const f = fakes({ reachable: true, results: [{ ok: false, out: 'wrong code' }] });
  assert.deepEqual(await runWithDiagnosis(f.attempt, target, {}, f.deps), { ok: false, out: 'wrong code' });
  const g = fakes({ reachable: true, results: [{ ok: false, out: NO_ROUTE }] });
  assert.deepEqual(await runWithDiagnosis(g.attempt, { host: '8.8.8.8', port: 1 }, {}, g.deps), { ok: false, out: NO_ROUTE });
  assert.deepEqual(g.log, ['attempt']);
});

test('diagnosis: daemon can reach the phone, no option -> blocked adb error, adb never restarted', async () => {
  const f = fakes({ reachable: true, results: [{ ok: false, out: NO_ROUTE }] });
  await assert.rejects(runWithDiagnosis(f.attempt, target, {}, f.deps), (e: unknown) => {
    assert.ok(e instanceof PhoneDockError);
    assert.equal(e.code, 'adb_blocked_local_network');
    assert.match(e.hints!.join(' '), /--restart-adb/);
    assert.match(e.hints!.join(' '), /Android Studio/);
    return true;
  });
  assert.deepEqual(f.log, ['attempt', 'probe 192.168.0.42:44995']);
});

test('diagnosis: restartAdb restarts once and retries; a good retry succeeds', async () => {
  const f = fakes({ reachable: true, results: [{ ok: false, out: NO_ROUTE }, { ok: true, out: 'connected to x' }] });
  assert.deepEqual(await runWithDiagnosis(f.attempt, target, { restartAdb: true }, f.deps), { ok: true, out: 'connected to x' });
  assert.deepEqual(f.log, ['attempt', 'probe 192.168.0.42:44995', 'restart', 'attempt']);
});

test('diagnosis: still no route after the restart is reported, not looped', async () => {
  const f = fakes({ reachable: true, results: [{ ok: false, out: NO_ROUTE }, { ok: false, out: NO_ROUTE }] });
  await assert.rejects(runWithDiagnosis(f.attempt, target, { restartAdb: true }, f.deps), (e: unknown) => (e as PhoneDockError).code === 'adb_blocked_local_network' && /still/.test((e as Error).message));
  assert.equal(f.log.filter((l) => l === 'restart').length, 1);
});

test('diagnosis: a different failure after the restart is handed back', async () => {
  const f = fakes({ reachable: true, results: [{ ok: false, out: NO_ROUTE }, { ok: false, out: 'unauthorized' }] });
  assert.deepEqual(await runWithDiagnosis(f.attempt, target, { restartAdb: true }, f.deps), { ok: false, out: 'unauthorized' });
});

test('diagnosis: daemon cannot reach the phone either -> permission error, even with restartAdb', async () => {
  for (const restartAdb of [false, true]) {
    const f = fakes({ reachable: false, results: [{ ok: false, out: NO_ROUTE }] });
    await assert.rejects(runWithDiagnosis(f.attempt, target, { restartAdb }, f.deps), (e: unknown) => {
      assert.ok(e instanceof PhoneDockError);
      assert.equal(e.code, 'local_network_denied');
      assert.match(e.hints!.join(' '), /System Settings › Privacy & Security › Local Network and turn on Terminal/);
      return true;
    });
    assert.ok(!f.log.includes('restart'));
  }
});

test('blockedAdbError mentions the briefly-disconnected adb users', () => {
  assert.match(blockedAdbError('10.0.0.1').hints![0], /briefly disconnects other adb users/);
});

test('tcpProbe: true for an open port, false for a closed one', async () => {
  const srv = createServer((s) => s.destroy());
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  assert.equal(await tcpProbe('127.0.0.1', port, 1000), true);
  await new Promise<void>((r) => srv.close(() => r()));
  assert.equal(await tcpProbe('127.0.0.1', port, 1000), false);
});
