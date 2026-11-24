// Idle sleep in the emulator backend, against a fake Android SDK (android-fake-sdk.ts) that behaves like the real
// emulator where it matters: `emu kill` saves on the way out, an ordinary boot loads that save (a stale one undoes the
// disk writes made since) or cold-boots when it can't.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { PhoneDockError, SleepState } from '../core/types.ts';
import { fakeAndroidSdk, fakeManagedAvd } from './android-fake-sdk.ts';

process.env.PHONEDOCK_HOME = mkdtempSync(join(tmpdir(), 'pd-emu-sleep-'));
process.env.ANDROID_AVD_HOME_USER = mkdtempSync(join(tmpdir(), 'pd-emu-sleep-user-'));   // not the person's own AVDs
const sdk = fakeAndroidSdk();
const { backend } = await import('./android-emulator.ts');
const NAME = 'pdtest-x';
const AVD_HOME = join(process.env.PHONEDOCK_HOME, 'avd');
let dir = fakeManagedAvd(process.env.PHONEDOCK_HOME, NAME);
const snaps = () => (existsSync(join(dir, 'snapshots')) ? readdirSync(join(dir, 'snapshots')).sort() : []);
const others: ChildProcess[] = [];
/** An emulator PhoneDock didn't start: of another AVD with the same name (`path`), or ours started by hand. */
function outsideEmulator(port: number, path: string, binName = 'emulator'): ChildProcess {
  const bin = join(sdk.root, 'emulator', binName);
  if (binName !== 'emulator') { copyFileSync(join(sdk.root, 'emulator', 'emulator'), bin); chmodSync(bin, 0o755); }
  if (path !== dir) sdk.set({ avdPaths: { ...sdk.state().avdPaths, [NAME]: path } });
  const c = spawn(bin, ['-avd', NAME, '-port', String(port), '-no-window'], { stdio: 'ignore', env: { ...process.env, ANDROID_AVD_HOME: AVD_HOME } });
  others.push(c);
  return c;
}
const until = async (f: () => boolean, ms = 10_000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); } };
function live(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
const serialOf = () => Object.entries(sdk.state().emulators).find(([, e]) => e.path === dir && live(e.pid))?.[0];
const adb = (serial: string, ...args: string[]) => { try { return execFileSync(join(sdk.root, 'platform-tools', 'adb'), ['-s', serial, ...args]).toString().trim(); } catch { return 'MISSING'; } };
async function stopAll() {
  for (const c of others.splice(0)) c.kill('SIGTERM');
  for (const e of Object.values(sdk.state().emulators)) { try { process.kill(e.pid, 'SIGTERM'); } catch { /* gone */ } }
  await until(() => Object.values(sdk.state().emulators).every((e) => !live(e.pid)));
  sdk.set({ emulators: {}, avdPaths: {}, badSnapshots: [], ignoreKill: false, exitSave: true, instrument: false, shellFails: false, psFails: false, dumpsysFails: false, userActivityAgoMs: 3_600_000,
    activeInstrumentation: false, instrFails: false, syncFails: false, syncKills: false, syncSwapsTo: undefined, bootCompleted: true });
}
/** Asleep the way the daemon does it: prepare, then the ordinary stop. */
async function putToSleep(): Promise<SleepState> {
  const state = await backend.prepareSleep!(NAME);
  return backend.stopForSleep!(NAME, state);
}
beforeEach(async () => { await stopAll(); sdk.clearLog(); });
after(async () => { await stopAll().catch(() => undefined); sdk.killAll(); });

test('a same-named emulator running another AVD is never touched by sleep or wake', async () => {
  outsideEmulator(5570, '/opt/other-avds/pdtest-x.avd');   // another AVD home (Android Studio's)
  await until(() => !!sdk.state().emulators['emulator-5570']);
  assert.equal((await backend.listDevices()).find((d) => d.nativeId === NAME)?.state, 'stopped', 'inventory: not ours');
  await assert.rejects(backend.prepareSleep!(NAME));
  await backend.stopForSleep!(NAME, { at: new Date().toISOString() }).catch(() => undefined);
  const touched = sdk.log().filter((l) => / -s emulator-5570 (emu (avd snapshot|kill)|shell)/.test(l));
  assert.deepEqual(touched, [], 'nothing was sent to the other emulator');
});

test('a stop matches the emulator by its path now, not by a serial remembered from before (a reused console port)', async () => {
  await backend.boot!(NAME, { headless: true });
  const port = Number(serialOf()!.replace('emulator-', ''));
  const state = await backend.prepareSleep!(NAME);
  await backend.keepAwake!(NAME);                            // the inventory has seen it on that port
  const ours = sdk.state().emulators[`emulator-${port}`];
  process.kill(ours.pid, 'SIGKILL');                         // it goes, and another AVD of that name takes its port
  outsideEmulator(port, '/opt/other-avds/pdtest-x.avd');
  await until(() => sdk.state().emulators[`emulator-${port}`]?.path === '/opt/other-avds/pdtest-x.avd');
  sdk.clearLog();
  await backend.stopForSleep!(NAME, state).catch(() => undefined);
  assert.ok(!sdk.log().some((l) => l.includes(`-s emulator-${port} emu kill`)), 'the other AVD’s emulator was not stopped');
});

test('a wake never acts on a same-named AVD of the person’s when PhoneDock’s own is gone', async () => {
  await backend.boot!(NAME, { headless: true });
  const saved = await putToSleep();
  const theirs = join(process.env.ANDROID_AVD_HOME_USER!, `${NAME}.avd`);
  mkdirSync(join(theirs, 'snapshots'), { recursive: true });
  writeFileSync(join(process.env.ANDROID_AVD_HOME_USER!, `${NAME}.ini`), `path=${theirs}\n`);
  writeFileSync(join(theirs, 'config.ini'), 'hw.ramSize=2048\n');
  rmSync(dir, { recursive: true, force: true }); rmSync(join(AVD_HOME, `${NAME}.ini`), { force: true });   // deleted outside PhoneDock
  sdk.clearLog();
  try {
    assert.ok(saved.avdPath?.endsWith(`/${NAME}.avd`), 'the marker knows which AVD went to sleep');
    await assert.rejects(backend.checkSleeping!(NAME, saved), (e: PhoneDockError) => e.code === 'not_found', 'lifecycle and snapshot routes ask this');
    await assert.rejects(backend.wakeFromSleep!(NAME, saved), (e: PhoneDockError) => e.code === 'not_found');
    assert.ok(!sdk.log().some((l) => /^emulator .*-avd pdtest-x/.test(l)), 'the person’s AVD was not started');
  } finally {
    rmSync(theirs, { recursive: true, force: true }); rmSync(join(process.env.ANDROID_AVD_HOME_USER!, `${NAME}.ini`), { force: true });
    dir = fakeManagedAvd(process.env.PHONEDOCK_HOME!, NAME);
  }
});

test('a sleep stops the phone the ordinary way: writes flushed first, its exit save proven, one quick-boot state', async () => {
  await backend.boot!(NAME, { headless: true });
  const saved = await putToSleep();
  const log = sdk.log();
  const sync = log.findIndex((l) => / shell sync$/.test(l)); const kill = log.findIndex((l) => / emu kill$/.test(l));
  assert.ok(sync >= 0 && sync < kill, 'sync, then emu kill');
  assert.ok(saved.exitSave, 'its exit save is proven');
  assert.deepEqual(snaps(), ['default_boot'], 'one RAM image, the emulator’s own');
  const r = await backend.wakeFromSleep!(NAME, saved);
  assert.equal(r.resumed, true);
  assert.equal(r.via, 'quickboot');
});

test('no proven exit save: the wake, and any ordinary boot after it (a restart, shutdown then boot), start fresh and keep what was written since', async () => {
  await backend.boot!(NAME, { headless: true });
  for (const via of ['boot', 'wake'] as const) {
    await backend.wakeFromSleep!(NAME, await putToSleep());   // asleep with a proven save of default_boot, awake again
    adb(serialOf()!, 'shell', `echo ${via} > /data/local/tmp/pd-late.txt`);
    sdk.set({ exitSave: false });                             // this time the exit save doesn't happen
    const saved = await putToSleep();
    sdk.set({ exitSave: true });
    assert.equal(saved.exitSave, undefined);
    if (via === 'wake') assert.equal((await backend.wakeFromSleep!(NAME, saved)).resumed, false, 'started fresh');
    else await backend.boot!(NAME, { headless: true });
    assert.equal(adb(serialOf()!, 'shell', 'cat /data/local/tmp/pd-late.txt'), via, `${via}: the older save didn’t undo the write`);
  }
});

test('a quick-boot state loaded or rewritten since the sleep (started outside PhoneDock, then killed) is not resumed', async () => {
  await backend.boot!(NAME, { headless: true });
  const saved = await putToSleep();
  const c = outsideEmulator(5582, dir);                     // someone starts it by hand: it loads that save
  await until(() => !!sdk.state().emulators['emulator-5582']);
  adb('emulator-5582', 'shell', 'echo by-hand > /data/local/tmp/pd-hand.txt');
  c.kill('SIGKILL');                                        // and it crashes: no exit save
  await until(() => !live(c.pid!));
  const r = await backend.wakeFromSleep!(NAME, saved);
  assert.equal(r.resumed, false);
  assert.equal(adb(serialOf()!, 'shell', 'cat /data/local/tmp/pd-hand.txt'), 'by-hand', 'what was written by hand is kept');
});

test('an unloadable quick-boot state starts fresh, with apps and data kept', async () => {
  await backend.boot!(NAME, { headless: true });
  adb(serialOf()!, 'shell', 'echo kept > /data/local/tmp/pd-kept.txt');
  const saved = await putToSleep();
  sdk.set({ badSnapshots: ['default_boot'] });
  const r = await backend.wakeFromSleep!(NAME, saved);
  assert.equal(r.resumed, false);
  assert.equal(adb(serialOf()!, 'shell', 'cat /data/local/tmp/pd-kept.txt'), 'kept');
});

test('a stop with no proof the emulator exited is a failure, not "memory freed"', { timeout: 60_000 }, async () => {
  outsideEmulator(5574, dir, 'qemu-unlisted');   // ours, but its process can't be found by name
  await until(() => !!sdk.state().emulators['emulator-5574']);
  sdk.set({ ignoreKill: true });
  await assert.rejects(backend.stopForSleep!(NAME, { at: new Date().toISOString() }, { timeoutMs: 1500 }));
});

test('not enough free disk for the exit save keeps it running: the RAM size is read with its unit', async () => {
  await backend.boot!(NAME, { headless: true });
  const { readFileSync } = await import('node:fs');
  const cfg = join(dir, 'config.ini'); const was = readFileSync(cfg, 'utf8');
  writeFileSync(cfg, was.replace(/^hw\.ramSize=.*$/m, 'hw.ramSize=99999999M'));   // ~95 TB: never that much free
  try { await assert.rejects(backend.prepareSleep!(NAME), (e: PhoneDockError) => e.code === 'disk_full'); }
  finally { writeFileSync(cfg, was); }
});

test('the emulator’s own quick-boot state can’t be saved over, restored or deleted under a name that is it on this disk; a distinct DEFAULT_BOOT (case-sensitive disk) and "phonedock_sleep" are the person’s', async () => {
  await backend.boot!(NAME, { headless: true });
  let ci = false;   // the Mac's default volume: DEFAULT_BOOT is the same folder as default_boot
  try { ci = statSync(join(dirname(dir), basename(dir).toUpperCase())).ino === statSync(dir).ino; } catch { /* case-sensitive */ }
  for (const name of ['default boot', ...(ci ? ['DEFAULT_BOOT', 'Default_Boot'] : [])]) for (const op of ['saveSnapshot', 'restoreSnapshot', 'deleteSnapshot'] as const)
    await assert.rejects(backend[op]!(NAME, name), (e: PhoneDockError) => e.code === 'bad_request', `${op} ${name}`);
  assert.ok(!sdk.log().some((l) => /snapshot (save|load|delete) default_boot/.test(l)));
  if (!ci) {
    await backend.saveSnapshot!(NAME, 'DEFAULT_BOOT');
    assert.ok((await backend.listSnapshots!(NAME)).some((s) => s.name === 'DEFAULT_BOOT'), 'a distinct DEFAULT_BOOT is listed, as before idle sleep');
  }
  await backend.saveSnapshot!(NAME, 'phonedock_sleep');
  assert.ok((await backend.listSnapshots!(NAME)).some((s) => s.name === 'phonedock_sleep'), 'listed');
  await backend.wakeFromSleep!(NAME, await putToSleep());
  assert.ok(snaps().includes('phonedock_sleep'), 'sleep leaves the person’s snapshot alone');
  await backend.shutdown!(NAME);
  await assert.rejects(backend.deleteSnapshot!(NAME, 'default boot'), (e: PhoneDockError) => e.code === 'bad_request', 'stopped, too');
  assert.ok(snaps().includes('default_boot'));
  await backend.deleteSnapshot!(NAME, 'phonedock_sleep');
});

test('use PhoneDock can’t see keeps it awake: guest input, a test run, an adb session; unknown means awake', async () => {
  await backend.boot!(NAME, { headless: true });
  const serial = serialOf()!;
  const ka = (opts = {}) => backend.keepAwake!(NAME, { timeoutSec: 900, guest: true, ...opts } as never);
  assert.equal(await ka(), undefined, 'idle for an hour: nothing keeps it awake');
  sdk.set({ userActivityAgoMs: 60_000 });
  assert.match((await ka()) ?? '', /used/i);
  sdk.set({ userActivityAgoMs: 3_600_000, instrument: true });
  assert.match((await ka()) ?? '', /test/i);
  sdk.set({ instrument: false, activeInstrumentation: true });   // `am instrument` without -w: only Android knows
  assert.match((await ka()) ?? '', /test/i, 'an instrumentation Android lists as active');
  sdk.set({ activeInstrumentation: false });
  for (const fail of ['shellFails', 'psFails', 'dumpsysFails', 'instrFails'] as const) {   // no answer; only its ps; its idle clock; its test runs
    sdk.set({ instrument: false, shellFails: false, psFails: false, dumpsysFails: false, instrFails: false, [fail]: true });
    assert.match((await ka()) ?? '', /can’t tell/i, fail);
  }
  sdk.set({ dumpsysFails: false, instrFails: false });
  // someone's `adb -s <serial> logcat` in a terminal: not this process's child (started from a shell that exits)
  const d = mkdtempSync(join(tmpdir(), 'pd-adb-session-'));
  writeFileSync(join(d, 'adb'), '#!/bin/sh\nsleep 30\n'); chmodSync(join(d, 'adb'), 0o755);
  const pid = Number(execFileSync('/bin/sh', ['-c', `"${join(d, 'adb')}" -s ${serial} logcat >/dev/null 2>&1 & echo $!`]).toString().trim());
  try {
    await new Promise((r) => setTimeout(r, 3500));   // past the shared `ps` cache
    assert.match((await ka()) ?? '', /adb session/i);
  } finally { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  const e = Object.values(sdk.state().emulators)[0];
  sdk.set({ emulators: {} });                        // adb lost it (its process may still run): can't tell, never idle
  try { assert.match((await ka()) ?? '', /can’t tell/i, 'adb doesn’t list it'); } finally { process.kill(e.pid, 'SIGTERM'); }
});

test('an emulator whose process PhoneDock can’t tie to its serial (started without -port) is "can’t tell", never idle', async () => {
  const c = spawn(join(sdk.root, 'emulator', 'emulator'), ['-avd', NAME, '-no-window'], { stdio: 'ignore', env: { ...process.env, ANDROID_AVD_HOME: AVD_HOME, FAKE_EMU_PORT: '5586' } });
  others.push(c);
  await until(() => !!sdk.state().emulators['emulator-5586']);
  assert.match((await backend.keepAwake!(NAME, { timeoutSec: 900, guest: true })) ?? '', /can’t tell/i);
});

test('who may be on this emulator: adb with -e, -t or no selector; scrcpy with --serial or none. Not -d or another serial', async () => {
  const m = await import('./android-emulator.ts') as unknown as { adbSessionOn: (a: string, s: string) => string | undefined; scrcpyOn: (a: string, s: string) => boolean };
  const S = 'emulator-5554';
  for (const [args, want] of [['adb -e logcat', 'logcat'], ['/x/adb logcat -v brief', 'logcat'], ['adb -t 3 shell', 'shell'], ['adb -s emulator-5554 shell', 'shell'],
    ['adb -s emulator-5556 shell', undefined], ['adb -d shell', undefined], ['adb -L tcp:5037 fork-server server --reply-fd 4', undefined], ['adb devices', undefined]] as const) {
    assert.equal(m.adbSessionOn(args, S), want, args);
  }
  for (const [args, want] of [['scrcpy --serial emulator-5554', true], ['scrcpy --serial=emulator-5554', true], ['/opt/homebrew/bin/scrcpy', true],
    ['scrcpy -s emulator-5556', false], ['scrcpy -d', false], ['scrcpy -e', false]] as const) {
    assert.equal(m.scrcpyOn(args, S), want, args);
  }
});

test('the disk rule: started by hand while asleep (cold), written to and killed, the wake or an ordinary boot starts fresh and keeps the write', async () => {
  for (const via of ['wake', 'boot'] as const) {
    if (!serialOf()) await backend.boot!(NAME, { headless: true });
    const saved = await putToSleep();
    assert.ok(saved.exitSave);
    const c = spawn(join(sdk.root, 'emulator', 'emulator'), ['-avd', NAME, '-port', '5584', '-no-window', '-no-snapshot-load'], { stdio: 'ignore', env: { ...process.env, ANDROID_AVD_HOME: AVD_HOME } });
    others.push(c);
    await until(() => !!sdk.state().emulators['emulator-5584']);
    adb('emulator-5584', 'shell', `echo ${via}-while-asleep > /data/local/tmp/pd-outside.txt`);   // snapshot.pb untouched, the disk not
    process.kill(c.pid!, 'SIGKILL'); await until(() => !live(c.pid!));
    if (via === 'wake') assert.equal((await backend.wakeFromSleep!(NAME, saved)).resumed, false, 'started fresh');
    else await backend.boot!(NAME, { headless: true });   // a restart, or a boot after a shutdown forgot the sleep
    assert.equal(adb(serialOf()!, 'shell', 'cat /data/local/tmp/pd-outside.txt'), `${via}-while-asleep`, via);
  }
});

test('once the stop is committed the old quick-boot state can’t be loaded: a crash then, and an ordinary boot, keep the writes', async () => {
  await backend.boot!(NAME, { headless: true });
  await backend.wakeFromSleep!(NAME, await putToSleep());   // a proven save to load, then awake again
  adb(serialOf()!, 'shell', 'echo after-the-save > /data/local/tmp/pd-late.txt');
  const e = Object.values(sdk.state().emulators)[0];
  sdk.set({ ignoreKill: true });                            // the kill doesn't land, then the emulator dies (or this daemon does)
  await assert.rejects(backend.stopForSleep!(NAME, await backend.prepareSleep!(NAME), { timeoutMs: 1000 }));
  assert.ok(existsSync(join(dir, 'phonedock-exit-save.json')), 'a record no boot can match, until a proof replaces it');
  process.kill(e.pid, 'SIGKILL'); await until(() => !live(e.pid));
  sdk.set({ ignoreKill: false });
  await backend.boot!(NAME, { headless: true });            // a restart, another service, an older PhoneDock
  assert.equal(adb(serialOf()!, 'shell', 'cat /data/local/tmp/pd-late.txt'), 'after-the-save');
});

test('the emulator dies during the guest’s sync, before the stop: nothing of its old quick-boot state loads after', async () => {
  await backend.boot!(NAME, { headless: true });
  await backend.wakeFromSleep!(NAME, await putToSleep());   // a proven save to load, then awake again
  adb(serialOf()!, 'shell', 'echo after-the-save > /data/local/tmp/pd-late.txt');
  const pid = Object.values(sdk.state().emulators)[0].pid;
  sdk.set({ syncKills: true });
  await assert.rejects(backend.stopForSleep!(NAME, await backend.prepareSleep!(NAME)), (e: PhoneDockError) => e.code === 'sleep_failed');
  sdk.set({ syncKills: false });
  await until(() => !live(pid));                            // really gone (reaped), not "already running"
  await backend.boot!(NAME, { headless: true });            // a restart, or a boot after a shutdown forgot the sleep
  assert.equal(adb(serialOf()!, 'shell', 'cat /data/local/tmp/pd-late.txt'), 'after-the-save');
});

test('the stop is bound to its emulator: a failed sync, or another emulator on its serial by then, stops nothing', async () => {
  await backend.boot!(NAME, { headless: true });
  const serial = serialOf()!;
  for (const set of [{ syncFails: true }, { syncSwapsTo: '/opt/other-avds/pdtest-x.avd' }]) {
    const state = await backend.prepareSleep!(NAME);
    sdk.set(set); sdk.clearLog();
    await assert.rejects(backend.stopForSleep!(NAME, state), (e: PhoneDockError) => e.code === 'sleep_failed', JSON.stringify(set));
    assert.ok(!sdk.log().some((l) => l.includes(' emu kill')), `nothing was stopped: ${JSON.stringify(set)}`);
    const st = sdk.state(); st.emulators[serial].path = dir;
    sdk.set({ syncFails: false, syncSwapsTo: undefined, emulators: st.emulators });
  }
});

test('a wake that finds the phone already starting (by hand) waits until it has booted', async () => {
  await backend.boot!(NAME, { headless: true });
  const saved = await putToSleep();
  sdk.set({ bootCompleted: false });
  outsideEmulator(5588, dir);
  await until(() => !!sdk.state().emulators['emulator-5588']);
  let done = false;
  const w = backend.wakeFromSleep!(NAME, saved).then((r) => { done = true; return r; });
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(done, false, 'not before it has booted');
  sdk.set({ bootCompleted: true });
  await w;
});

test('a wake starts the phone with the caller’s options: with a window when asked', async () => {
  await backend.boot!(NAME, { headless: true });
  const saved = await putToSleep(); sdk.clearLog();
  await backend.wakeFromSleep!(NAME, saved, { headless: false });
  const line = sdk.log().find((l) => /^emulator .*-avd pdtest-x/.test(l));
  assert.ok(line && !/ -no-window/.test(line), line ?? 'no emulator started');
});

test('one adb discovery serves a sweep’s cheap checks of several phones', async () => {
  await backend.boot!(NAME, { headless: true });
  await backend.keepAwake!(NAME);
  sdk.clearLog();
  await backend.keepAwake!(NAME); await backend.keepAwake!('pdtest-other'); await backend.keepAwake!(NAME);
  assert.ok(sdk.log().filter((l) => /^adb devices/.test(l)).length <= 1, sdk.log().join('\n'));
});

test('adbSessionOn: someone’s adb session on this serial, never PhoneDock’s own live view (also when orphaned)', async () => {
  const { adbSessionOn } = await import('./android-emulator.ts');
  assert.equal(adbSessionOn('/opt/sdk/platform-tools/adb -s emulator-5554 logcat', 'emulator-5554'), 'logcat');
  assert.equal(adbSessionOn('adb -s emulator-5554 shell', 'emulator-5554'), 'shell');
  assert.equal(adbSessionOn('adb -s emulator-5556 shell', 'emulator-5554'), undefined, 'another phone');
  assert.equal(adbSessionOn('/opt/sdk/platform-tools/adb -s emulator-5554 logcat -T 1 -v brief -s ScreenRecord:D PowerManagerService:I', 'emulator-5554'), undefined);
  assert.equal(adbSessionOn('/opt/sdk/platform-tools/adb -s emulator-5554 exec-out screenrecord --output-format=h264 --size 720x1560 --bit-rate 6000000 --time-limit 0 -', 'emulator-5554'), undefined);
});
