// Older iPhones v1 (Set Up Control): the ported building blocks (teams, preflight, xcodebuild, classification) and
// the setup/stop rules, all with fakes. No phone, no Xcode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhoneDockError, type ExecResult } from '../core/types.ts';
import {
  UPSTREAM_RUNNER_BUNDLE_ID, buildArgv, buildKey, checkReach, chooseTeam, classifyXcodebuild, ensureBuild, launchArgv, runBuild,
  parseApiKey, parseXcodeTeams, preflight, pruneBuilds, readXcodeInfo, readXcodeTeams, runnerBundleId, setupPhone, sharingChecker, startRunner,
  teamScopedBundleId, type ChildLike, type Exec, type PhoneFacts, type ProbeResult, type WdaConfig, type WdaDeps, type XcodeInfo,
} from './ios-wda.ts';

const TUNNEL_IP = 'fd00:0:0:1::1';
const URL_A = `http://[${TUNNEL_IP}]:8100`;
const WIFI_IP = '192.0.2.10';

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
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


// ── build once ──

/** A fake Mac and phone for Set Up Control: xcodebuild children, the phone's runners, /status and TCP probes. */
function world(o: { runners?: number[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pd-wda-v1-'));
  const srcDir = join(root, 'component', 'WebDriverAgent-16.15.3');
  mkdirSync(join(srcDir, 'WebDriverAgent.xcodeproj'), { recursive: true });
  writeFileSync(join(srcDir, 'WebDriverAgent.xcodeproj', 'project.pbxproj'), '');
  const builds: string[][] = [];
  const launches: string[][] = [];
  const launchEnvs: NodeJS.ProcessEnv[] = [];
  const kids: FakeChild[] = [];
  /** runner pids on the phone; a launch adds one */
  const onPhone = new Set<number>(o.runners ?? []);
  const ended: (number[] | 'all')[] = [];
  let nextPid = 90;
  let launchSays: string[] | undefined;
  let launchExit: number | undefined;
  /** what /status answers at an address (undefined: nothing answers) */
  const status = new Map<string, unknown>();
  const probes = new Map<string, ProbeResult>();
  let saved: WdaConfig | undefined;
  const spawn = (_cmd: string, args: string[], so: { env?: NodeJS.ProcessEnv } = {}) => {
    const k = new FakeChild(); kids.push(k);
    if (args[0] === 'build-for-testing') {
      builds.push(args);
      const dd = args[args.indexOf('-derivedDataPath') + 1];
      setImmediate(() => {
        mkdirSync(join(dd, 'Build', 'Products'), { recursive: true });
        writeFileSync(join(dd, 'Build', 'Products', 'WebDriverAgentRunner_iphoneos27.2-arm64.xctestrun'), '<plist/>');
        k.say('** TEST BUILD SUCCEEDED **'); k.exit(0);
      });
    } else {
      launches.push(args); launchEnvs.push(so.env ?? {});
      const bound = so.env?.TEST_RUNNER_USE_IP;
      const says = launchSays ?? [`ServerURLHere->http://${bound ?? WIFI_IP}:8100<-ServerURLHere`];
      const pid = nextPid++;
      setImmediate(() => {
        if (launchExit === undefined) {
          onPhone.add(pid);
          // Like WebDriverAgent: it answers on the tunnel; bound to every address, also on the Wi-Fi.
          if (!status.has(URL_A)) status.set(URL_A, { value: { ready: true, ios: { ip: WIFI_IP } } });
          if (!bound) probes.set(`${WIFI_IP}:8100`, 'open');
        }
        for (const l of says) k.say(l);
        if (launchExit !== undefined) k.exit(launchExit);
      });
    }
    return k;
  };
  const d: WdaDeps = {
    exec: async (): Promise<ExecResult> => ({ code: 1, stdout: '', stderr: '' }),
    spawn, now: Date.now, env: {}, buildsDir: join(root, 'wda-builds'),
    source: async () => ({ path: srcDir, version: '16.15.3' }),
    xcode: async () => ({ build: '27B52', version: '27.2', minIos: '17.0' }),
    copyTree: async (from, to) => { cpSync(from, to, { recursive: true }); },
    writeFile: (p, t) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, t); },
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    remove: (p) => rmSync(p, { recursive: true, force: true }),
    getJson: async (url) => status.get(url.replace(/\/status$/, '')),
    probe: async (host, port) => probes.get(`${host}:${port}`) ?? 'refused',
    teams: async () => [{ id: TEAM_A, name: 'Alpha', free: false }],
    phone: async () => ({ found: true, paired: true, reachable: true, osVersion: '18.7', developerMode: true, locked: false }),
    tunnel: async () => TUNNEL_IP,
    runners: async () => [...onPhone],
    endRunners: async (_u, pids) => { ended.push(pids ? [...pids] : 'all'); for (const p of [...onPhone]) if (!pids || pids.includes(p)) onPhone.delete(p); return 0; },
    saved: () => saved,
    save: (_u, c) => { saved = c; },
  };
  return {
    root, d, builds, launches, launchEnvs, kids, onPhone, ended, status, probes,
    get saved() { return saved; },
    launchWith(says: string[] | undefined, exit?: number) { launchSays = says; launchExit = exit; },
    done() { for (const k of kids) k.exit(0); rmSync(root, { recursive: true, force: true }); },
  };
}
const cfgA: WdaConfig = { team: TEAM_A, free: false, bundleId: UPSTREAM_RUNNER_BUNDLE_ID };

test('build once per team and Xcode, reuse after; another team builds its own', async () => {
  const w = world();
  try {
    const progress: string[] = [];
    const b1 = await ensureBuild(w.d, UDID, cfgA, (l) => progress.push(l));
    assert.equal(b1.built, true);
    assert.ok(progress.some((l) => /Building WebDriverAgent 16\.15\.3 for team AAAAA11111/.test(l)));
    assert.equal((await ensureBuild(w.d, UDID, cfgA, () => undefined)).built, false, 'reused');
    assert.equal((await ensureBuild(w.d, UDID, { ...cfgA, team: TEAM_B }, () => undefined)).built, true);
    assert.equal(w.builds.length, 2);
    assert.ok(w.builds[1].includes(`DEVELOPMENT_TEAM=${TEAM_B}`));
    assert.ok(w.builds[0].includes('-allowProvisioningDeviceRegistration') && w.builds[0].includes('-allowProvisioningUpdates'));
  } finally { w.done(); }
});

test('two phones on one team build one at a time in the shared build directory', async () => {
  const w = world();
  try {
    const [a, b] = await Promise.all([ensureBuild(w.d, UDID, cfgA, () => undefined), ensureBuild(w.d, UDID, cfgA, () => undefined)]);
    assert.equal(w.builds.length, 1, 'the second waits, then finds the first one’s build');
    assert.equal(a.built, true);
    assert.equal(b.built, false);
  } finally { w.done(); }
});

// ── Set Up Control ──

test('no runner on the phone: build, launch bound to the tunnel address, check it is private, remember the team', async () => {
  const w = world();
  try {
    const r = await setupPhone(w.d, UDID, {}, () => undefined);
    assert.deepEqual({ wdaUrl: r.wdaUrl, shared: r.shared, reused: r.reused, team: r.team }, { wdaUrl: URL_A, shared: false, reused: false, team: TEAM_A });
    assert.equal(w.launches.length, 1);
    assert.equal(w.launchEnvs[0].TEST_RUNNER_USE_IP, TUNNEL_IP, 'bound to the phone’s end of this Mac’s tunnel');
    assert.deepEqual(w.launches[0].slice(0, 1), ['test-without-building']);
    assert.ok(w.launches[0].includes(`id=${UDID}`));
    assert.deepEqual(w.saved, cfgA, 'only the team (and how it signs) is remembered');
    assert.deepEqual(w.ended, [], 'nothing ended');
  } finally { w.done(); }
});

test('a private runner already running here is used: nothing built, launched or ended', async () => {
  const w = world({ runners: [77] });
  try {
    w.status.set(URL_A, { value: { ready: true, ios: { ip: WIFI_IP } } });           // answers on this Mac's tunnel; Wi-Fi refuses
    const r = await setupPhone(w.d, UDID, {}, () => undefined);
    assert.equal(r.reused, true);
    assert.equal(r.wdaUrl, URL_A);
    assert.deepEqual([w.builds.length, w.launches.length, w.ended.length], [0, 0, 0]);
    assert.deepEqual([...w.onPhone], [77]);
  } finally { w.done(); }
});

test('a runner that isn’t private here (shared, another Mac’s, or unknown) is refused and left untouched', async () => {
  for (const [why, arrange] of [
    ['answers on the Wi-Fi', (w: ReturnType<typeof world>) => { w.status.set(URL_A, { value: { ios: { ip: WIFI_IP } } }); w.probes.set(`${WIFI_IP}:8100`, 'open'); }],
    ['another Mac’s (doesn’t answer on this tunnel)', () => undefined],
    ['the Wi-Fi check is inconclusive', (w: ReturnType<typeof world>) => { w.status.set(URL_A, { value: { ios: { ip: WIFI_IP } } }); w.probes.set(`${WIFI_IP}:8100`, 'unknown'); }],
    ['a malformed /status', (w: ReturnType<typeof world>) => { w.status.set(URL_A, { value: { ios: {} } }); }],
  ] as const) {
    const w = world({ runners: [77] });
    try {
      arrange(w);
      const e = await setupPhone(w.d, UDID, {}, () => undefined).then(() => undefined, (x) => x as PhoneDockError);
      assert.equal(e?.code, 'wda_setup_failed', why);
      assert.equal(e?.cause, 'wda_running', why);
      assert.match(e!.hints![0], /Stop Control/);
      assert.deepEqual([w.builds.length, w.launches.length, w.ended.length, [...w.onPhone].join()], [0, 0, 0, '77'], `${why}: untouched`);
    } finally { w.done(); }
  }
});

test('an inconclusive private check ends that launch’s runner, on the Mac and on the phone, and nothing else', async () => {
  const w = world();
  try {
    w.status.set(URL_A, { value: { ready: true, ios: { ip: WIFI_IP } } });
    w.probes.set(`${WIFI_IP}:8100`, 'unknown');                                   // neither answered nor refused
    const e = await setupPhone(w.d, UDID, {}, () => undefined).then(() => undefined, (x) => x as PhoneDockError);
    assert.equal(e?.cause, 'wda_unverified');
    assert.ok(w.kids.at(-1)!.killed.length > 0, 'its xcodebuild was stopped');
    assert.deepEqual(w.ended, [[90]], 'its runner on the phone, by pid');
    assert.equal(w.onPhone.size, 0);
    assert.equal(w.saved, undefined, 'nothing remembered');
  } finally { w.done(); }
});

test('a runner that answers on the Wi-Fi though it was told to bind the tunnel is stopped (wda_exposed)', async () => {
  const w = world();
  try {
    w.probes.set(`${WIFI_IP}:8100`, 'open');
    w.status.set(URL_A, { value: { ready: true, ios: { ip: WIFI_IP } } });
    const e = await setupPhone(w.d, UDID, {}, () => undefined).then(() => undefined, (x) => x as PhoneDockError);
    assert.equal(e?.cause, 'wda_exposed');
    assert.deepEqual(w.ended, [[90]]);
  } finally { w.done(); }
});

test('only an explicit JSON null in /status means "no Wi-Fi address" (#11)', async () => {
  const d = { getJson: async () => undefined as unknown, probe: async (): Promise<ProbeResult> => 'refused' };
  for (const [ios, kind] of [[{ ip: null }, 'private'], [{}, 'unknown'], [{ ip: 42 }, 'unknown'], [{ ip: 'not-an-address' }, 'unknown'], [{ ip: WIFI_IP }, 'private']] as const) {
    d.getJson = async () => ({ value: { ios } });
    assert.equal((await checkReach(d, TUNNEL_IP)).kind, kind, JSON.stringify(ios));
  }
});

test('sharing is a flag on one launch: every address, and the address other Macs use', async () => {
  const w = world();
  try {
    const r = await setupPhone(w.d, UDID, { share: true }, () => undefined);
    assert.equal(w.launchEnvs[0].TEST_RUNNER_USE_IP, undefined, 'not bound to the tunnel');
    assert.deepEqual({ shared: r.shared, sharedUrl: r.sharedUrl }, { shared: true, sharedUrl: `http://${WIFI_IP}:8100` });
    assert.deepEqual(w.saved, cfgA, 'sharing isn’t saved');
    // Asking again, shared or private: a runner is there, so it is refused untouched (Stop Control first).
    for (const req of [{ share: true }, {}]) {
      assert.equal((await setupPhone(w.d, UDID, req, () => undefined).catch((e) => e as PhoneDockError) as PhoneDockError).cause, 'wda_running');
    }
    assert.equal(w.launches.length, 1);
    assert.deepEqual(w.ended, []);
  } finally { w.done(); }
});

test('a shared launch on a phone that reports no Wi-Fi address still says shared', async () => {
  const w = world();
  try {
    w.status.set(URL_A, { value: { ready: true, ios: { ip: null } } });
    const r = await setupPhone(w.d, UDID, { share: true }, () => undefined);
    assert.deepEqual([r.shared, r.sharedUrl], [true, undefined]);
  } finally { w.done(); }
});

test('a running WebDriverAgent that reports no Wi-Fi address isn’t reused: nothing shows how it is bound', async () => {
  const w = world({ runners: [77] });
  try {
    w.status.set(URL_A, { value: { ready: true, ios: { ip: null } } });
    const e = await setupPhone(w.d, UDID, {}, () => undefined).then(() => undefined, (x) => x as PhoneDockError);
    assert.equal(e?.cause, 'wda_running');
    assert.deepEqual([w.launches.length, w.ended.length, [...w.onPhone].join()], [0, 0, '77']);
  } finally { w.done(); }
});

test('an xcodebuild that dies before printing its address: the runner it left on the phone is ended', async () => {
  const w = world();
  try {
    const orig = w.d.spawn;
    w.d.spawn = (cmd, args, o) => {
      if (args[0] !== 'test-without-building') return orig(cmd, args, o);
      const k = new FakeChild(); w.kids.push(k);
      setImmediate(() => { w.onPhone.add(91); k.say('Testing failed: lost the connection'); k.exit(65); });
      return k;
    };
    const e = await setupPhone(w.d, UDID, {}, () => undefined).then(() => undefined, (x) => x as PhoneDockError);
    assert.equal(e?.code, 'wda_setup_failed');
    assert.deepEqual(w.ended, [[91]]);
    assert.equal(w.onPhone.size, 0);
  } finally { w.done(); }
});

test('when PhoneDock can’t confirm its failed launch is gone, it says to press Stop Control', async () => {
  const w = world();
  try {
    w.probes.set(`${WIFI_IP}:8100`, 'unknown');
    w.d.endRunners = async (_u, pids) => { w.ended.push(pids ? [...pids] : 'all'); return 1; };   // one still listed
    const e = await setupPhone(w.d, UDID, {}, () => undefined).then(() => undefined, (x) => x as PhoneDockError);
    assert.equal(e?.cause, 'wda_unverified');
    assert.match(e!.hints![0], /couldn’t confirm.*Stop Control/);
    assert.ok(!e!.hints!.some((h) => /^PhoneDock stopped it/.test(h)), 'doesn’t claim it was stopped');
  } finally { w.done(); }
});

test('a runner that appears while WebDriverAgent builds (Xcode, say) is refused untouched, not launched over', async () => {
  const w = world();
  try {
    const orig = w.d.spawn;
    w.d.spawn = (cmd, args, o) => { if (args[0] === 'build-for-testing') w.onPhone.add(55); return orig(cmd, args, o); };
    const e = await setupPhone(w.d, UDID, {}, () => undefined).then(() => undefined, (x) => x as PhoneDockError);
    assert.equal(e?.cause, 'wda_running');
    assert.deepEqual([w.launches.length, w.ended.length, [...w.onPhone].join()], [0, 0, '55']);
  } finally { w.done(); }
});

test('a cached build that doesn’t include a second phone is built again, once', async () => {
  const w = world();
  const OTHER = '00008030-0000CCCC0000DDDD';
  try {
    await ensureBuild(w.d, UDID, cfgA, () => undefined);
    let n = 0;
    const orig = w.d.spawn;
    w.launchWith(['error: Provisioning profile "iOS Team Provisioning Profile: *" doesn\'t include the currently selected device "iPhone".'], 65);
    w.d.spawn = (cmd, args, o) => { if (args[0] === 'test-without-building' && ++n === 2) w.launchWith(undefined); return orig(cmd, args, o); };
    const r = await setupPhone(w.d, OTHER, {}, () => undefined);
    assert.equal(r.reused, false);
    assert.equal(w.builds.length, 2);
    assert.ok(w.builds[1].includes(`id=${OTHER}`));
  } finally { w.done(); }
});

test('a launch refused for expired or refused signing builds again, once', async () => {
  const w = world();
  try {
    await ensureBuild(w.d, UDID, cfgA, () => undefined);
    w.launchWith(['error: The provisioning profile has expired.'], 65);
    let n = 0;
    const orig = w.d.spawn;
    w.d.spawn = (cmd, args, o) => { if (args[0] === 'test-without-building' && ++n === 2) w.launchWith(undefined); return orig(cmd, args, o); };
    const r = await setupPhone(w.d, UDID, {}, () => undefined);
    assert.equal(r.reused, false);
    assert.equal(w.builds.length, 2, 'rebuilt once');
    w.launchWith(['error: The provisioning profile has expired.'], 65);
    w.onPhone.clear(); w.status.clear();
    n = 10;
    const e = await setupPhone(w.d, UDID, {}, () => undefined).then(() => undefined, (x) => x as PhoneDockError);
    assert.equal(e?.cause, 'signing_expired', 'a fresh build that still fails is reported, not rebuilt again');
    assert.equal(w.builds.length, 3);
  } finally { w.done(); }
});

test('a paid team that can’t sign upstream’s runner id falls back to its own id, and keeps it', async () => {
  const w = world();
  try {
    const orig = w.d.spawn;
    w.d.spawn = (cmd, args, o) => {
      if (args[0] === 'build-for-testing' && !args.some((a) => a.startsWith('PRODUCT_BUNDLE_IDENTIFIER='))) {
        const k = new FakeChild(); w.kids.push(k);
        setImmediate(() => { k.say('error: Failed to register bundle identifier "com.facebook.WebDriverAgentRunner"'); k.exit(65); });
        return k;
      }
      return orig(cmd, args, o);
    };
    await setupPhone(w.d, UDID, {}, () => undefined);
    assert.equal(w.saved?.bundleId, teamScopedBundleId(TEAM_A));
  } finally { w.done(); }
});

test('preflight and signing failures keep wda_setup_failed with the cause; a failed download keeps exec_failed', async () => {
  const w = world();
  try {
    w.d.phone = async () => ({ found: true, paired: true, reachable: true, osVersion: '18.7', developerMode: true, locked: true });
    const locked = await setupPhone(w.d, UDID, {}, () => undefined).then(() => undefined, (x) => x as PhoneDockError);
    assert.deepEqual([locked?.code, locked?.cause], ['wda_setup_failed', 'device_locked']);
    w.d.phone = async () => ({ found: true, paired: true, reachable: true, osVersion: '18.7', developerMode: true, locked: false });
    w.d.teams = async () => [{ id: TEAM_A, name: 'A', free: false }, { id: TEAM_B, name: 'B', free: false }];
    const several = await setupPhone(w.d, UDID, {}, () => undefined).then(() => undefined, (x) => x as PhoneDockError);
    assert.equal(several?.cause, 'team_required');
    for (const [thrown, cause] of [[new PhoneDockError('Couldn’t download WebDriverAgent', 'download_failed', 502), 'download_failed'],
      [new PhoneDockError('The download didn’t match', 'self_check_failed', 502), 'self_check_failed'], [new Error('ENOSPC'), 'download_failed']] as const) {
      w.d.source = async () => { throw thrown; };
      const dl = await setupPhone(w.d, UDID, { team: TEAM_A }, () => undefined).then(() => undefined, (x) => x as PhoneDockError);
      assert.deepEqual([dl?.code, dl?.cause], ['exec_failed', cause], thrown.message);
    }
  } finally { w.done(); }
});

test('Stop Control before the launch (an already-aborted setup): cancelled, nothing launched or ended', async () => {
  const w = world();
  try {
    const ac = new AbortController(); ac.abort();
    const e = await setupPhone(w.d, UDID, {}, () => undefined, { signal: ac.signal }).then(() => undefined, (x) => x as PhoneDockError);
    assert.equal(e?.cause, 'cancelled');
    assert.deepEqual([w.builds.length, w.launches.length, w.ended.length], [0, 0, 0]);
    await ensureBuild(w.d, UDID, cfgA, () => undefined);                                  // with a build: still no launch
    const e2 = await setupPhone(w.d, UDID, {}, () => undefined, { signal: ac.signal }).then(() => undefined, (x) => x as PhoneDockError);
    assert.equal(e2?.cause, 'cancelled');
    assert.equal(w.launches.length, 0);
  } finally { w.done(); }
});

test('the device list’s sharing check: what each answer means, and one probe per phone a minute', async () => {
  let t = 0;
  const probes: string[] = [];
  let answer: ProbeResult | 'throw' = 'open';
  const s = sharingChecker(async (h, p) => { probes.push(`${h}:${p}`); if (answer === 'throw') throw new Error('EPERM'); return answer; }, () => t);
  const st = (ip: unknown) => ({ ready: true, ios: { ip } });
  assert.deepEqual(await s.check('A', st(WIFI_IP)), { state: 'shared', url: `http://${WIFI_IP}:8100` });
  assert.deepEqual(probes, [`${WIFI_IP}:8100`]);
  answer = 'refused';
  t += 59_000;
  assert.equal((await s.check('A', st(WIFI_IP))).state, 'shared', 'within the minute: the last answer, no probe');
  assert.equal(probes.length, 1);
  await Promise.all([s.check('B', st(WIFI_IP)), s.check('B', st(WIFI_IP))]);
  assert.equal(probes.length, 2, 'two lists at once: one probe');
  t += 1_000;
  assert.equal((await s.check('A', st(WIFI_IP))).state, 'not_shared', 'a minute later: probed again');
  answer = 'unknown'; s.forget('A');
  assert.equal((await s.check('A', st(WIFI_IP))).state, 'unknown', 'no answer is unknown, never not shared');
  answer = 'throw'; s.forget('A');
  assert.equal((await s.check('A', st(WIFI_IP))).state, 'unknown', 'a probe error (Local Network permission) is unknown');
  const n = probes.length;
  for (const [ip, state] of [[null, 'not_shared'], [undefined, 'unknown'], [42, 'unknown'], ['not-an-address', 'unknown']] as const) {
    s.forget('C');
    assert.equal((await s.check('C', st(ip))).state, state, String(ip));
  }
  s.forget('C');
  assert.equal((await s.check('C', {})).state, 'unknown', 'a malformed /status');
  assert.equal(probes.length, n, 'nothing to probe without a Wi-Fi address');
});
