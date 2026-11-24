// Round 3 of PR #14's review: one test per rule (SIMPLIFY.md) and per open finding of the second review
// (codex-review-2), written before the fix. Fakes only: no phone, no Xcode; ios-device runs against fake-devicectl.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn as spawnChild } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhoneDockError, type ExecResult } from '../core/types.ts';
import * as W from './ios-wda.ts';
import type { ChildLike, Exec, PhoneFacts, ProbeResult, Runner, SetupDeps, SetupEntry, SupervisorDeps, WdaBuildDeps, WdaConfig, XcodeTeam } from './ios-wda.ts';
import { fakeDevicectl } from './fake-devicectl.ts';

const UDID = '00008020-0000AAAA0000BBBB';
const CORE_ID = '11111111-2222-3333-4444-555555555555';
const TEAM = 'AAAAA11111';
const TUNNEL = 'fd00:0:0:1::1', TUNNEL2 = 'fd00:0:0:2::1', WIFI = '192.0.2.10', WIFI2 = '192.0.2.11';
const cfg: WdaConfig = { team: TEAM, free: false, bundleId: W.UPSTREAM_RUNNER_BUNDLE_ID };
/** Dependencies the supervisor had before these fixes, so the old code fails on the behaviour under test. */
const LEGACY = { saveUrl: () => undefined, savedUrl: () => undefined } as object;
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
const errOf = async (p: Promise<unknown>) => p.then(() => undefined, (e) => e as PhoneDockError & { cause?: string });

// ── launchWda fixture: a build directory and a fake xcodebuild that binds TEST_RUNNER_USE_IP ──

class FakeChild extends EventEmitter implements ChildLike {
  pid = 4242; stdout = new PassThrough(); stderr = new PassThrough(); killed: string[] = []; closed = false;
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean { this.killed.push(signal); this.exit(130); return true; }
  say(t: string): void { this.stdout.write(t + '\n'); }
  exit(code: number): void { if (this.closed) return; this.closed = true; this.stdout.end(); this.stderr.end(); setImmediate(() => this.emit('close', code)); }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pd-wda-rules-'));
  const srcDir = join(root, 'component', 'WebDriverAgent-16.15.3');
  mkdirSync(join(srcDir, 'WebDriverAgent.xcodeproj'), { recursive: true });
  const now = Date.parse('2026-11-24T12:00:00Z');
  const builds: string[][] = [];
  const kids: FakeChild[] = [];
  const probes = new Map<string, ProbeResult>();
  let launchSays: string | undefined;
  let status: unknown = { value: { ready: true, ios: { ip: WIFI } } };
  const spawn = (_c: string, args: string[], so: { env?: NodeJS.ProcessEnv } = {}) => {
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
    } else if (launchSays) {
      const t = launchSays;
      setImmediate(() => { k.say(t); k.exit(65); });
    } else {
      setImmediate(() => k.say(`ServerURLHere->http://${so.env?.TEST_RUNNER_USE_IP ?? WIFI}:8100<-ServerURLHere`));
    }
    return k;
  };
  const exec: Exec = async (cmd, args): Promise<ExecResult> => {
    if (cmd === '/usr/bin/security') { writeFileSync(args[args.indexOf('-o') + 1], '<plist/>'); return { code: 0, stdout: '', stderr: '' }; }
    if (args[1] === 'ExpirationDate') return { code: 0, stdout: new Date(now + 6 * 86_400_000).toISOString(), stderr: '' };
    if (args[1] === 'ProvisionedDevices') return { code: 0, stdout: JSON.stringify([UDID]), stderr: '' };
    return { code: 1, stdout: '', stderr: '' };
  };
  const d: WdaBuildDeps = {
    exec, spawn, now: () => now, env: {}, buildsDir: join(root, 'wda-builds'),
    source: async () => ({ path: srcDir, version: '16.15.3', key: '16.15.3-a232b9faaa47' }),
    xcode: async () => ({ build: '27B52', version: '27.2', minIos: '17.0' }),
    copyTree: async (from, to) => { cpSync(from, to, { recursive: true }); },
    writeFile: (p, t) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, t); },
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    remove: (p) => rmSync(p, { recursive: true, force: true }),
    endpoint: async () => ({ host: TUNNEL }),
    getJson: async () => status,
    probe: async (host, port) => probes.get(`${host}:${port}`) ?? 'refused',
    lockPollMs: 5,
  };
  return {
    d, builds, kids, probes,
    status(v: unknown) { status = v; },
    launchFails(line: string) { launchSays = line; },
    launchWorks() { launchSays = undefined; },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

// ── rule 1: fail closed ──

test('rule 1 / review-2 #2: private control needs positive evidence; anything inconclusive stops the runner', async () => {
  const f = fixture();
  try {
    const ok = await W.launchWda(f.d, UDID, cfg, () => undefined);
    assert.equal(ok.lanCheck, 'refused', 'the Wi-Fi address refused both ports');
    ok.runner.kill();
    for (const [what, setup] of [
      ['a probe that couldn’t tell (Local Network, a timeout)', () => { f.probes.set(`${WIFI}:9100`, 'unknown'); }],
      ['no /status through the tunnel', () => { f.probes.clear(); f.status(undefined); }],
      ['a /status without the ios section', () => { f.status({ value: { ready: true } }); }],
    ] as const) {
      setup();
      const before = f.kids.length;
      const e = await errOf(W.launchWda(f.d, UDID, cfg, () => undefined));
      assert.equal(e?.code, 'wda_unverified', what);
      assert.ok(f.kids.slice(before).every((k) => k.closed), `${what}: the runner is stopped`);
    }
    // The phone reports no Wi-Fi address: the bind on the tunnel address is the evidence.
    f.status({ value: { ready: true, ios: { ip: null } } });
    const none = await W.launchWda(f.d, UDID, cfg, () => undefined);
    assert.equal(none.lanCheck, 'none');
    none.runner.kill();
  } finally { f.cleanup(); }
});

/** A setupPhone world whose supervisor only records what it was asked to do. */
function setupWorld(o: { prior?: SetupEntry; locked?: boolean; setupFails?: PhoneDockError; afterState?: string; name?: string } = {}) {
  const store = new Map<string, SetupEntry | undefined>(o.prior ? [[UDID, structuredClone(o.prior)]] : []);
  const calls: string[] = [];
  let state = 'running';
  const d: SetupDeps = {
    xcode: async () => ({ build: '27B52', version: '27.2', minIos: '17.0' }),
    teams: async () => [{ id: TEAM, name: 'Paid', free: false }] as XcodeTeam[],
    phone: async () => ({ found: true, udid: UDID, paired: true, reachable: true, osVersion: '18.7', developerMode: true, locked: !!o.locked, name: o.name ?? 'Test iPhone' }) as PhoneFacts & { udid: string },
    developerMode: async () => true,
    exists: () => true,
    marks: { now: () => 0, since: () => false },
    store: { get: (u) => store.get(u), set: (u, e) => { store.set(u, e); } },
    sup: {
      setup: async (u: string) => {
        calls.push(`setup share=${!!store.get(u)?.wda?.share}`);
        if (o.setupFails) { state = 'failed'; throw o.setupFails; }
        state = o.afterState ?? 'running';
        return { url: `http://[${TUNNEL}]:8100`, pid: 7 };
      },
      info: () => ({ managed: true, state, message: '', attempts: 0, updatedAt: '', shared: false }) as never,
      unmanage: async () => { calls.push('unmanage'); return 0; },
      resume: () => { calls.push(`resume share=${!!store.get(UDID)?.wda?.share}`); },
      halt: async () => { calls.push(`halt share=${!!store.get(UDID)?.wda?.share}`); },
    } as unknown as SetupDeps['sup'],
    changed: () => undefined,
  };
  return { d, store, calls };
}
const sharedPrior: SetupEntry = { udid: UDID, wda: { ...cfg, share: true, since: '2026-11-24T00:00:00Z' } };

test('rule 1 / review-2 #1: turning sharing off is durable at once, even when the private launch fails', async () => {
  const w = setupWorld({ prior: sharedPrior, setupFails: new PhoneDockError('WebDriverAgent answered on the iPhone’s Wi-Fi address', 'wda_exposed', 502) });
  await assert.rejects(W.setupPhone(w.d, UDID, { share: false }, () => undefined));
  assert.equal(w.store.get(UDID)?.wda?.share ?? false, false, 'share=false stays persisted');
  assert.ok(!w.calls.some((c) => c.endsWith('share=true') && !c.startsWith('halt')), `never shared again: ${w.calls.join(', ')}`);
  assert.ok(w.calls.includes('halt share=false'), 'the shared runner was stopped before the private launch');
});

test('rule 1: turning sharing off stops the shared runner before anything that can fail (a locked phone)', async () => {
  const w = setupWorld({ prior: sharedPrior, locked: true });
  await assert.rejects(W.setupPhone(w.d, UDID, { share: false }, () => undefined));
  assert.equal(w.store.get(UDID)?.wda?.share ?? false, false);
  assert.deepEqual(w.calls, ['halt share=false']);
});

// ── rule 2: automatic actions never sign ──

test('rule 2: without a build, an automatic launch says a person must set up again, and builds nothing', async () => {
  const f = fixture();
  try {
    const e = await errOf(W.launchWda(f.d, UDID, cfg, () => undefined, { mayBuild: false } as never));
    assert.equal(e?.code, 'wda_rebuild_needed');
    assert.equal(f.builds.length, 0);
  } finally { f.cleanup(); }
});

test('rule 2 / review-2 #9: an expired or revoked signature is not re-signed by an automatic launch', async () => {
  const f = fixture();
  try {
    (await W.launchWda(f.d, UDID, cfg, () => undefined)).runner.kill();
    assert.equal(f.builds.length, 1);
    f.launchFails('The certificate was revoked');
    const e = await errOf(W.launchWda(f.d, UDID, cfg, () => undefined, { mayBuild: false } as never));
    assert.equal(e?.code, 'signing_expired');
    assert.equal(f.builds.length, 1, 'no new signing request');
  } finally { f.cleanup(); }
});

test('review-2 #9: Apple’s quota wins over the bundle-id wording in the same output (no second registration)', () => {
  const e = W.classifyXcodebuild('error: Failed to register bundle identifier\nYou have reached the maximum number of App IDs', 'build');
  assert.equal(e.code, 'signing_limit');
});

class Fr implements Runner {
  pid: number; startedAt: number; readyAt?: number; live = true; exited: Promise<number | null>; private res!: (c: number | null) => void;
  exitDelayMs = 0;
  constructor(pid: number, at: number) { this.pid = pid; this.startedAt = at; this.readyAt = at; this.exited = new Promise((r) => { this.res = r; }); }
  alive() { return this.live; }
  kill() { const go = () => { this.live = false; this.res(130); }; if (this.exitDelayMs) setTimeout(go, this.exitDelayMs); else go(); }
}

/** Supervisor world with an in-memory ledger (claims and cleanup records). */
function supWorld(o: { left?: number; managed?: string[]; shared?: boolean } = {}) {
  let now = 1_000_000;
  const ctls: { mayBuild?: boolean }[] = [];
  const runners: Fr[] = [];
  const events: string[] = [];
  const answering = new Map<string, string | null>();   // url → Wi-Fi ip it reports
  const records = new Map<string, { state: 'clean' | 'pending'; xcodebuild?: number }>();
  let left = o.left ?? 0;
  let tunnel = TUNNEL;
  let reachable = true;
  const managed = new Set(o.managed ?? [UDID]);
  const deps = {
    ...LEGACY,
    now: () => now,
    managed: () => [...managed],
    shared: () => !!o.shared,
    status: async (url: string) => (answering.has(url) ? { ok: true, ip: answering.get(url) } : false),
    phone: async () => ({ found: true, paired: true, reachable, developerMode: true, locked: false }),
    launch: async (_u: string, _p: unknown, ctl: { mayBuild?: boolean; beforeStart: () => Promise<void>; onSpawn?: (pid: number, x?: string) => void }) => {
      ctls.push({ mayBuild: ctl.mayBuild });
      events.push('build');
      await ctl.beforeStart();
      events.push('start');
      const r = new Fr(5000 + runners.length, now); runners.push(r);
      ctl.onSpawn?.(r.pid, '/x/WebDriverAgentRunner_iphoneos27.2-arm64.xctestrun');
      return { runner: r, url: `http://[${tunnel}]:8100`, ...(o.shared ? { sharedUrl: `http://${WIFI}:8100` } : { lanCheck: 'refused' as const }) };
    },
    stopOnPhone: async () => { events.push('stopOnPhone'); return left; },
    ledger: {
      lock: () => true, release: () => undefined,
      mark: (u: string, r: { xcodebuild?: number }) => { records.set(u, { state: 'pending', ...r }); },
      clean: (u: string) => { records.set(u, { state: 'clean' }); },
      state: (u: string) => records.get(u)?.state,
      pending: () => [...records].filter(([, r]) => r.state === 'pending').map(([udid, r]) => ({ udid, ...r })),
    },
    log: () => undefined,
  } as unknown as SupervisorDeps;
  const sup = new W.WdaSupervisor(deps, { tickMs: 15_000, graceMs: 45_000, backoffMs: [5_000, 15_000], maxAttempts: 3, personPollMs: 30_000,
    personBackoffMs: [30_000], maxPersonAttempts: 3, minUptimeMs: 60_000, stopWaitMs: 100, autoTick: false });
  return {
    sup, deps, ctls, runners, events, answering, records, managed,
    advance(ms: number) { now += ms; },
    setLeft(n: number) { left = n; },
    setTunnel(t: string) { tunnel = t; },
    setReachable(v: boolean) { reachable = v; },
    async tickAfter(ms: number) { now += ms; await sup.tick(); await settle(); },
  };
}

test('rule 2: the supervisor’s own launches use the existing build only; setup may build', async () => {
  const w = supWorld();
  w.sup.start(); await settle();
  await w.sup.setup(UDID, () => undefined);
  assert.deepEqual(w.ctls.map((c) => c.mayBuild), [false, true]);
});

// ── rule 3: one owner, and child ownership from the spawn ──

test('rule 3: a phone’s claim is a kernel lock: exclusive across processes, freed when the owner dies, never unlinked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-ledger-'));
  try {
    const a = new (W as any).WdaLedger(dir);
    assert.equal(a.lock(UDID), true);
    assert.equal(a.lock(UDID), true, 're-entrant in the owner');
    // Another process can't take it while this one holds it…
    const other = (code: string) => new Promise<string>((res) => {
      const c = spawnChild(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = ''; c.stdout.on('data', (b) => { out += b; }); c.on('close', () => res(out.trim()));
    });
    const tryOther = `import * as W from ${JSON.stringify(new URL('./ios-wda.ts', import.meta.url).href)}; console.log(new W.WdaLedger(${JSON.stringify(dir)}).lock(${JSON.stringify(UDID)}))`;
    assert.equal(await other(tryOther), 'false');
    a.release(UDID);
    assert.equal(await other(tryOther), 'true', 'released: the other process gets it (and exits, freeing it)');
    assert.equal(a.lock(UDID), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rule 3: a machine-wide claims directory is created sticky and writable by every user, and nothing above it changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'pd-ledger-shared-'));
  try {
    const before = statSync(root).mode & 0o7777;
    const dir = join(root, 'PhoneDock', 'wda');
    const l = new (W as any).WdaLedger(dir, { shared: true });
    assert.equal(l.lock(UDID), true);
    assert.equal(statSync(join(root, 'PhoneDock')).mode & 0o7777, 0o1777);
    assert.equal(statSync(dir).mode & 0o7777, 0o1777);
    assert.equal(statSync(root).mode & 0o7777, before, 'the existing parent is untouched');
    l.release(UDID);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rule 5: daemon exit ends what this process runs, and doesn’t wait on an older cleanup for an absent phone', async () => {
  const w = supWorld();
  w.records.set(UDID, { state: 'pending' });          // owed from before; the phone is away
  w.sup.start();                                      // (the first attempt would look; this test is about exit)
  w.events.length = 0;
  await w.sup.stop();
  assert.deepEqual(w.events.filter((e) => e === 'stopOnPhone'), [], 'exit didn’t ask the phone');
  assert.equal(w.records.get(UDID)?.state, 'pending', 'still owed: the next start finishes it');
});

test('review-2 #6: the xcodebuild is recorded for cleanup when it is spawned, before WebDriverAgent is ready', async () => {
  const w = supWorld();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  (w.deps as any).launch = async (_u: string, _p: unknown, ctl: any) => {
    await ctl.beforeStart();
    ctl.onSpawn?.(4242, '/x.xctestrun');
    await gate;                                // still waiting for ServerURLHere
    return { runner: new Fr(4242, 0), url: `http://[${TUNNEL}]:8100`, lanCheck: 'refused' };
  };
  const p = w.sup.setup(UDID, () => undefined);
  await settle();
  assert.equal(w.records.get(UDID)?.state, 'pending');
  assert.equal(w.records.get(UDID)?.xcodebuild, 4242);
  release(); await p;
});

// ── rule 5: teardown completes or is remembered ──

test('rule 5 / review-2 #5: a replacement doesn’t start while the old runner may still run on the phone', async () => {
  const w = supWorld();
  await w.sup.setup(UDID, () => undefined);
  w.setLeft(1);                                // the phone still lists a runner after the kill
  await assert.rejects(w.sup.setup(UDID, () => undefined));
  assert.equal(w.events.filter((e) => e === 'start').length, 1, 'no second runner');
  assert.equal(w.records.get(UDID)?.state, 'pending', 'remembered for the next try');
});

test('rule 5 / review-2 #5: Stop resolves only after xcodebuild has exited, and says whether the phone confirmed', async () => {
  const w = supWorld();
  await w.sup.setup(UDID, () => undefined);
  w.runners[0].exitDelayMs = 300;               // xcodebuild takes a while to end
  const left = await w.sup.unmanage(UDID);
  assert.equal(w.runners[0].alive(), false, 'xcodebuild is gone when Stop returns');
  assert.equal(left, 0);
  assert.equal(w.records.get(UDID)?.state, 'clean');
});

test('rule 5 / review-2 #5: an unconfirmed cleanup is remembered and retried at the next start, even for a phone no longer managed', async () => {
  const w = supWorld();
  await w.sup.setup(UDID, () => undefined);
  w.setLeft(-1);                               // devicectl couldn't answer
  w.managed.clear();
  await w.sup.unmanage(UDID);
  assert.equal(w.records.get(UDID)?.state, 'pending');
  w.setLeft(0);
  const next = new W.WdaSupervisor(w.deps, { autoTick: false, stopWaitMs: 100 });
  next.start(); await settle();
  assert.equal(w.records.get(UDID)?.state, 'clean', 'the next daemon finished the cleanup');
});

// ── rule 7: tunnel changes ──

test('rule 7 / review-2 #8: a runner the Mac can’t reach relaunches when the tunnel address changes', async () => {
  const w = supWorld();
  w.sup.start(); await settle();
  assert.equal(w.events.filter((e) => e === 'start').length, 1);
  w.setReachable(false);                       // quiet, and the phone is away: waits (uncounted) instead of relaunching
  await w.tickAfter(50_000);
  assert.equal(w.sup.info(UDID)?.state, 'unreachable');
  w.setReachable(true);
  w.setTunnel(TUNNEL2);
  w.sup.observe([{ udid: UDID, reachable: true, tunnelIp: TUNNEL2 }]);
  await settle();
  assert.equal(w.events.filter((e) => e === 'start').length, 2, 'relaunched on the new address');
});

test('rule 7: with sharing on, the advertised address follows the phone’s Wi-Fi address', async () => {
  const w = supWorld({ shared: true });
  w.sup.start(); await settle();               // the daemon's supervisor (only a started one watches)
  w.answering.set(`http://[${TUNNEL}]:8100`, WIFI2);
  await w.tickAfter(15_000);
  assert.equal(w.sup.info(UDID)?.sharedUrl, `http://${WIFI2}:8100`);
});

// ── rule 8: contract ──

test('rule 8 / review-2 #10: a setup failure keeps the wda_setup_failed code and names the cause', async () => {
  const w = setupWorld({ setupFails: new PhoneDockError('Team reached Apple’s limit', 'signing_limit', 409) });
  const e = await errOf(W.setupPhone(w.d, UDID, {}, () => undefined));
  assert.equal(e?.code, 'wda_setup_failed');
  assert.equal(e?.cause, 'signing_limit');
});

test('rule 8 / review-2 #10: a destination naming the requested phone by name keeps working; another name is refused', async () => {
  const ok = setupWorld();
  await W.setupPhone(ok.d, UDID, { destination: 'platform=iOS,name=Test iPhone' }, () => undefined);
  const other = setupWorld();
  const e = await errOf(W.setupPhone(other.d, UDID, { destination: 'platform=iOS,name=Another iPhone' }, () => undefined));
  assert.equal(e?.code, 'bad_request');
});

test('rule 8 / review-2 #10: the result keeps the caller’s udid and adds the hardware one', async () => {
  const w = setupWorld();
  const r = await W.setupPhone(w.d, CORE_ID, {}, () => undefined);
  assert.equal(r.udid, CORE_ID);
  assert.equal((r as any).hardwareUdid, UDID);
});

test('rule 8 / review-2 #10: setup succeeds only while the runner still runs', async () => {
  const w = setupWorld({ afterState: 'retrying' });
  const e = await errOf(W.setupPhone(w.d, UDID, {}, () => undefined));
  assert.equal(e?.code, 'wda_setup_failed');
});

// ── rule 9 ──

test('rule 9 / review-2 #11: an API key path with spaces never leaks, unquoted, quoted or escaped', () => {
  const key = { path: '/Keys/Release/Signing Keys/AuthKey_X.p8', keyId: 'KEYID12345', issuerId: '69a6de70-0000-0000-0000-000000000000' };
  for (const line of [
    `xcodebuild -authenticationKeyPath ${key.path} -authenticationKeyID ${key.keyId}`,
    `xcodebuild -authenticationKeyPath "${key.path}" -authenticationKeyIssuerID ${key.issuerId}`,
    `xcodebuild -authenticationKeyPath ${key.path.replace(/ /g, '\\ ')}`,
    `xcodebuild -authenticationKeyPath '/Other Keys/AuthKey_Y.p8' done`,
  ]) {
    const t = W.redact(line, key);
    for (const frag of ['Signing', 'Keys/', 'AuthKey', key.keyId, key.issuerId, 'Other']) assert.ok(!t.includes(frag), `${frag} leaked: ${t}`);
  }
});

// ── ios-device: identity, Stop and Disconnect, wiring, freshness ──

const home = mkdtempSync(join(tmpdir(), 'pd-ios-rules-'));
process.env.PHONEDOCK_HOME = home;
process.env.PHONEDOCK_WDA_CLAIMS_DIR = join(home, 'claims');
process.env.PHONEDOCK_COMPONENTS_AUTO = '0';
const fake = fakeDevicectl({ phones: [], runners: {} });
const { backend } = await import('./ios-device.ts');
const cfgFile = join(home, 'ios-device.json');
const writeCfg = (v: unknown) => writeFileSync(cfgFile, JSON.stringify(v));
const readCfg = () => JSON.parse(readFileSync(cfgFile, 'utf8'));

/** A WebDriverAgent that records every request. */
async function fakeWda(uuid = 'PHONE-A'): Promise<{ url: string; hits: string[]; server: Server }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/status') { res.end(JSON.stringify({ value: { ready: true, ios: { ip: WIFI } } })); return; }
    if (req.url === '/wda/device/info') { res.end(JSON.stringify({ value: { uuid } })); return; }
    if (req.url === '/session') { res.end(JSON.stringify({ sessionId: 's1', value: { sessionId: 's1' } })); return; }
    res.end(JSON.stringify({ value: { width: 375, height: 812 } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits, server };
}
const inputHits = (h: string[]) => h.filter((x) => x.startsWith('POST') || x.includes('/window/size') || x.includes('/actions'));

test('rule 4 / review-2 #3: a managed phone devicectl doesn’t list takes no input (no saved-address fallback)', async () => {
  const w = await fakeWda();
  try {
    fake.scenario.phones = []; fake.save();
    writeCfg({ [UDID]: { udid: UDID, wdaUrl: w.url, wda: { ...cfg, since: 'x' } } });
    await assert.rejects(backend.tap!(UDID, 10, 10));
    assert.deepEqual(inputHits(w.hits), []);
    const listed = await backend.listDevices();
    assert.ok(!listed.some((d) => d.nativeId === UDID), 'not listed as a manual connection either');
  } finally { w.server.close(); }
});

test('rule 4 / review-2 #3: a manual connection’s fingerprint is checked before input', async () => {
  const w = await fakeWda('PHONE-B');
  try {
    writeCfg({ [UDID]: { udid: UDID, wdaUrl: w.url, wdaDeviceId: 'PHONE-A' } });
    await assert.rejects(backend.tap!(UDID, 10, 10));
    assert.deepEqual(inputHits(w.hits), [], 'another iPhone answers there: nothing is sent');
  } finally { w.server.close(); }
});

test('rule 4 / review-2 #3: connecting a managed phone’s address under another udid is refused', async () => {
  const w = await fakeWda();
  try {
    writeCfg({ [UDID]: { udid: UDID, wdaUrl: w.url, wda: { ...cfg, since: 'x' } } });
    await assert.rejects(backend.connectWda(w.url, { udid: '00008020-0000CCCC0000DDDD' }));
    assert.equal(readCfg()['00008020-0000CCCC0000DDDD'], undefined);
  } finally { w.server.close(); }
});

test('review-2 #4: the backend hands the daemon its teardown promise', () => {
  const r = backend.stopWdaSupervisor() as unknown;
  assert.ok(r instanceof Promise, 'stopWdaSupervisor returns the drain');
});

test('review-2 #6: Stop by CoreDevice identifier acts on the phone’s hardware UDID', async () => {
  fake.scenario.phones = [{ udid: UDID, coreDeviceId: CORE_ID, tunnelIp: TUNNEL }]; fake.scenario.runners = {}; fake.save();
  writeCfg({});
  const r = await backend.wdaStop(CORE_ID);
  assert.equal(r.udid, UDID);
});

test('rule 5 (t1ct): Stop ends any runner on the phone, managed or not; Disconnect forgets, and touches the phone only when managed here', async () => {
  fake.scenario.phones = [{ udid: UDID, coreDeviceId: CORE_ID, tunnelIp: TUNNEL }];
  // Unmanaged (a manual connection, or a record from an older PhoneDock): Disconnect only forgets it…
  fake.scenario.runners = { [UDID]: [77] }; fake.save();
  writeCfg({ [UDID]: { udid: UDID, wdaUrl: `http://${WIFI}:8100` } });
  assert.equal(await backend.disconnect(UDID), true);
  assert.deepEqual(fake.runners(UDID), [77], 'Disconnect left the unmanaged runner alone');
  // …while Stop Control ends it.
  writeCfg({ [UDID]: { udid: UDID, wdaUrl: `http://${WIFI}:8100` } });
  const s = await backend.wdaStop(UDID);
  assert.deepEqual(fake.runners(UDID), [], 'Stop ended it');
  assert.equal(s.confirmed, true);
  // Managed here: both end it.
  for (const verb of ['disconnect', 'stop'] as const) {
    fake.scenario.runners = { [UDID]: [78] }; fake.save();
    writeCfg({ [UDID]: { udid: UDID, wda: { ...cfg, since: 'x' } } });
    if (verb === 'disconnect') await backend.disconnect(UDID); else await backend.wdaStop(UDID);
    assert.deepEqual(fake.runners(UDID), [], `${verb} ended our runner`);
  }
});

test('t1ct: a paired phone with WebDriverAgent from an earlier setup carries a plain notice', async () => {
  fake.scenario.phones = [{ udid: UDID, coreDeviceId: CORE_ID, tunnelIp: TUNNEL }]; fake.scenario.runners = {}; fake.save();
  writeCfg({ [UDID]: { udid: UDID, wdaUrl: `http://${WIFI}:8100` } });
  const raw = (await backend.listDevices()).find((x) => x.nativeId === UDID)!;
  assert.match(String(backend.liveDevice(raw)?.meta?.wdaNotice ?? ''), /earlier setup may still be running.*Stop Control ends it/s);
  // A confirmed Stop ends that runner, so its address and the notice go too.
  fake.scenario.runners = { [UDID]: [79] }; fake.save();
  assert.equal((await backend.wdaStop(UDID)).confirmed, true);
  assert.equal(readCfg()[UDID].wdaUrl, undefined);
  assert.equal(backend.liveDevice(raw)?.meta?.wdaNotice, null);
});

test('rule 6: a scan made in one control state, read in another, shows the new one (applied once per read)', async () => {
  fake.scenario.phones = [{ udid: UDID, coreDeviceId: CORE_ID, tunnelIp: TUNNEL }]; fake.scenario.runners = {}; fake.save();
  writeCfg({ [UDID]: { udid: UDID, wdaUrl: `http://${WIFI}:8100` } });
  const raw = (await backend.listDevices()).find((x) => x.nativeId === UDID)!;
  assert.equal(raw.meta?.wdaNotice, undefined, 'the scan itself carries no control state');
  writeCfg({ [UDID]: { udid: UDID, wda: { ...cfg, since: 'x' } } });     // set up meanwhile
  const now = backend.liveDevice(raw)!;
  assert.equal(now.meta?.wdaNotice, null);
  assert.equal((now.meta?.readiness as { hints: string[] }).hints.length, (raw.meta?.readiness as { hints: string[] }).hints.length + (now.meta?.wdaControl ? 1 : 0));
});

test('rule 1 / review-2 #1 (by alias): turning sharing off by CoreDevice identifier is durable at once too', async () => {
  fake.scenario.phones = [{ udid: UDID, coreDeviceId: CORE_ID, tunnelIp: TUNNEL }]; fake.scenario.runners = {}; fake.save();
  writeCfg({ [UDID]: { udid: UDID, wda: { ...cfg, share: true, since: 'x' } } });
  await assert.rejects(backend.wdaSetup(CORE_ID, { share: false }));       // no Xcode here: preflight fails after the opt-out
  assert.equal(readCfg()[UDID].wda?.share ?? false, false, 'sharing is off although the rest of setup failed');
});

test('review-2 #6: an orphaned xcodebuild is killed only when its command line still matches its record', async () => {
  const { killOrphanXcodebuild } = await import('./ios-device.ts');
  const xctestrun = join(home, 'WebDriverAgentRunner_iphoneos27.2-arm64.xctestrun');
  const child = spawnChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'test-without-building', '-xctestrun', xctestrun], { stdio: 'ignore' });
  try {
    assert.equal(killOrphanXcodebuild({ xcodebuild: child.pid, xctestrun: '/another.xctestrun' }), false, 'a reused pid is left alone');
    assert.equal(killOrphanXcodebuild({ xcodebuild: child.pid, xctestrun }), true);
    await new Promise((r) => child.once('exit', r));
  } finally { child.kill('SIGKILL'); }
});

test('rule 6: a device read right after Stop shows control stopped, without waiting for a scan', async () => {
  fake.scenario.phones = [{ udid: UDID, coreDeviceId: CORE_ID, tunnelIp: TUNNEL }]; fake.save();
  writeCfg({ [UDID]: { udid: UDID, wda: { ...cfg, since: 'x' } } });
  const stale = (await backend.listDevices()).find((x) => x.nativeId === UDID)!;
  await backend.wdaStop(UDID);
  const live = (backend as any).liveDevice?.(stale);
  assert.ok(live, 'the backend refreshes control state on every read');
  assert.equal(live.meta.wdaControl, null);
  assert.ok(live.meta.wdaStopped);
});

test.after(() => { fake.restore(); rmSync(home, { recursive: true, force: true }); });
