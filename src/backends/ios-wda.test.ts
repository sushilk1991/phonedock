// WebDriverAgent setup and supervision with fakes only: no Xcode account, no phone, no xcodebuild, no network.
// Team ids, udids and names below are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, cpSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhoneDockError, type ExecResult } from '../core/types.ts';
import {
  UPSTREAM_RUNNER_BUNDLE_ID, WdaSupervisor, buildArgv, buildKey, chooseTeam, classifyXcodebuild, ensureBuild, launchArgv, runBuild,
  launchWda, parseApiKey, parseXcodeTeams, preflight, pruneBuilds, readProfile, readXcodeInfo, readXcodeTeams, rebuildReason,
  runnerBundleId, startRunner, type ChildLike, type Exec, type PhoneFacts, type ProbeResult, type Runner, type SupervisorDeps, type WdaBuildDeps, type XcodeInfo,
} from './ios-wda.ts';

export const TUNNEL_IP = 'fd00:0:0:1::1';
const URL_A = `http://[${TUNNEL_IP}]:8100`;
export const WIFI_IP = '192.0.2.10';

const TEAM_A = 'AAAAA11111', TEAM_B = 'BBBBB22222', TEAM_FREE = 'FFFFF33333';
const UDID = '00008020-0000AAAA0000BBBB';

// ── teams ──

test('parseXcodeTeams reads the defaults shape, accepts true and 1 for free teams, and lists a team once', () => {
  const raw = {
    'ACCOUNT-1': [
      { isFreeProvisioningTeam: false, teamID: TEAM_A, teamName: 'Example Co', teamType: 'Company' },
      { isFreeProvisioningTeam: 1, teamID: TEAM_FREE, teamName: 'Pat Example (Personal Team)', teamType: 'Individual' },
    ],
    'ACCOUNT-2': [
      { isFreeProvisioningTeam: 0, teamID: TEAM_A, teamName: 'Example Co', teamType: 'Company' },
      { isFreeProvisioningTeam: true, teamID: TEAM_B, teamName: 'Beta Labs' },
      { teamID: 'short', teamName: 'bad id' },
      'junk',
    ],
  };
  assert.deepEqual(parseXcodeTeams(raw), [
    { id: TEAM_B, name: 'Beta Labs', free: true },
    { id: TEAM_A, name: 'Example Co', type: 'Company', free: false },
    { id: TEAM_FREE, name: 'Pat Example (Personal Team)', type: 'Individual', free: true },
  ]);
  assert.deepEqual(parseXcodeTeams(undefined), []);
  assert.deepEqual(parseXcodeTeams([]), []);
  assert.deepEqual(parseXcodeTeams({ x: 'nope' }), []);
});

test('readXcodeTeams exports the Xcode domain and extracts only the teams key; no domain or key means no teams', async () => {
  const calls: string[][] = [];
  const exec = (mode: 'ok' | 'nodomain' | 'nokey'): Exec => async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === '/usr/bin/defaults') {
      if (mode === 'nodomain') return { code: 1, stdout: '', stderr: 'Domain com.apple.dt.Xcode does not exist' };
      writeFileSync(args[2], '<plist/>');
      return { code: 0, stdout: '', stderr: '' };
    }
    if (mode === 'nokey') return { code: 1, stdout: '', stderr: 'No value at that key path' };
    return { code: 0, stdout: JSON.stringify({ acct: [{ teamID: TEAM_A, teamName: 'Example Co', isFreeProvisioningTeam: false }] }), stderr: '' };
  };
  assert.deepEqual(await readXcodeTeams(exec('ok')), [{ id: TEAM_A, name: 'Example Co', free: false }]);
  assert.deepEqual(calls[0].slice(0, 3), ['/usr/bin/defaults', 'export', 'com.apple.dt.Xcode']);
  assert.deepEqual(calls[1].slice(0, 4), ['/usr/bin/plutil', '-extract', 'IDEProvisioningTeamByIdentifier', 'json']);
  assert.ok(!existsSync(calls[0][3]), 'the exported domain is deleted afterwards');
  assert.deepEqual(await readXcodeTeams(exec('nodomain')), []);
  assert.deepEqual(await readXcodeTeams(exec('nokey')), []);
});

test('chooseTeam: none → sign in (naming the API key), one → it, several → a choice, free teams flagged', () => {
  const a = { id: TEAM_A, name: 'Example Co', type: 'Company', free: false };
  const b = { id: TEAM_B, name: 'Beta Labs', free: false };
  const f = { id: TEAM_FREE, name: 'Personal', free: true };
  const none = (() => { try { chooseTeam([], {}); } catch (e) { return e as PhoneDockError; } })()!;
  assert.equal(none.code, 'xcode_account_missing');
  assert.match(none.message, /Sign in to Xcode/);
  assert.match(none.hints!.join(' '), /Xcode › Settings › Accounts/);
  assert.match(none.hints!.join(' '), /--api-key-path/);

  assert.deepEqual(chooseTeam([a], {}), { id: TEAM_A, free: false, name: 'Example Co' });
  assert.deepEqual(chooseTeam([f], {}), { id: TEAM_FREE, free: true, name: 'Personal' });

  const several = (() => { try { chooseTeam([a, b], {}); } catch (e) { return e as PhoneDockError; } })()!;
  assert.equal(several.code, 'team_required');
  assert.equal(several.status, 409);
  assert.match(several.detail!, new RegExp(`${TEAM_A}.*${TEAM_B}|${TEAM_B}.*${TEAM_A}`));
  assert.deepEqual(chooseTeam([a, b], { team: TEAM_B }), { id: TEAM_B, free: false, name: 'Beta Labs' });

  // The team this phone used last (set up before, or stopped) needs no new choice; one Xcode no longer has does.
  assert.deepEqual(chooseTeam([a, b], { remembered: TEAM_B }), { id: TEAM_B, free: false, name: 'Beta Labs' });
  assert.throws(() => chooseTeam([a, b], { remembered: 'ZZZZZZZZZZ' }), (e: PhoneDockError) => e.code === 'team_required');
  assert.deepEqual(chooseTeam([a, b], { team: TEAM_A, remembered: TEAM_B }).id, TEAM_A, 'an explicit team wins');
  assert.throws(() => chooseTeam([a], { team: 'nope' }), (e: PhoneDockError) => e.code === 'bad_request');
  assert.throws(() => chooseTeam([a], { team: TEAM_B }), (e: PhoneDockError) => e.code === 'team_unknown');
  assert.throws(() => chooseTeam([], { team: TEAM_B }), (e: PhoneDockError) => e.code === 'xcode_account_missing');

  // An App Store Connect key stands in for the Xcode account; it still needs a team.
  const key = { path: '/k/AuthKey_KEYID12345.p8', keyId: 'KEYID12345', issuerId: '11111111-2222-3333-4444-555555555555' };
  assert.deepEqual(chooseTeam([], { team: TEAM_B, apiKey: key }), { id: TEAM_B, free: false });
  assert.throws(() => chooseTeam([], { apiKey: key }), (e: PhoneDockError) => e.code === 'team_required');
});

test('parseApiKey needs all three parts, an existing .p8 path and well-formed ids', () => {
  const exists = (p: string) => p === '/keys/AuthKey_KEYID12345.p8';
  assert.equal(parseApiKey({}, exists), undefined);
  assert.deepEqual(parseApiKey({ path: '/keys/AuthKey_KEYID12345.p8', keyId: 'KEYID12345', issuerId: '11111111-2222-3333-4444-555555555555' }, exists),
    { path: '/keys/AuthKey_KEYID12345.p8', keyId: 'KEYID12345', issuerId: '11111111-2222-3333-4444-555555555555' });
  assert.throws(() => parseApiKey({ path: '/keys/AuthKey_KEYID12345.p8' }, exists), /file, key ID and issuer ID/);
  assert.throws(() => parseApiKey({ path: '/keys/missing.p8', keyId: 'KEYID12345', issuerId: '11111111-2222-3333-4444-555555555555' }, exists), /Couldn’t find/);
  assert.throws(() => parseApiKey({ path: 'relative.p8', keyId: 'KEYID12345', issuerId: '11111111-2222-3333-4444-555555555555' }, () => true), /Couldn’t find/);
  assert.throws(() => parseApiKey({ path: '/keys/AuthKey_KEYID12345.p8', keyId: 'short', issuerId: '11111111-2222-3333-4444-555555555555' }, exists), /key ID/);
  assert.throws(() => parseApiKey({ path: '/keys/AuthKey_KEYID12345.p8', keyId: 'KEYID12345', issuerId: 'nope' }, exists), /issuer ID/);
});

test('runner bundle id: upstream for paid teams, a team-specific one for personal teams', () => {
  assert.equal(runnerBundleId(TEAM_A, false), UPSTREAM_RUNNER_BUNDLE_ID);
  assert.equal(runnerBundleId(TEAM_FREE, true), 'dev.phonedock.wda.fffff33333');
});

// ── preflight ──

test('preflight names the first thing to fix, before any build', () => {
  const xcode: XcodeInfo = { build: '27B52', version: '27.2', minIos: '17.0' };
  const ok: PhoneFacts = { found: true, paired: true, reachable: true, osVersion: '18.7', developerMode: true, locked: false };
  const code = (x: XcodeInfo | undefined, p: PhoneFacts | undefined) => preflight(x, p, UDID)?.code;
  assert.equal(code(undefined, ok), 'xcode_missing');
  assert.equal(code(xcode, undefined), 'not_found');
  assert.equal(code(xcode, { found: false }), 'not_found');
  assert.equal(code(xcode, { ...ok, paired: false }), 'not_paired');
  assert.equal(code(xcode, { ...ok, reachable: false }), 'no_device');
  assert.equal(code(xcode, { ...ok, osVersion: '16.7' }), 'ios_unsupported');
  assert.match(preflight(xcode, { ...ok, osVersion: '16.7' }, UDID)!.hints![0], /iOS 17 or later/);
  assert.equal(code({ build: 'X' }, { ...ok, osVersion: '14.8' }), 'ios_unsupported');     // the pinned WDA's own minimum
  assert.equal(code({ build: 'X' }, { ...ok, osVersion: '16.7' }), undefined);
  assert.equal(code(xcode, { ...ok, developerMode: false }), 'developer_mode_off');
  assert.equal(code(xcode, { ...ok, locked: true }), 'device_locked');
  assert.equal(code(xcode, { ...ok, locked: null, developerMode: null }), undefined);       // unknown: go ahead
  assert.equal(code(xcode, ok), undefined);
});

test('readXcodeInfo reads the Xcode build and the minimum iOS of its XCTest', async () => {
  const dev = mkdtempSync(join(tmpdir(), 'pd-wda-dev-'));
  try {
    const fw = join(dev, 'Platforms', 'iPhoneOS.platform', 'Developer', 'Library', 'Frameworks', 'XCTest.framework');
    mkdirSync(fw, { recursive: true }); writeFileSync(join(fw, 'XCTest'), '');
    const exec: Exec = async (_c, args) => args[0] === 'xcodebuild'
      ? { code: 0, stdout: 'Xcode 27.2\nBuild version 27B52\n', stderr: '' }
      : { code: 0, stdout: 'Load command 10\n      cmd LC_BUILD_VERSION\n platform IOS\n    minos 17.0\n      sdk 27.2\n', stderr: '' };
    assert.deepEqual(await readXcodeInfo(exec, dev), { build: '27B52', version: '27.2', minIos: '17.0' });
    assert.equal(await readXcodeInfo(async () => ({ code: 1, stdout: '', stderr: 'xcode-select: error' }), dev), undefined);
  } finally { rmSync(dev, { recursive: true, force: true }); }
});

// ── xcodebuild argv ──

test('build-for-testing registers the phone, signs automatically, and takes an API key; launch only runs the xctestrun', () => {
  const base = { project: '/b/src/WebDriverAgent.xcodeproj', derivedData: '/b/DerivedData', destination: `id=${UDID}`, team: TEAM_A, bundleId: UPSTREAM_RUNNER_BUNDLE_ID };
  const a = buildArgv(base);
  assert.equal(a[0], 'build-for-testing');
  assert.ok(!a.includes('test'), 'never `xcodebuild test` (it builds and runs in one go)');
  const i = a.indexOf('-allowProvisioningDeviceRegistration');
  assert.ok(i > 0 && a.includes('-allowProvisioningUpdates'), 'registration needs both provisioning flags');
  assert.deepEqual(a.slice(a.indexOf('-destination'), a.indexOf('-destination') + 2), ['-destination', `id=${UDID}`]);
  assert.deepEqual(a.slice(a.indexOf('-derivedDataPath'), a.indexOf('-derivedDataPath') + 2), ['-derivedDataPath', '/b/DerivedData']);
  assert.ok(a.includes(`DEVELOPMENT_TEAM=${TEAM_A}`) && a.includes('CODE_SIGN_STYLE=Automatic'));
  assert.ok(!a.some((x) => x.startsWith('PRODUCT_BUNDLE_IDENTIFIER=')), 'paid teams keep upstream’s id');
  assert.ok(!a.includes('-authenticationKeyPath'));

  const k = buildArgv({ ...base, team: TEAM_FREE, bundleId: runnerBundleId(TEAM_FREE, true),
    apiKey: { path: '/keys/AuthKey_KEYID12345.p8', keyId: 'KEYID12345', issuerId: '11111111-2222-3333-4444-555555555555' } });
  assert.deepEqual(k.slice(k.indexOf('-authenticationKeyPath'), k.indexOf('-authenticationKeyPath') + 6),
    ['-authenticationKeyPath', '/keys/AuthKey_KEYID12345.p8', '-authenticationKeyID', 'KEYID12345', '-authenticationKeyIssuerID', '11111111-2222-3333-4444-555555555555']);
  assert.ok(k.includes('PRODUCT_BUNDLE_IDENTIFIER=dev.phonedock.wda.fffff33333'));

  assert.deepEqual(launchArgv('/b/DerivedData/Build/Products/WebDriverAgentRunner_iphoneos27.2-arm64.xctestrun', `id=${UDID}`),
    ['test-without-building', '-xctestrun', '/b/DerivedData/Build/Products/WebDriverAgentRunner_iphoneos27.2-arm64.xctestrun', '-destination', `id=${UDID}`]);
});

test('build key changes with the WebDriverAgent version, team, Xcode build and bundle id', () => {
  const k = { wdaVersion: '16.15.3', team: TEAM_A, xcodeBuild: '27B52', bundleId: UPSTREAM_RUNNER_BUNDLE_ID };
  const base = buildKey(k);
  assert.match(base, /^16\.15\.3-AAAAA11111-27B52-[0-9a-f]{8}$/);
  for (const change of [{ wdaVersion: '16.16.0' }, { team: TEAM_B }, { xcodeBuild: '27C10' }, { bundleId: 'dev.phonedock.wda.x' }]) {
    assert.notEqual(buildKey({ ...k, ...change }), base, JSON.stringify(change));
  }
  assert.equal(buildKey({ ...k }), base);
});

test('rebuild triggers: no build, expired or expiring signing, a phone missing from the profile', () => {
  const now = Date.parse('2026-11-24T12:00:00Z');
  const xctestrun = '/b/x.xctestrun';
  const good = { expiresAt: now + 5 * 86_400_000, devices: [UDID.toLowerCase()], allDevices: false };
  assert.match(rebuildReason({ now, device: true, udid: UDID })!, /not built/);
  assert.equal(rebuildReason({ xctestrun, profile: good, udid: UDID, now, device: true }), undefined);
  assert.match(rebuildReason({ xctestrun, profile: { ...good, expiresAt: now - 1 }, udid: UDID, now, device: true })!, /expired/);
  assert.match(rebuildReason({ xctestrun, profile: { ...good, expiresAt: now + 3_600_000 }, udid: UDID, now, device: true })!, /expires within a day/);
  assert.match(rebuildReason({ xctestrun, profile: { ...good, devices: ['00008030-1111'] }, udid: UDID, now, device: true })!, /isn’t in its provisioning profile/);
  assert.equal(rebuildReason({ xctestrun, profile: { ...good, devices: ['00008030-1111'], allDevices: true }, udid: UDID, now, device: true }), undefined);
  assert.match(rebuildReason({ xctestrun, udid: UDID, now, device: true })!, /no provisioning profile/);
  assert.equal(rebuildReason({ xctestrun, now, device: false }), undefined);   // simulator destination
});

test('readProfile decodes embedded.mobileprovision with security cms and reads expiry and devices', async () => {
  const app = mkdtempSync(join(tmpdir(), 'pd-wda-app-'));
  try {
    assert.equal(await readProfile(app, async () => { throw new Error('not called'); }), undefined);
    writeFileSync(join(app, 'embedded.mobileprovision'), 'cms');
    const seen: string[][] = [];
    const exec: Exec = async (cmd, args) => {
      seen.push([cmd, ...args]);
      if (cmd === '/usr/bin/security') { writeFileSync(args[args.indexOf('-o') + 1], '<plist/>'); return { code: 0, stdout: '', stderr: '' }; }
      if (args[1] === 'ExpirationDate') return { code: 0, stdout: '2026-12-01T10:20:30Z\n', stderr: '' };
      if (args[1] === 'ProvisionedDevices') return { code: 0, stdout: JSON.stringify([UDID]), stderr: '' };
      return { code: 1, stdout: '', stderr: 'No value at that key path' };
    };
    assert.deepEqual(await readProfile(app, exec), { allDevices: false, expiresAt: Date.parse('2026-12-01T10:20:30Z'), devices: [UDID] });
    assert.deepEqual(seen[0].slice(0, 4), ['/usr/bin/security', 'cms', '-D', '-i']);
  } finally { rmSync(app, { recursive: true, force: true }); }
});

test('xcodebuild failures become plain errors; unknown ones keep the old wda_setup_failed code', () => {
  const c = (t: string, phase: 'build' | 'launch' = 'build') => classifyXcodebuild(t, phase, { team: TEAM_A, udid: UDID }).code;
  assert.equal(c('error: No Accounts: Add a new account in Accounts settings.'), 'xcode_account_missing');
  assert.equal(c('error: Provisioning profile "iOS Team Provisioning Profile: *" doesn\'t include the currently selected device "Phone" (identifier X).'), 'device_not_registered');
  assert.equal(c('error: Failed to register bundle identifier: The app identifier "com.facebook.WebDriverAgentRunner.xctrunner" cannot be registered to your development team'), 'bundle_id_unavailable');
  assert.equal(c('error: Your maximum App ID limit has been reached. You may create up to 10 App IDs every 7 days.'), 'signing_limit');
  assert.equal(c('The application could not be launched because the Developer App Certificate is not trusted. Verify the Developer App certificate for your account is trusted on your device.', 'launch'), 'wda_untrusted');
  // iOS's generic sentence alone doesn't say which: kept apart from the trust prompt (#9).
  assert.equal(c('Unable to launch com.facebook.WebDriverAgentRunner.xctrunner because it has an invalid code signature, inadequate entitlements or its profile has not been explicitly trusted by the user.', 'launch'), 'signature_invalid');
  assert.equal(c('Untrusted Developer: Your device management settings do not allow apps from developer "Apple Development: X" on this iPhone.', 'launch'), 'wda_untrusted');
  assert.equal(c('error: The provisioning profile has expired.', 'launch'), 'signing_expired');
  assert.equal(c('Unlock Phone to Continue: The device is passcode protected.', 'launch'), 'device_locked');
  assert.equal(c('Developer Mode disabled. To use Phone for development, enable Developer Mode in Settings', 'launch'), 'developer_mode_off');
  assert.equal(c('xcodebuild: error: Unable to find a destination matching the provided destination specifier', 'launch'), 'no_device');
  const other = classifyXcodebuild('lots of output\n** TEST BUILD FAILED **', 'build');
  assert.equal(other.code, 'wda_setup_failed');
  assert.match(other.detail!, /TEST BUILD FAILED/);
});

// ── running xcodebuild (fake children) ──

class FakeChild extends EventEmitter implements ChildLike {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: string[] = [];
  closed = false;
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean { this.killed.push(signal); this.exit(130); return true; }
  say(text: string): void { this.stdout.write(text.endsWith('\n') ? text : text + '\n'); }
  exit(code: number): void {
    if (this.closed) return; this.closed = true;
    this.stdout.end(); this.stderr.end();
    setImmediate(() => this.emit('close', code));
  }
}

test('progress says each step once: signing several targets, several test suites starting', async () => {
  const kids: FakeChild[] = [];
  const spawn = () => { const k = new FakeChild(); kids.push(k); return k; };
  const progress: string[] = [];
  const plan = { project: '/b/src/WebDriverAgent.xcodeproj', derivedData: '/b/DD', destination: `id=${UDID}`, team: TEAM_A, bundleId: UPSTREAM_RUNNER_BUNDLE_ID };
  const b = runBuild(spawn, plan, {}, (l) => progress.push(l));
  for (let i = 0; i < 3; i++) { kids[0].say('Signing Identity:     "Apple Development: Example (XXXXXXXXXX)"'); kids[0].say('Provisioning Profile: "iOS Team Provisioning Profile: *"'); }
  kids[0].say('** TEST BUILD SUCCEEDED **');
  kids[0].exit(0);
  await b;
  assert.deepEqual(progress, ['Signing WebDriverAgent…', 'Provisioning profile ready', 'WebDriverAgent built']);

  progress.length = 0;
  const r = startRunner(spawn, { xctestrun: '/b/x.xctestrun', destination: `id=${UDID}`, env: {}, now: () => 1 }, (l) => progress.push(l));
  for (let i = 0; i < 4; i++) kids[1].say(`Test Suite 'Suite ${i}' started at 2026-11-24`);
  kids[1].say('Testing started');
  kids[1].say('ServerURLHere->http://192.0.2.10:8100<-ServerURLHere');
  const { runner } = await r;
  assert.deepEqual(progress, ['Starting WebDriverAgent on the iPhone…']);
  runner.kill();
});

test('startRunner resolves at ServerURLHere and keeps xcodebuild running; an early exit is classified', async () => {
  const kids: FakeChild[] = [];
  const argv: string[][] = [];
  const spawn = (cmd: string, args: string[]) => { argv.push([cmd, ...args]); const k = new FakeChild(); kids.push(k); return k; };
  const progress: string[] = [];
  const p = startRunner(spawn, { xctestrun: '/b/x.xctestrun', destination: `id=${UDID}`, env: {}, now: () => 1000, udid: UDID, team: TEAM_A }, (l) => progress.push(l));
  kids[0].say('Test Suite \'All tests\' started at 2026-11-24');
  kids[0].say('    t =     0.00s Start Test at 2026-11-24 ServerURLHere->http://192.0.2.10:8100<-ServerURLHere');
  const { runner, url } = await p;
  assert.equal(url, 'http://192.0.2.10:8100');
  assert.deepEqual(argv[0], ['xcodebuild', 'test-without-building', '-xctestrun', '/b/x.xctestrun', '-destination', `id=${UDID}`]);
  assert.ok(runner.alive());
  assert.ok(progress.some((l) => /Starting WebDriverAgent/.test(l)));
  kids[0].exit(0);
  await runner.exited;
  assert.equal(runner.alive(), false);

  const q = startRunner(spawn, { xctestrun: '/b/x.xctestrun', destination: `id=${UDID}`, env: {}, now: () => 1000 }, () => undefined);
  kids[1].say('Unable to launch com.facebook.WebDriverAgentRunner.xctrunner because it has an invalid code signature, inadequate entitlements or its profile has not been explicitly trusted by the user.');
  kids[1].exit(65);
  await assert.rejects(q, (e: PhoneDockError) => e.code === 'signature_invalid');

  const r = startRunner(spawn, { xctestrun: '/b/x.xctestrun', destination: `id=${UDID}`, env: {}, now: () => 1000, timeoutMs: 30 }, () => undefined);
  await assert.rejects(r, (e: PhoneDockError) => e.status === 504);
  assert.deepEqual(kids[2].killed, ['SIGINT'], 'a runner that never printed its address is stopped');
});

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'pd-wda-builds-'));
  const srcDir = join(root, 'component', 'WebDriverAgent-16.15.3');
  mkdirSync(join(srcDir, 'WebDriverAgent.xcodeproj'), { recursive: true });
  writeFileSync(join(srcDir, 'WebDriverAgent.xcodeproj', 'project.pbxproj'), '');
  let now = Date.parse('2026-11-24T12:00:00Z');
  const builds: string[][] = [];
  const launches: string[][] = [];
  const kids: FakeChild[] = [];
  let expiry = now + 6 * 86_400_000;
  // undefined: behave like WebDriverAgent (print the address it was told to bind, else its Wi-Fi address).
  let launchSays: string[] | undefined;
  let launchExit: number | undefined;
  const launchEnvs: NodeJS.ProcessEnv[] = [];
  const probes = new Map<string, ProbeResult>();
  const spawn = (cmd: string, args: string[], o: { env?: NodeJS.ProcessEnv } = {}) => {
    const k = new FakeChild(); kids.push(k);
    if (args[0] === 'build-for-testing') {
      builds.push(args);
      const dd = args[args.indexOf('-derivedDataPath') + 1];
      setImmediate(() => {
        const prod = join(dd, 'Build', 'Products');
        mkdirSync(join(prod, 'Debug-iphoneos', 'WebDriverAgentRunner-Runner.app'), { recursive: true });
        writeFileSync(join(prod, 'WebDriverAgentRunner_iphoneos27.2-arm64.xctestrun'), '<plist/>');
        writeFileSync(join(prod, 'Debug-iphoneos', 'WebDriverAgentRunner-Runner.app', 'embedded.mobileprovision'), 'cms');
        k.say('** TEST BUILD SUCCEEDED **'); k.exit(0);
      });
    } else {
      launches.push(args); launchEnvs.push(o.env ?? {});
      const ip = o.env?.TEST_RUNNER_USE_IP ?? WIFI_IP;
      const says = launchSays ?? [`ServerURLHere->http://${ip}:${o.env?.TEST_RUNNER_USE_PORT ?? 8100}<-ServerURLHere`];
      setImmediate(() => { for (const l of says) k.say(l); if (launchExit !== undefined) k.exit(launchExit); });
    }
    return k;
  };
  const exec: Exec = async (cmd, args): Promise<ExecResult> => {
    if (cmd === '/usr/bin/security') { writeFileSync(args[args.indexOf('-o') + 1], '<plist/>'); return { code: 0, stdout: '', stderr: '' }; }
    if (args[1] === 'ExpirationDate') return { code: 0, stdout: new Date(expiry).toISOString(), stderr: '' };
    if (args[1] === 'ProvisionedDevices') return { code: 0, stdout: JSON.stringify([UDID]), stderr: '' };
    return { code: 1, stdout: '', stderr: '' };
  };
  let installs = 0;
  const d: WdaBuildDeps = {
    exec, spawn, now: () => now, env: {}, buildsDir: join(root, 'wda-builds'),
    source: async () => { installs++; return { path: srcDir, version: '16.15.3' }; },
    xcode: async () => ({ build: '27B52', version: '27.2', minIos: '17.0' }),
    copyTree: async (from, to) => { cpSync(from, to, { recursive: true }); },
    writeFile: (p, t) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, t); },
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    remove: (p) => rmSync(p, { recursive: true, force: true }),
    endpoint: async () => ({ host: TUNNEL_IP, lanName: 'Old-iPhone.local' }),
    getJson: async () => ({ value: { ready: true, ios: { ip: WIFI_IP } } }),
    probe: async (host, port) => probes.get(`${host}:${port}`) ?? 'refused',
  };
  return {
    root, d, builds, launches, kids, launchEnvs, probes,
    get installs() { return installs; },
    advance(ms: number) { now += ms; },
    setExpiry(t: number) { expiry = t; },
    get now() { return now; },
    launchWith(says: string[] | undefined, exit?: number) { launchSays = says; launchExit = exit; },
  };
}

test('build once, then launch without rebuilding; rebuild when signing nears expiry or a key changes', async () => {
  const f = buildFixture();
  try {
    const cfg = { team: TEAM_A, free: false, bundleId: UPSTREAM_RUNNER_BUNDLE_ID };
    const progress: string[] = [];
    const b1 = await ensureBuild(f.d, UDID, cfg, (l) => progress.push(l));
    assert.equal(b1.built, true);
    assert.equal(f.builds.length, 1);
    assert.ok(existsSync(join(b1.dir, 'src', 'WebDriverAgent.xcodeproj')), 'builds a private copy of the source');
    assert.equal(JSON.parse(readFileSync(join(b1.dir, 'build.json'), 'utf8')).team, TEAM_A);
    assert.ok(progress.some((l) => /Building WebDriverAgent 16\.15\.3 for team AAAAA11111/.test(l)));

    const b2 = await ensureBuild(f.d, UDID, cfg, () => undefined);
    assert.equal(b2.built, false, 'a valid build is reused');
    assert.equal(f.builds.length, 1);

    f.setExpiry(f.now + 3_600_000);                       // a free team's 7 days are nearly up
    const b3 = await ensureBuild(f.d, UDID, cfg, () => undefined);
    assert.equal(b3.built, true);
    assert.match(b3.reason!, /expires within a day/);
    f.setExpiry(f.now + 6 * 86_400_000);

    const b4 = await ensureBuild(f.d, UDID, { ...cfg, team: TEAM_B }, () => undefined);
    assert.equal(b4.built, true);
    assert.notEqual(b4.dir, b1.dir);
    assert.equal(f.builds.length, 3);
    assert.ok(f.builds[2].includes(`DEVELOPMENT_TEAM=${TEAM_B}`));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('launchWda launches the built runner; a launch refused for expired signing rebuilds once', async () => {
  const f = buildFixture();
  try {
    const cfg = { team: TEAM_A, free: false, bundleId: UPSTREAM_RUNNER_BUNDLE_ID };
    const a = await launchWda(f.d, UDID, cfg, () => undefined);
    assert.equal(a.url, `http://[${TUNNEL_IP}]:8100`, 'this Mac reaches it through the phone’s tunnel address');
    assert.equal(f.builds.length, 1);
    assert.equal(f.launches.length, 1);
    a.runner.kill();

    const b = await launchWda(f.d, UDID, cfg, () => undefined);
    assert.equal(b.built, false);
    assert.equal(f.builds.length, 1, 'the second launch reuses the build');
    b.runner.kill();

    f.launchWith(['error: The provisioning profile has expired.'], 65);
    let n = 0;
    const origSpawn = f.d.spawn;
    f.d.spawn = (cmd, args, o) => { if (args[0] === 'test-without-building' && ++n === 2) f.launchWith(undefined); return origSpawn(cmd, args, o); };
    const c = await launchWda(f.d, UDID, cfg, () => undefined);
    assert.equal(c.url, `http://[${TUNNEL_IP}]:8100`);
    assert.equal(c.built, true);
    assert.equal(f.builds.length, 2, 'rebuilt once for the expired signing');
    c.runner.kill();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('a signature the phone refuses: a person’s setup rebuilds once; an automatic launch only reports it', async () => {
  const f = buildFixture();
  try {
    const cfg = { team: TEAM_A, free: false, bundleId: UPSTREAM_RUNNER_BUNDLE_ID };
    const untrusted = 'Unable to launch com.facebook.WebDriverAgentRunner.xctrunner because it has an invalid code signature, inadequate entitlements or its profile has not been explicitly trusted by the user.';
    await ensureBuild(f.d, UDID, cfg, () => undefined);
    assert.equal(f.builds.length, 1);
    f.launchWith([untrusted], 65);
    // Automatic (the supervisor): nothing is signed without a person.
    await assert.rejects(launchWda(f.d, UDID, cfg, () => undefined, { mayBuild: false }), (e: PhoneDockError) => e.code === 'signature_invalid');
    assert.equal(f.builds.length, 1);
    // A person's setup (a certificate revoked from another Mac): rebuild once.
    let n = 0;
    const orig = f.d.spawn;
    f.d.spawn = (cmd, args, o) => { if (args[0] === 'test-without-building' && ++n === 2) f.launchWith(undefined); return orig(cmd, args, o); };
    const r = await launchWda(f.d, UDID, cfg, () => undefined);
    assert.equal(r.built, true);
    assert.equal(f.builds.length, 2);
    r.runner.kill();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('two phones on one team build one at a time in the shared build directory', async () => {
  const f = buildFixture();
  try {
    const cfg = { team: TEAM_A, free: false, bundleId: UPSTREAM_RUNNER_BUNDLE_ID };
    const [a, b] = await Promise.all([ensureBuild(f.d, UDID, cfg, () => undefined), ensureBuild(f.d, UDID, cfg, () => undefined)]);
    assert.equal(f.builds.length, 1, 'the second waits, then finds the first one’s build');
    assert.equal(a.built, true);
    assert.equal(b.built, false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

class StubbornChild extends FakeChild {
  override kill(signal: NodeJS.Signals = 'SIGTERM'): boolean { this.killed.push(signal); if (signal === 'SIGKILL') this.exit(137); return true; }
}

test('stopping xcodebuild escalates to SIGKILL, and a cancelled build or launch never hangs', async () => {
  const plan = { project: '/b/src/WebDriverAgent.xcodeproj', derivedData: '/b/DD', destination: `id=${UDID}`, team: TEAM_A, bundleId: UPSTREAM_RUNNER_BUNDLE_ID };
  const kids: StubbornChild[] = [];
  const spawn = () => { const k = new StubbornChild(); kids.push(k); return k; };

  const ac = new AbortController();
  const b = runBuild(spawn, plan, {}, () => undefined, { signal: ac.signal, graceMs: 20 });
  ac.abort();
  await assert.rejects(b, (e: PhoneDockError) => e.code === 'cancelled');
  assert.deepEqual(kids[0].killed, ['SIGINT', 'SIGKILL']);

  const t = runBuild(spawn, plan, {}, () => undefined, { timeoutMs: 10, graceMs: 20 });
  await assert.rejects(t, (e: PhoneDockError) => e.status === 504 && /too long/.test(e.message));
  assert.deepEqual(kids[1].killed, ['SIGINT', 'SIGKILL']);

  // A child that ignores even SIGKILL: the build still returns.
  class Stuck extends FakeChild { override kill(signal: NodeJS.Signals = 'SIGTERM'): boolean { this.killed.push(signal); return true; } }
  const stuck = new Stuck();
  const s = runBuild(() => stuck, plan, {}, () => undefined, { timeoutMs: 10, graceMs: 10 });
  await assert.rejects(s, (e: PhoneDockError) => e.status === 504);

  const la = new AbortController();
  const l = startRunner(spawn, { xctestrun: '/b/x.xctestrun', destination: `id=${UDID}`, env: {}, now: () => 1, signal: la.signal, graceMs: 20 }, () => undefined);
  la.abort();
  await assert.rejects(l, (e: PhoneDockError) => e.code === 'cancelled');
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(kids[2].killed, ['SIGINT', 'SIGKILL']);
});

test('pruneBuilds deletes builds unused for 30 days and leaves the current, recent and foreign ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-wda-prune-'));
  try {
    const now = Date.parse('2026-11-24T00:00:00Z');
    const mk = (name: string, lastUsed?: string, ours = true) => {
      mkdirSync(join(dir, name), { recursive: true });
      if (ours) writeFileSync(join(dir, name, 'build.json'), '{}');
      if (lastUsed) writeFileSync(join(dir, name, '.last-used'), lastUsed);
    };
    mk('current', '2026-01-01T00:00:00Z');
    mk('old', '2026-10-01T00:00:00Z');
    mk('recent', '2026-11-20T00:00:00Z');
    mk('half-built', undefined, false);
    mk('old-no-stamp');
    const removed = pruneBuilds({ buildsDir: dir, now: () => now, remove: (p) => rmSync(p, { recursive: true, force: true }) }, 'current');
    assert.deepEqual(removed.sort(), ['old', 'old-no-stamp']);
    assert.ok(existsSync(join(dir, 'current')) && existsSync(join(dir, 'recent')) && existsSync(join(dir, 'half-built')));
    void utimesSync;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── supervision ──

class FakeRunner implements Runner {
  pid: number; startedAt: number; readyAt?: number; private live = true;
  private resolveExit!: (c: number | null) => void;
  exited: Promise<number | null>;
  kills = 0;
  constructor(pid: number, startedAt: number) { this.pid = pid; this.startedAt = startedAt; this.readyAt = startedAt; this.exited = new Promise((r) => { this.resolveExit = r; }); }
  alive() { return this.live; }
  kill() { this.kills++; this.die(130); }
  die(code = 0) { if (!this.live) return; this.live = false; this.resolveExit(code); }
}

function world(opts: { managed?: string[] } = {}) {
  let now = 1_000_000;
  const managed = new Set(opts.managed ?? [UDID]);
  const answering = new Set<string>();
  const phones = new Map<string, PhoneFacts>([[UDID, { found: true, paired: true, reachable: true, osVersion: '18.7', developerMode: true, locked: false }]]);
  const runners: FakeRunner[] = [];
  const launches: string[] = [];
  const signals: AbortSignal[] = [];
  /** What runs on the phone: runner app instances, which can outlive xcodebuild. */
  const onPhone = new Set<number>();
  let nextLaunch: (() => Promise<{ runner: FakeRunner; url: string }>) | undefined;
  let buildGate: Promise<void> | undefined;
  const events: string[] = [];
  const records = new Map<string, 'clean' | 'pending'>();
  const phonePids = new Map<string, number[]>();
  const deps: SupervisorDeps = {
    now: () => now,
    managed: () => [...managed],
    status: async (url: string) => (answering.has(url) ? { ok: true, ip: null } : false),
    phone: async (u) => phones.get(u) ?? { found: false },
    launch: async (u, _p, ctl) => {
      launches.push(u); signals.push(ctl.signal);
      events.push('build');
      if (buildGate) await buildGate;                     // "building"
      if (ctl.signal.aborted) throw new PhoneDockError('Setup was stopped', 'cancelled', 409);
      if (nextLaunch) { const f = nextLaunch; await ctl.beforeStart(); return f(); }
      await ctl.beforeStart();
      events.push('start');
      const r = new FakeRunner(5000 + runners.length, now); runners.push(r);
      ctl.onSpawn(r.pid, { phase: 'launch', destination: `id=${UDID}`, exited: r.exited });
      onPhone.add(r.pid);
      const url = `http://[${TUNNEL_IP}]:8100`;
      void r.exited.then(() => answering.delete(url));    // a dead runner's address stops answering
      return { runner: r, url };
    },
    runners: async () => [...onPhone],
    // Round 4: PhoneDock's own runner by its pid; every one only on a person's Stop.
    stopOnPhone: async (_u, x) => { events.push('stopOnPhone'); for (const p of [...onPhone]) if (!x?.pids || x.pids.includes(p)) onPhone.delete(p); return 0; },
    ledger: {
      mark: (u: string, r?: { phonePids?: number[] }) => { records.set(u, 'pending'); if (r?.phonePids) phonePids.set(u, r.phonePids); },
      clean: (u: string) => { records.set(u, 'clean'); phonePids.delete(u); },
      record: (u: string) => (records.has(u) ? { udid: u, state: records.get(u)!, ...(phonePids.has(u) ? { phonePids: phonePids.get(u) } : {}) } : undefined),
      state: (u: string) => records.get(u),
      pending: () => [...records].filter(([, v]) => v === 'pending').map(([udid]) => ({ udid, state: 'pending' as const })),
    },
    log: () => undefined,
  };
  const sup = new WdaSupervisor(deps, { tickMs: 15_000, graceMs: 45_000, backoffMs: [5_000, 15_000, 60_000], maxAttempts: 3, personPollMs: 30_000,
    personBackoffMs: [30_000, 60_000], maxPersonAttempts: 3, minUptimeMs: 60_000, stopWaitMs: 200, autoTick: false });
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  return {
    sup, deps, managed, answering, phones, runners, launches, signals, events, settle, onPhone, records, phonePids,
    advance(ms: number) { now += ms; },
    get now() { return now; },
    failNext(err: PhoneDockError) { nextLaunch = async () => { nextLaunch = undefined; throw err; }; },
    failAlways(err: PhoneDockError) { nextLaunch = async () => { throw err; }; },
    launchWith(f: () => Promise<{ runner: FakeRunner; url: string }>) { nextLaunch = f; },
    succeed() { nextLaunch = undefined; },
    gate() { let open!: () => void; buildGate = new Promise((r) => { open = r; }); return () => { buildGate = undefined; open(); }; },
    async tickAfter(ms: number) { now += ms; await sup.tick(); await this.settle(); },
  };
}

test('nothing launches before start(): a filtered or stopped service only reports', async () => {
  const w = world();
  // A setup on this service that ended waiting for the phone (e.g. it was unplugged mid-launch)…
  w.failNext(new PhoneDockError('The iPhone can’t be reached', 'no_device', 409));
  await assert.rejects(w.sup.setup(UDID, () => undefined));
  assert.equal(w.sup.info(UDID)?.state, 'waiting_phone');
  // …then the phone comes and goes, and time passes: without start() nothing launches on its own.
  w.sup.observe([{ udid: UDID, reachable: false }]);
  w.sup.observe([{ udid: UDID, reachable: true }]);
  await w.tickAfter(3_600_000);
  w.sup.resume(UDID, 'test');
  await w.settle();
  assert.deepEqual(w.launches, [UDID], 'only the setup someone asked for');
  assert.equal(w.sup.isStarted, false);
});

test('daemon start ends its own runner left on the phone (by its recorded pid), then starts a new one; stop() ends that', async () => {
  const w = world();
  w.onPhone.add(999);                                    // the previous daemon's runner (it died), maybe exposed
  w.records.set(UDID, 'pending'); w.phonePids.set(UDID, [999]);
  w.answering.add(`http://[${TUNNEL_IP}]:8100`);
  w.sup.start();
  await w.settle();
  assert.deepEqual(w.events, ['stopOnPhone', 'build', 'start'], 'its own leftover is ended first');
  assert.ok(!w.onPhone.has(999));
  assert.equal(w.sup.boundUrl(UDID)?.url, URL_A);
  assert.equal(w.sup.info(UDID)?.state, 'running');
  assert.equal(w.sup.info(UDID)?.shared, false);
  await w.sup.stop();
  assert.equal(w.runners[0].kills, 1, 'xcodebuild stopped');
  assert.equal(w.events.at(-1), 'stopOnPhone', 'and the runner on the phone, by its pid');
  assert.equal(w.onPhone.size, 0);
});

test('round 4: daemon start leaves a runner it has no record of alone (somebody else’s) and says so', async () => {
  const w = world();
  w.onPhone.add(888);                                    // not PhoneDock's: another Mac's, another tool's
  w.sup.start();
  await w.settle();
  assert.deepEqual(w.events, [], 'listed, not ended; nothing built or started');
  assert.ok(w.onPhone.has(888));
  assert.match(w.sup.info(UDID)?.message ?? '', /already running on this iPhone from somewhere else/);
});

test('one launcher per phone: concurrent triggers share one launch; setup waits, then restarts once', async () => {
  const w = world();
  const open = w.gate();
  w.sup.start(); w.sup.start();
  w.sup.observe([{ udid: UDID, reachable: false }]);
  w.sup.observe([{ udid: UDID, reachable: true }]);
  await w.sup.tick();
  const manual = w.sup.setup(UDID, () => undefined);
  await w.settle();
  assert.equal(w.launches.length, 1, 'setup waits for the launch in flight');
  open();
  const r = await manual;
  assert.equal(w.launches.length, 2, 'then restarts once, so a new team or build applies');
  assert.equal(w.runners[0].kills, 1, 'the first runner is stopped before the second starts');
  assert.equal(r.url, URL_A);
  assert.equal(w.runners.filter((x) => x.alive()).length, 1);
});

test('setup builds before it stops the running WebDriverAgent; a failed build leaves it running', async () => {
  const w = world();
  w.sup.start(); await w.settle();
  const first = w.runners[0];
  const open = w.gate();
  const s = w.sup.setup(UDID, () => undefined);
  await w.settle();
  assert.ok(first.alive(), 'still serving during the build');
  open(); await s;
  assert.equal(first.kills, 1);
  assert.deepEqual(w.events, ['build', 'start', 'build', 'stopOnPhone', 'start'], 'nothing to end at the start (round 4: no record, nothing of ours)');

  const second = w.runners[1];
  // A build failure throws before beforeStart: nothing on the phone or the Mac is touched.
  w.deps.launch = async () => { throw new PhoneDockError('Team X can’t register WebDriverAgent’s app ID', 'bundle_id_unavailable', 409); };
  await assert.rejects(w.sup.setup(UDID, () => undefined), (e: PhoneDockError) => e.code === 'bundle_id_unavailable');
  assert.ok(second.alive());
  assert.equal(w.sup.info(UDID)?.state, 'running');
});

test('a runner that exits is relaunched; a crash loop gives up, even when each runner answers once before dying', async () => {
  const w = world();
  w.sup.start(); await w.settle();
  w.answering.add(URL_A);
  await w.tickAfter(10 * 60_000);
  w.runners[0].die(0);
  await w.settle();
  assert.equal(w.sup.info(UDID)?.state, 'retrying');
  assert.equal(w.sup.info(UDID)?.attempts, 1);
  assert.equal(w.events.filter((x) => x === 'stopOnPhone').length, 1, 'the exit is followed by a cleanup on the phone (its runner, by pid)');
  await w.tickAfter(4_000);
  assert.equal(w.launches.length, 1, 'not before the pause');
  await w.tickAfter(1_000);
  assert.equal(w.launches.length, 2);
  assert.equal(w.sup.info(UDID)?.state, 'running');

  for (let i = 0; ; i++) {
    w.answering.add(URL_A);
    await w.tickAfter(15_000);
    await w.tickAfter(15_000);
    w.runners.at(-1)!.die(1);
    await w.settle();
    const info = w.sup.info(UDID)!;
    if (info.state === 'failed') { assert.match(info.message, /keeps stopping/); break; }
    assert.equal(info.state, 'retrying');
    assert.ok(i < 3, 'gives up within maxAttempts');
    await w.tickAfter(60_000);
  }
  const before = w.launches.length;
  await w.tickAfter(3_600_000);
  assert.equal(w.launches.length, before, 'failed waits for a person (or a reconnect)');
  w.sup.observe([{ udid: UDID, reachable: false }]);
  w.sup.observe([{ udid: UDID, reachable: true }]);
  await w.settle();
  assert.equal(w.launches.length, before + 1, 'a reconnect starts over');
});

test('a devicectl flap while running restarts nothing and forgives nothing; a changed tunnel address relaunches', async () => {
  const w = world();
  w.sup.start(); await w.settle();
  w.runners[0].die(1); await w.settle();
  assert.equal(w.sup.info(UDID)?.attempts, 1);
  w.sup.observe([{ udid: UDID, reachable: true }]);
  w.sup.observe([{ udid: UDID, reachable: false }]);
  w.sup.observe([{ udid: UDID, reachable: true }]);    // retrying + back: try now, without resetting the count
  await w.settle();
  assert.equal(w.launches.length, 2);
  assert.equal(w.sup.info(UDID)?.attempts, 1);
  w.sup.observe([{ udid: UDID, reachable: false }]);
  w.sup.observe([{ udid: UDID, reachable: true, tunnelIp: TUNNEL_IP }]);    // running, same tunnel: nothing
  await w.settle();
  assert.equal(w.launches.length, 2);
  // CoreDevice brought the tunnel back with another address: the runner listens on the old one.
  w.sup.observe([{ udid: UDID, reachable: true, tunnelIp: 'fd00:0:0:2::1' }]);
  await w.settle();
  assert.equal(w.launches.length, 3);
  assert.equal(w.sup.info(UDID)?.attempts, 1, 'not the runner’s fault: not counted');
});

test('launch failures retry with backoff, bounded', async () => {
  const w = world();
  w.failAlways(new PhoneDockError('Couldn’t start WebDriverAgent on the iPhone', 'wda_setup_failed', 502));
  w.sup.start(); await w.settle();
  assert.equal(w.sup.info(UDID)?.state, 'retrying');
  assert.equal(w.sup.info(UDID)?.attempts, 1);
  assert.ok(w.sup.info(UDID)?.nextRetryAt);
  await w.tickAfter(5_000);
  assert.equal(w.sup.info(UDID)?.attempts, 2);
  await w.tickAfter(14_000);
  assert.equal(w.launches.length, 2, 'second pause is longer');
  await w.tickAfter(1_000);
  assert.equal(w.launches.length, 3);
  assert.equal(w.sup.info(UDID)?.state, 'failed');
  assert.equal(w.events.filter((x) => x === 'stopOnPhone').length, 0, 'launches that never started xcodebuild leave nothing to end (round 4: nothing recorded, nothing ended)');
});

test('/status going quiet relaunches; quiet while the phone is away only waits (uncounted)', async () => {
  const w = world();
  w.sup.start(); await w.settle();
  const url1 = URL_A;
  w.answering.add(url1);
  await w.sup.tick();
  assert.equal(w.sup.info(UDID)?.state, 'running');
  w.answering.delete(url1);                 // it hangs
  await w.tickAfter(30_000);
  assert.equal(w.launches.length, 1, 'within the grace period nothing happens');
  await w.tickAfter(20_000);
  assert.equal(w.launches.length, 2);
  assert.equal(w.runners[0].kills, 1, 'the stuck runner is replaced');
  assert.equal(w.sup.info(UDID)?.attempts, 1, 'a hang counts');

  w.phones.set(UDID, { ...w.phones.get(UDID)!, reachable: false });   // asleep on Wi-Fi
  await w.tickAfter(50_000);
  const info = w.sup.info(UDID)!;
  assert.equal(info.state, 'unreachable');
  assert.equal(w.launches.length, 2, 'a runner is not killed because the phone is away');
  assert.equal(w.runners[1].kills, 0);
  assert.equal(info.attempts, 1, 'and nothing counts');
  w.phones.set(UDID, { ...w.phones.get(UDID)!, reachable: true });
  w.answering.add(URL_A);
  await w.sup.tick();
  assert.equal(w.sup.info(UDID)?.state, 'running');
});

test('a locked phone waits for unlock without launching or spending retries, then starts', async () => {
  const w = world();
  w.phones.set(UDID, { ...w.phones.get(UDID)!, locked: true });
  w.sup.start(); await w.settle();
  assert.deepEqual(w.launches, []);
  assert.equal(w.sup.info(UDID)?.state, 'waiting_unlock');
  for (let i = 0; i < 8; i++) await w.tickAfter(15_000);
  assert.deepEqual(w.launches, [], 'no launch while it stays locked');
  assert.equal(w.sup.info(UDID)?.attempts, 0);
  w.phones.set(UDID, { ...w.phones.get(UDID)!, locked: false });
  await w.tickAfter(15_000);
  assert.deepEqual(w.launches, [UDID]);
  assert.equal(w.sup.info(UDID)?.state, 'running');
});

test('waits that only a launch reveals back off and give up (no launch every 30 s all night)', async () => {
  const w = world();
  w.phones.set(UDID, { ...w.phones.get(UDID)!, locked: null });
  w.failAlways(new PhoneDockError('The iPhone can’t be reached', 'no_device', 409));
  w.sup.start(); await w.settle();
  assert.equal(w.sup.info(UDID)?.state, 'waiting_phone');
  assert.equal(w.sup.info(UDID)?.attempts, 0, 'waiting for a person is not a failure');
  await w.tickAfter(30_000);
  assert.equal(w.launches.length, 2);
  await w.tickAfter(30_000);
  assert.equal(w.launches.length, 2, 'the second wait is longer');
  await w.tickAfter(30_000);
  assert.equal(w.launches.length, 3);
  for (let i = 0; i < 10; i++) await w.tickAfter(60_000);
  assert.equal(w.sup.info(UDID)?.state, 'failed');
  const n = w.launches.length;
  assert.ok(n <= 5, `bounded (${n} launches)`);
  await w.tickAfter(8 * 3_600_000);
  assert.equal(w.launches.length, n);
  w.succeed();
  w.sup.observe([{ udid: UDID, reachable: false }]);
  w.sup.observe([{ udid: UDID, reachable: true }]);
  await w.settle();
  assert.equal(w.sup.info(UDID)?.state, 'running');
});

test('an untrusted developer waits for Retry or a reconnect, never relaunching on a timer (each launch asks again)', async () => {
  const w = world();
  w.failNext(new PhoneDockError('Trust the developer on the iPhone', 'wda_untrusted', 409, ['On the iPhone open Settings › General › VPN & Device Management…']));
  w.sup.start(); await w.settle();
  assert.equal(w.sup.info(UDID)?.state, 'waiting_trust');
  assert.equal(w.sup.info(UDID)?.nextRetryAt, undefined);
  for (let i = 0; i < 20; i++) await w.tickAfter(15 * 60_000);
  assert.equal(w.launches.length, 1, 'five hours: no second prompt');
  await w.sup.setup(UDID, () => undefined);              // the person pressed Retry
  assert.equal(w.sup.info(UDID)?.state, 'running');
});

test('locked only according to xcodebuild (lock state unknown): retried at the waiting pace, not every tick', async () => {
  const w = world();
  w.phones.set(UDID, { ...w.phones.get(UDID)!, locked: null });
  w.failNext(new PhoneDockError('Unlock the iPhone', 'device_locked', 409));
  w.sup.start(); await w.settle();
  assert.equal(w.sup.info(UDID)?.state, 'waiting_unlock');
  await w.tickAfter(15_000);
  assert.equal(w.launches.length, 1);
  await w.tickAfter(20_000);
  assert.equal(w.launches.length, 2);
  assert.equal(w.sup.info(UDID)?.state, 'running');
});

test('a disconnected phone waits for it to come back; the reconnect starts WebDriverAgent', async () => {
  const w = world();
  w.phones.delete(UDID);
  w.sup.start(); await w.settle();
  assert.equal(w.sup.info(UDID)?.state, 'waiting_phone');
  w.sup.observe([]);
  w.phones.set(UDID, { found: true, paired: true, reachable: true, osVersion: '18.7', developerMode: true, locked: false });
  w.sup.observe([{ udid: UDID, reachable: true }]);
  await w.settle();
  assert.deepEqual(w.launches, [UDID]);
  assert.equal(w.sup.info(UDID)?.state, 'running');
});

test('unmanage (Stop, Disconnect) cancels a build in flight, stops the runner on the Mac and the phone; setup reports it', async () => {
  const w = world();
  w.sup.start(); await w.settle();
  w.managed.delete(UDID);
  await w.sup.unmanage(UDID);
  assert.equal(w.runners[0].kills, 1);
  assert.equal(w.onPhone.size, 0, 'the runner on the phone is gone too');
  assert.equal(w.sup.info(UDID), undefined);
  await w.tickAfter(60_000);
  assert.equal(w.launches.length, 1);

  const v = world();
  v.sup.start(); await v.settle();
  const open = v.gate();
  const s = v.sup.setup(UDID, () => undefined);
  await v.settle();
  v.managed.delete(UDID);
  const stopping = v.sup.unmanage(UDID);
  assert.ok(v.signals.at(-1)!.aborted, 'the build in flight is told to stop');
  open();
  await stopping;
  await assert.rejects(s, (e: PhoneDockError) => e.code === 'cancelled');
  assert.equal(v.runners.length, 1, 'no new runner started after Stop');
  assert.equal(v.runners[0].kills, 1);
  v.sup.resume(UDID, 'setup failed; back to the previous setup');
  await v.tickAfter(60_000);
  assert.equal(v.sup.info(UDID), undefined, 'a phone no longer managed is not brought back');
  assert.equal(v.launches.length, 2);
});

test('a manual setup failure is reported to the caller and not retried on its own', async () => {
  const w = world({ managed: [UDID] });
  w.failNext(new PhoneDockError('Sign in to Xcode to set up this iPhone', 'xcode_account_missing', 409));
  await assert.rejects(w.sup.setup(UDID, () => undefined), (e: PhoneDockError) => e.code === 'xcode_account_missing');
  assert.equal(w.sup.info(UDID)?.state, 'failed');
  w.sup.start(); await w.settle();
  w.answering.add(URL_A);
  await w.tickAfter(600_000);
  assert.equal(w.launches.length, 2, 'only the daemon-start attempt, nothing on a timer');
});
