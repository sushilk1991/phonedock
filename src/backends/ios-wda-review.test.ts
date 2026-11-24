// Regression tests for the independent review of PR #14 (findings #1–#14) and the on-device finding that a runner
// outlives xcodebuild. Each test names its finding; all run on fakes (no phone, no Xcode).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { constants, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn as spawnChild } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhoneDockError, type ExecResult } from '../core/types.ts';
import {
  UPSTREAM_RUNNER_BUNDLE_ID, WdaSupervisor, buildArgv, buildKey, classifyXcodebuild, ensureBuild, findXctestrun, launchWda,
  redact, runBuild, setupPhone, startRunner, teamScopedBundleId,
  type ChildLike, type Exec, type PhoneFacts, type ProbeResult, type SetupDeps, type SetupEntry, type SupervisorDeps, type WdaBuildDeps,
  type WdaConfig, type WdaControl, type XcodeTeam,
} from './ios-wda.ts';

const UDID = '00008020-0000AAAA0000BBBB';
const COREDEVICE_ID = '11111111-2222-3333-4444-555555555555';
const TEAM_A = 'AAAAA11111', TEAM_B = 'BBBBB22222';
const TUNNEL = 'fd00:0:0:1::1', WIFI = '192.0.2.10';
const cfgA: WdaConfig = { team: TEAM_A, free: false, bundleId: UPSTREAM_RUNNER_BUNDLE_ID };
/** An in-memory WdaLedger (the phone's claim and its cleanup record). */
function memLedger(o: { owned?: boolean } = {}) {
  const records = new Map<string, 'clean' | 'pending'>();
  return {
    lock: () => !o.owned, release: () => undefined,
    mark: (u: string) => { records.set(u, 'pending'); }, clean: (u: string) => { records.set(u, 'clean'); },
    state: (u: string) => records.get(u), pending: () => [...records].filter(([, v]) => v === 'pending').map(([udid]) => ({ udid, state: 'pending' as const })),
  };
}

class FakeChild extends EventEmitter implements ChildLike {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: string[] = [];
  closed = false;
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean { this.killed.push(signal); this.exit(130); return true; }
  say(text: string): void { this.stdout.write(text + '\n'); }
  exit(code: number): void {
    if (this.closed) return; this.closed = true;
    this.stdout.end(); this.stderr.end();
    setImmediate(() => this.emit('close', code));
  }
}

/** A build directory and a fake xcodebuild that behaves like WebDriverAgent: it binds (and prints) TEST_RUNNER_USE_IP,
 *  else prints its Wi-Fi address. */
function fixture(o: { prints?: (env: NodeJS.ProcessEnv) => string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pd-wda-review-'));
  const srcDir = join(root, 'component', 'WebDriverAgent-16.15.3');
  mkdirSync(join(srcDir, 'WebDriverAgent.xcodeproj'), { recursive: true });
  writeFileSync(join(srcDir, 'WebDriverAgent.xcodeproj', 'project.pbxproj'), '');
  let now = Date.parse('2026-11-24T12:00:00Z');
  const builds: string[][] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const kids: FakeChild[] = [];
  const probes = new Map<string, ProbeResult>();
  let buildSays: string[] | undefined;
  let buildExit = 0;
  const spawn = (_cmd: string, args: string[], so: { env?: NodeJS.ProcessEnv } = {}) => {
    const k = new FakeChild(); kids.push(k);
    if (args[0] === 'build-for-testing') {
      builds.push(args);
      const dd = args[args.indexOf('-derivedDataPath') + 1];
      const platform = args.some((a) => /simulator/i.test(a)) ? 'iphonesimulator' : 'iphoneos';
      setImmediate(() => {
        if (buildSays) { for (const l of buildSays) k.say(l); k.exit(buildExit); return; }
        const prod = join(dd, 'Build', 'Products');
        mkdirSync(join(prod, `Debug-${platform}`, 'WebDriverAgentRunner-Runner.app'), { recursive: true });
        writeFileSync(join(prod, `WebDriverAgentRunner_${platform}27.2-arm64.xctestrun`), '<plist/>');
        writeFileSync(join(prod, `Debug-${platform}`, 'WebDriverAgentRunner-Runner.app', 'embedded.mobileprovision'), 'cms');
        k.say('** TEST BUILD SUCCEEDED **'); k.exit(0);
      });
    } else {
      envs.push(so.env ?? {});
      const line = o.prints ? o.prints(so.env ?? {}) : `http://${so.env?.TEST_RUNNER_USE_IP ?? WIFI}:${so.env?.TEST_RUNNER_USE_PORT ?? 8100}`;
      setImmediate(() => k.say(`ServerURLHere->${line}<-ServerURLHere`));
    }
    return k;
  };
  const exec: Exec = async (cmd, args): Promise<ExecResult> => {
    if (cmd === '/usr/bin/security') { writeFileSync(args[args.indexOf('-o') + 1], '<plist/>'); return { code: 0, stdout: '', stderr: '' }; }
    if (args[1] === 'ExpirationDate') return { code: 0, stdout: new Date(now + 6 * 86_400_000).toISOString(), stderr: '' };
    if (args[1] === 'ProvisionedDevices') return { code: 0, stdout: JSON.stringify([UDID]), stderr: '' };
    return { code: 1, stdout: '', stderr: '' };
  };
  let artifact = '16.15.3-a232b9faaa47';
  const d: WdaBuildDeps = {
    exec, spawn, now: () => now, env: {}, buildsDir: join(root, 'wda-builds'),
    source: async () => ({ path: srcDir, version: '16.15.3', key: artifact }),
    xcode: async () => ({ build: '27B52', version: '27.2', minIos: '17.0' }),
    copyTree: async (from, to) => { cpSync(from, to, { recursive: true }); },
    writeFile: (p, t) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, t); },
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    remove: (p) => rmSync(p, { recursive: true, force: true }),
    endpoint: async () => ({ host: TUNNEL }),
    getJson: async () => ({ value: { ready: true, ios: { ip: WIFI } } }),
    probe: async (host, port) => probes.get(`${host}:${port}`) ?? 'refused',
    lockPollMs: 5,
  };
  return {
    root, d, builds, envs, kids, probes,
    advance(ms: number) { now += ms; },
    setArtifact(a: string) { artifact = a; },
    buildFails(lines: string[], code = 65) { buildSays = lines; buildExit = code; },
    buildWorks() { buildSays = undefined; },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

// ── #1 ────────────────────────────────────────────────────────────────────

test('#1: WebDriverAgent binds the phone’s tunnel address only, and a runner that doesn’t (or answers on Wi-Fi) is stopped', async () => {
  const f = fixture();
  try {
    const ok = await launchWda(f.d, UDID, cfgA, () => undefined);
    assert.equal(f.envs[0].TEST_RUNNER_USE_IP, TUNNEL, 'told to bind the tunnel address (HTTP and MJPEG)');
    assert.equal(ok.url, `http://[${TUNNEL}]:8100`);
    assert.equal(ok.lanCheck, 'refused', 'the Wi-Fi address refused both ports');
    ok.runner.kill();

    // Something answers on the phone's Wi-Fi address after launch: stop it and say so.
    f.probes.set(`${WIFI}:8100`, 'open');
    await assert.rejects(launchWda(f.d, UDID, cfgA, () => undefined), (e: PhoneDockError) => e.code === 'wda_exposed');
    assert.ok(f.kids.at(-1)!.killed.length > 0, 'the exposed runner is stopped');
    f.probes.delete(`${WIFI}:8100`);
    // (Inconclusive checks fail closed too: ios-wda-rules.test.ts, rule 1.)
  } finally { f.cleanup(); }

  // A WebDriverAgent that ignored USE_IP (prints its Wi-Fi address): fail closed.
  const g = fixture({ prints: () => `http://${WIFI}:8100` });
  try {
    await assert.rejects(launchWda(g.d, UDID, cfgA, () => undefined), (e: PhoneDockError) => e.code === 'wda_exposed' && /didn’t bind/.test(e.message));
    assert.ok(g.kids.at(-1)!.killed.length > 0);
  } finally { g.cleanup(); }

  // Sharing on (the person's choice): every address, and other Macs get the Wi-Fi address WebDriverAgent reports.
  const h = fixture();
  try {
    const shared = await launchWda(h.d, UDID, { ...cfgA, share: true }, () => undefined);
    assert.equal(h.envs[0].TEST_RUNNER_USE_IP, undefined);
    assert.equal(shared.url, `http://[${TUNNEL}]:8100`, 'this Mac still uses the tunnel');
    assert.equal(shared.sharedUrl, `http://${WIFI}:8100`, 'the Wi-Fi address WebDriverAgent reports (reachable from other Macs)');
    shared.runner.kill();
  } finally { h.cleanup(); }
});

// ── #2 ────────────────────────────────────────────────────────────────────

test('#2: the address used is always this phone’s tunnel (from devicectl), never what the runner printed', async () => {
  // A USB-only phone prints 127.0.0.1 (no Wi-Fi); PhoneDock must not read that as the Mac's loopback.
  const f = fixture({ prints: () => 'http://127.0.0.1:8100' });
  try {
    const r = await launchWda(f.d, UDID, { ...cfgA, share: true }, () => undefined);
    assert.equal(r.url, `http://[${TUNNEL}]:8100`);
    r.runner.kill();
  } finally { f.cleanup(); }
});

// ── #3 ────────────────────────────────────────────────────────────────────

test('#3: a build directory another process is building in is waited for (a kernel lock: nothing to go stale)', async () => {
  const f = fixture();
  try {
    const key = buildKey({ wdaVersion: '16.15.3', artifact: '16.15.3-a232b9faaa47', platform: 'iphoneos', team: TEAM_A, xcodeBuild: '27B52', bundleId: UPSTREAM_RUNNER_BUNDLE_ID });
    mkdirSync(f.d.buildsDir, { recursive: true });
    const lock = join(f.d.buildsDir, `.${key}.lock`);
    // Another PhoneDock process holds the build lock until it is told to stop.
    const other = spawnChild(process.execPath, ['-e', `require('fs').openSync(${JSON.stringify(lock)}, ${constants.O_RDONLY | constants.O_CREAT | 0x20 | constants.O_NONBLOCK}); console.log('held'); setInterval(() => {}, 1000)`], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((r) => other.stdout!.once('data', r));
    const progress: string[] = [];
    const p = ensureBuild(f.d, UDID, cfgA, (l) => progress.push(l));
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(f.builds.length, 0, 'waits while the other build runs');
    assert.ok(progress.some((l) => /Waiting for another PhoneDock build/.test(l)));
    other.kill('SIGKILL');                                 // it died: the kernel dropped its lock
    const b = await p;
    assert.equal(b.built, true);
    assert.ok(existsSync(lock), 'the lock file stays (never unlinked)');
  } finally { f.cleanup(); }
});

function supWorld(o: { owned?: boolean } = {}) {
  let now = 1_000_000;
  const launches: string[] = [];
  const managed = new Set([UDID]);
  const onPhoneStops: number[] = [];
  const deps: SupervisorDeps = {
    now: () => now, managed: () => [...managed], status: async () => false,
    phone: async (): Promise<PhoneFacts> => ({ found: true, paired: true, reachable: true, developerMode: true, locked: false }),
    launch: async () => { launches.push(UDID); throw new PhoneDockError('x', 'wda_setup_failed', 502); },
    stopOnPhone: async () => { onPhoneStops.push(now); return 0; },
    ledger: memLedger({ owned: o.owned }),
    log: () => undefined,
  };
  const sup = new WdaSupervisor(deps, { autoTick: false, maxAttempts: 3, backoffMs: [5_000], stopWaitMs: 200 });
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
  return { sup, deps, launches, managed, onPhoneStops, settle, advance(ms: number) { now += ms; }, async tickAfter(ms: number) { now += ms; await sup.tick(); await settle(); } };
}

test('#3: while another PhoneDock on this Mac owns the phone, this one launches nothing and setup says busy', async () => {
  const w = supWorld({ owned: true });
  w.sup.start(); await w.settle();
  assert.equal(w.launches.length, 0);
  assert.match(w.sup.info(UDID)!.message, /Another PhoneDock service/);
  await w.tickAfter(60_000);
  assert.equal(w.launches.length, 0);
  await assert.rejects(w.sup.setup(UDID, () => undefined), (e: PhoneDockError) => e.code === 'busy');
});

// ── #4 ────────────────────────────────────────────────────────────────────

test('#4: a runner that prints its address and exits at once counts, and the supervisor gives up (production startRunner)', async () => {
  let now = 1_000_000;
  const launches: number[] = [];
  const spawn = () => {
    const k = new FakeChild();
    // The marker and the exit arrive together: the exit lands while the launch promise is still settling.
    setImmediate(() => { k.say(`ServerURLHere->http://${TUNNEL}:8100<-ServerURLHere`); k.exit(1); });
    return k;
  };
  const deps: SupervisorDeps = {
    now: () => now, managed: () => [UDID], status: async () => false,
    phone: async () => ({ found: true, paired: true, reachable: true, developerMode: true, locked: false }),
    launch: async (_u, onP, ctl) => {
      launches.push(now);
      await ctl.beforeStart();
      const r = await startRunner(spawn, { xctestrun: '/x', destination: `id=${UDID}`, env: {}, now: () => now }, onP);
      // launchWda checks the runner after it prints its address (/status, the Wi-Fi probe): the exit lands meanwhile.
      await new Promise((res) => setTimeout(res, 5));
      return { runner: r.runner, url: `http://[${TUNNEL}]:8100` };
    },
    stopOnPhone: async () => 0,
    log: () => undefined,
  };
  const sup = new WdaSupervisor(deps, { autoTick: false, maxAttempts: 3, backoffMs: [5_000, 5_000, 5_000] });
  const settle = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)); };
  sup.start(); await settle(); await new Promise((r) => setTimeout(r, 10)); await settle();
  for (let i = 0; i < 12; i++) { now += 15_000; await sup.tick(); await settle(); await new Promise((r) => setTimeout(r, 10)); await settle(); }
  const info = sup.info(UDID)!;
  assert.equal(info.state, 'failed', `gave up (state ${info.state}, attempts ${info.attempts})`);
  assert.ok(launches.length <= 3, `bounded: ${launches.length} launches`);
});

// ── #5 ────────────────────────────────────────────────────────────────────

test('#5: stop() waits for runners to end (Mac and phone) and cancels a setup queued behind a launch; nothing starts after', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const launches: string[] = [];
  const events: string[] = [];
  const deps: SupervisorDeps = {
    now: () => 1, managed: () => [UDID], status: async () => ({ ok: true }),
    phone: async () => ({ found: true, paired: true, reachable: true, developerMode: true, locked: false }),
    launch: async (_u, _p, ctl) => {
      launches.push('launch'); await gate;
      if (ctl.signal.aborted) throw new PhoneDockError('stopped', 'cancelled', 409);
      throw new Error('unreachable in this test');
    },
    stopOnPhone: async () => { events.push('stopOnPhone'); return 0; },
    log: () => undefined,
  };
  const sup = new WdaSupervisor(deps, { autoTick: false, stopWaitMs: 500 });
  sup.start();
  await new Promise((r) => setImmediate(r));
  const queued = sup.setup(UDID, () => undefined);          // waits for the daemon-start launch
  const stopping = sup.stop();
  release();
  await stopping;
  await assert.rejects(queued, (e: PhoneDockError) => e.code === 'cancelled');
  assert.deepEqual(launches, ['launch'], 'the queued setup never launched');
  assert.equal(sup.isStarted, false);
});

// ── #6 and #13: setup orchestration ────────────────────────────────────────

function setupWorld(o: { facts?: PhoneFacts & { udid?: string }; teams?: XcodeTeam[]; supSetup?: (udid: string) => Promise<{ url: string }>; info?: () => WdaControl | undefined } = {}) {
  const store = new Map<string, SetupEntry>();
  let clock = 0;
  const marks = new Map<string, number>();
  const calls: string[] = [];
  let phoneGate: Promise<void> | undefined;
  const d: SetupDeps = {
    xcode: async () => ({ build: '27B52', version: '27.2', minIos: '17.0' }),
    teams: async () => o.teams ?? [{ id: TEAM_A, name: 'Example Co', free: false }],
    phone: async () => { if (phoneGate) await phoneGate; return o.facts ?? { found: true, udid: UDID, paired: true, reachable: true, osVersion: '18.7', developerMode: true, locked: false }; },
    developerMode: async () => true,
    exists: () => true,
    marks: { now: () => clock, since: (id, t) => (marks.get(id) ?? 0) > t },
    store: { get: (u) => store.get(u), set: (u, e) => { if (e) store.set(u, e); else store.delete(u); } },
    sup: {
      setup: async (u: string) => { calls.push(`setup:${u}:${store.get(u)?.wda?.bundleId}`); return o.supSetup ? o.supSetup(u) : { url: `http://[${TUNNEL}]:8100` }; },
      info: () => o.info?.(),
      unmanage: async (u: string) => { calls.push(`unmanage:${u}`); return 0; },
      resume: (u: string) => { calls.push(`resume:${u}`); },
      halt: async (u: string) => { calls.push(`halt:${u}`); return 0; },
    } as SetupDeps['sup'],
    running: new Set(),
    changed: () => undefined,
  };
  return {
    d, store, calls,
    mark(id: string) { marks.set(id, ++clock); },
    holdPhone() { let open!: () => void; phoneGate = new Promise((r) => { open = r; }); return () => { phoneGate = undefined; open(); }; },
  };
}

test('#6: Disconnect during preflight wins: the setup that began before it writes nothing and starts nothing', async () => {
  const w = setupWorld();
  const open = w.holdPhone();
  const s = setupPhone(w.d, UDID, {}, () => undefined);
  w.mark(UDID);                                            // Disconnect returned success while Xcode/devicectl were asked
  open();
  await assert.rejects(s, (e: PhoneDockError) => e.code === 'wda_setup_failed' && e.cause === 'cancelled');
  assert.equal(w.store.size, 0, 'no record recreated');
  assert.deepEqual(w.calls, [], 'nothing signed or launched');
});

test('#6: a failed setup puts the whole entry back, a new name included', async () => {
  const w = setupWorld({ supSetup: async () => { throw new PhoneDockError('Couldn’t build WebDriverAgent', 'wda_setup_failed', 502); } });
  w.store.set(UDID, { udid: UDID, name: 'Old name', wda: { ...cfgA, since: '2026-11-01T00:00:00Z' } });
  await assert.rejects(setupPhone(w.d, UDID, { name: 'New name', team: TEAM_A }, () => undefined));
  assert.equal(w.store.get(UDID)?.name, 'Old name');
  assert.ok(w.calls.includes(`resume:${UDID}`), 'the previous setup resumes');
});

test('#13: only a failure the service took on says it carries on; a preflight rejection doesn’t', async () => {
  const locked = setupWorld({ facts: { found: true, udid: UDID, paired: true, reachable: true, osVersion: '18.7', developerMode: true, locked: true } });
  const e1 = (await setupPhone(locked.d, UDID, {}, () => undefined).catch((e) => e)) as PhoneDockError;
  assert.equal(e1.code, 'wda_setup_failed');
  assert.equal(e1.cause, 'device_locked', 'the job keeps its old code; the cause names what to fix');
  assert.ok(!(e1.hints ?? []).some((h: string) => /keeps trying/.test(h)), 'nobody retries a preflight rejection');
  assert.equal(locked.store.size, 0, 'nothing managed');

  const waiting = setupWorld({
    supSetup: async () => { throw new PhoneDockError('Unlock the iPhone', 'device_locked', 409); },
    info: () => ({ managed: true, state: 'waiting_unlock', message: 'Unlock', attempts: 0, updatedAt: '', shared: false }),
  });
  const e2 = (await setupPhone(waiting.d, UDID, {}, () => undefined).catch((e) => e)) as PhoneDockError;
  assert.ok((e2.hints ?? []).some((h: string) => /keeps trying/.test(h)), 'the supervisor is waiting: it says so');
  assert.ok(waiting.store.get(UDID)?.wda, 'and keeps the setup');
});

test('#3: setup by CoreDevice identifier manages the hardware UDID; a destination naming another device is refused', async () => {
  const w = setupWorld();
  const r = await setupPhone(w.d, COREDEVICE_ID, {}, () => undefined);
  assert.equal(r.hardwareUdid, UDID);
  assert.ok(w.store.has(UDID) && !w.store.has(COREDEVICE_ID));
  await assert.rejects(setupPhone(w.d, UDID, { destination: 'id=00008020-0000CCCC0000DDDD' }, () => undefined), (e: PhoneDockError) => e.code === 'bad_request');
});

// ── #8 ────────────────────────────────────────────────────────────────────

test('#8: Apple’s quota stops automatic builds: no retry, no restart on reconnect (only a person’s setup asks Apple again)', async () => {
  const w = supWorld();
  w.deps.launch = async () => { w.launches.push(UDID); throw new PhoneDockError('Team reached Apple’s limit', 'signing_limit', 409); };
  w.sup.start(); await w.settle();
  assert.equal(w.sup.info(UDID)?.state, 'failed');
  for (let i = 0; i < 10; i++) await w.tickAfter(5 * 60_000);
  w.sup.observe([{ udid: UDID, reachable: false }]);
  w.sup.observe([{ udid: UDID, reachable: true }]);
  await w.settle();
  assert.equal(w.launches.length, 1, 'one request to Apple, not seven');

});

// ── #9 ────────────────────────────────────────────────────────────────────

test('#9: an expired profile is named as such even with iOS’s generic signature sentence; the sentence alone isn’t “trust”', () => {
  const generic = 'Unable to launch com.facebook.WebDriverAgentRunner.xctrunner because it has an invalid code signature, inadequate entitlements or its profile has not been explicitly trusted by the user.';
  assert.equal(classifyXcodebuild(`${generic}\nThe provisioning profile has expired.`, 'launch').code, 'signing_expired');
  assert.equal(classifyXcodebuild(generic, 'launch').code, 'signature_invalid');
  assert.equal(classifyXcodebuild('Untrusted Developer', 'launch').code, 'wda_untrusted');
});

// ── #10 ───────────────────────────────────────────────────────────────────

test('#10: simulator and device builds never share a product; a re-pinned artifact gets a fresh build; simulators build unsigned', async () => {
  const k = (o: Partial<Parameters<typeof buildKey>[0]>) => buildKey({ wdaVersion: '16.15.3', artifact: 'a', platform: 'iphoneos', team: TEAM_A, xcodeBuild: '27B52', bundleId: UPSTREAM_RUNNER_BUNDLE_ID, ...o });
  assert.notEqual(k({}), k({ platform: 'iphonesimulator' }));
  assert.notEqual(k({}), k({ artifact: 'b' }));
  const sim = buildArgv({ project: 'p', derivedData: 'd', destination: `platform=iOS Simulator,id=${UDID}`, team: 'unsigned', bundleId: UPSTREAM_RUNNER_BUNDLE_ID });
  assert.ok(!sim.some((a) => /DEVELOPMENT_TEAM|allowProvisioning/.test(a)));

  const f = fixture();
  try {
    const dev = await ensureBuild(f.d, UDID, cfgA, () => undefined);
    const s = await ensureBuild(f.d, UDID, { ...cfgA, team: 'unsigned', destination: `platform=iOS Simulator,id=${UDID}` }, () => undefined);
    assert.equal(s.built, true, 'a simulator request doesn’t take the device product');
    assert.match(s.xctestrun, /_iphonesimulator/);
    assert.match(dev.xctestrun, /_iphoneos/);
    assert.equal(findXctestrun(join(s.dir, 'DerivedData'), 'iphoneos'), undefined);
    f.setArtifact('16.15.3-0000deadbeef');               // same version, different bytes
    assert.equal((await ensureBuild(f.d, UDID, cfgA, () => undefined)).built, true);
  } finally { f.cleanup(); }

  const w = setupWorld();
  let asked = false;
  w.d.teams = async () => { asked = true; return []; };
  const r = await setupPhone(w.d, UDID, { destination: `platform=iOS Simulator,id=${UDID}` }, () => undefined);
  assert.equal(asked, false, 'no signing team for a simulator');
  assert.equal(r.team, 'unsigned');
});

// ── #11 ───────────────────────────────────────────────────────────────────

test('#11: a paid team that can’t sign upstream’s runner id falls back to its own id once, and keeps it', async () => {
  let n = 0;
  const w = setupWorld({ supSetup: async () => { if (n++ === 0) throw new PhoneDockError('Team can’t register', 'bundle_id_unavailable', 409); return { url: `http://[${TUNNEL}]:8100` }; } });
  await setupPhone(w.d, UDID, {}, () => undefined);
  assert.deepEqual(w.calls, [`setup:${UDID}:${UPSTREAM_RUNNER_BUNDLE_ID}`, `setup:${UDID}:${teamScopedBundleId(TEAM_A)}`]);
  assert.equal(w.store.get(UDID)?.wda?.bundleId, teamScopedBundleId(TEAM_A));
  await setupPhone(w.d, UDID, {}, () => undefined);
  assert.equal(w.calls.at(-1), `setup:${UDID}:${teamScopedBundleId(TEAM_A)}`, 'next time it starts with the one that worked');
});

// ── #12 ───────────────────────────────────────────────────────────────────

test('#12: an API key’s path and IDs never reach progress or error details', async () => {
  const key = { path: '/private/keys/AuthKey_KEYID12345.p8', keyId: 'KEYID12345', issuerId: '69a6de70-0000-47e3-e053-5b8c7c11a4d1' };
  assert.equal(redact(`xcodebuild -authenticationKeyPath ${key.path} -authenticationKeyID ${key.keyId} failed`, key), 'xcodebuild -authenticationKeyPath <redacted> -authenticationKeyID <redacted> failed');
  assert.equal(redact(`Could not read ${key.path} (issuer ${key.issuerId})`, key), 'Could not read <api-key-path> (issuer <api-key-issuer>)');
  const k = new FakeChild();
  const progress: string[] = [];
  const b = runBuild(() => k, { project: 'p', derivedData: 'd', destination: `id=${UDID}`, team: TEAM_A, bundleId: UPSTREAM_RUNNER_BUNDLE_ID, apiKey: key }, {}, (l) => progress.push(l));
  setImmediate(() => { k.say(`xcodebuild: error: Could not read the key at ${key.path} for ${key.keyId}`); k.exit(65); });
  const e = (await b.catch((x) => x)) as PhoneDockError;
  assert.ok(!`${e.detail}${progress.join('\n')}`.includes(key.path) && !`${e.detail}`.includes(key.keyId));
});

// ── #14 ───────────────────────────────────────────────────────────────────

test('#14: xcodebuild that can’t be started at all keeps the exec_failed code', async () => {
  const noXcode = () => { const k = new FakeChild(); setImmediate(() => k.emit('error', new Error('spawn xcodebuild ENOENT'))); return k; };
  const plan = { project: 'p', derivedData: 'd', destination: `id=${UDID}`, team: TEAM_A, bundleId: UPSTREAM_RUNNER_BUNDLE_ID };
  await assert.rejects(runBuild(noXcode, plan, {}, () => undefined), (e: PhoneDockError) => e.code === 'exec_failed' && e.status === 500);
  await assert.rejects(startRunner(noXcode, { xctestrun: '/x', destination: `id=${UDID}`, env: {}, now: () => 1 }, () => undefined),
    (e: PhoneDockError) => e.code === 'exec_failed' && /ENOENT/.test(e.detail ?? ''));
});

// ── on the phone: the runner outlives xcodebuild ───────────────────────────

test('FIX-3: Stop ends xcodebuild first, then the runner on the phone, and confirms; a failed confirmation is logged', async () => {
  const order: string[] = [];
  const logs: string[] = [];
  let left = 0;
  const deps: SupervisorDeps = {
    now: () => 1, managed: () => [UDID], status: async () => ({ ok: true }),
    phone: async () => ({ found: true, paired: true, reachable: true, developerMode: true, locked: false }),
    launch: async (_u, _p, ctl) => {
      await ctl.beforeStart();
      let resolveExit!: (c: number | null) => void;
      let live = true;
      const runner = { pid: 1, startedAt: 1, alive: () => live, kill: () => { order.push('xcodebuild'); live = false; resolveExit(130); }, exited: new Promise<number | null>((r) => { resolveExit = r; }) };
      return { runner, url: `http://[${TUNNEL}]:8100` };
    },
    stopOnPhone: async () => { order.push('phone'); return left; },
    log: (m) => logs.push(m),
  };
  const sup = new WdaSupervisor(deps, { autoTick: false, stopWaitMs: 200 });
  sup.start();
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  order.length = 0;
  await sup.unmanage(UDID);
  assert.deepEqual(order, ['xcodebuild', 'phone']);
  left = 1;
  await sup.unmanage(UDID);                               // nothing tracked, but a person's Stop still looks on the phone
  assert.deepEqual(order, ['xcodebuild', 'phone', 'phone']);
  assert.ok(logs.some((l) => /couldn’t confirm WebDriverAgent stopped on the iPhone/.test(l)));
});

// ── follow-ups from the final review ───────────────────────────────────────

test('a tunnel address in another spelling is the same address (no endless relaunch, no refused input)', async () => {
  const { sameHost, hostOf } = await import('./ios-wda.ts');
  assert.ok(sameHost('FD00:0000:0000:0001:0000:0000:0000:0001', 'fd00:0:0:1::1'));
  assert.equal(hostOf('http://[FD00:0:0:1:0:0:0:1]:8100'), 'fd00:0:0:1::1');
  assert.ok(!sameHost('fd00:0:0:1::1', 'fd00:0:0:2::1'));
});

test('a tunnel that keeps changing address relaunches, but counts after the first and gives up', async () => {
  let now = 1_000_000;
  let n = 0;
  const deps: SupervisorDeps = {
    now: () => now, managed: () => [UDID], status: async () => ({ ok: true }),
    phone: async () => ({ found: true, paired: true, reachable: true, developerMode: true, locked: false }),
    launch: async (_u, _p, ctl) => {
      await ctl.beforeStart();
      n++;
      let live = true; let res!: (c: number | null) => void;
      const runner = { pid: n, startedAt: now, readyAt: now, alive: () => live, kill: () => { live = false; res(130); }, exited: new Promise<number | null>((r) => { res = r; }) };
      return { runner, url: `http://[fd00:0:0:${n}::1]:8100` };
    },
    stopOnPhone: async () => 0, log: () => undefined,
  };
  const sup = new WdaSupervisor(deps, { autoTick: false, maxAttempts: 3, stopWaitMs: 50 });
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  sup.start(); await settle();
  for (let i = 0; i < 8 && sup.info(UDID)?.state !== 'failed'; i++) {
    now += 10_000;
    sup.observe([{ udid: UDID, reachable: true, tunnelIp: `fd00:0:0:${900 + i}::1` }]);
    await settle();
  }
  assert.equal(sup.info(UDID)?.state, 'failed');
  assert.ok(n <= 4, `bounded relaunches (${n})`);
});

test('daemon start ends a leftover runner even while the phone waits for an unlock', async () => {
  const stops: string[] = [];
  const deps: SupervisorDeps = {
    now: () => 1, managed: () => [UDID], status: async () => false,
    phone: async () => ({ found: true, paired: true, reachable: true, developerMode: true, locked: true }),
    launch: async () => { throw new Error('no launch while locked'); },
    stopOnPhone: async (u) => { stops.push(u); return 0; }, log: () => undefined,
  };
  const sup = new WdaSupervisor(deps, { autoTick: false });
  sup.start();
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.equal(sup.info(UDID)?.state, 'waiting_unlock');
  assert.deepEqual(stops, [UDID], 'the leftover runner (maybe on the Wi-Fi) is ended without waiting for the unlock');
});

test('Stop leaves the phone alone when another PhoneDock on this Mac runs it, and says the stop wasn’t confirmed otherwise', async () => {
  const stops: string[] = [];
  const base: SupervisorDeps = {
    now: () => 1, managed: () => [], status: async () => false,
    phone: async () => ({ found: true }), launch: async () => { throw new Error('x'); },
    stopOnPhone: async (u) => { stops.push(u); return 0; }, log: () => undefined,
  };
  const owned = new WdaSupervisor({ ...base, ledger: memLedger({ owned: true }) });
  assert.equal(await owned.unmanage(UDID), -2);
  assert.deepEqual(stops, [], 'another service’s runner is not killed');
  const unsure = new WdaSupervisor({ ...base, stopOnPhone: async () => { throw new Error('devicectl listed no processes'); } });
  assert.equal(await unsure.unmanage(UDID), -1, 'no answer is not "confirmed gone"');
});
