// Idle sleep in the emulator backend, against a fake Android SDK (android-fake-sdk.ts) that behaves like the real
// emulator where it matters: snapshots keep the guest's identity, `emu kill` saves on the way out, a forced load of a bad
// snapshot deletes it.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PhoneDockError, SleepState } from '../core/types.ts';
import { fakeAndroidSdk, fakeManagedAvd } from './android-fake-sdk.ts';

process.env.PHONEDOCK_HOME = mkdtempSync(join(tmpdir(), 'pd-emu-sleep-'));
process.env.ANDROID_AVD_HOME_USER = mkdtempSync(join(tmpdir(), 'pd-emu-sleep-user-'));   // not the person's own AVDs
const sdk = fakeAndroidSdk();
const { backend, resumedFrom } = await import('./android-emulator.ts');
const NAME = 'pdtest-x';
const dir = fakeManagedAvd(process.env.PHONEDOCK_HOME, NAME);
const snaps = () => (existsSync(join(dir, 'snapshots')) ? readdirSync(join(dir, 'snapshots')).sort() : []);
const others: ChildProcess[] = [];
/** An emulator PhoneDock didn't start, running an AVD of the same name somewhere else (Android Studio's). */
function foreignEmulator(port: number, path: string, binName = 'emulator'): ChildProcess {
  const bin = join(sdk.root, 'emulator', binName);
  if (binName !== 'emulator') { copyFileSync(join(sdk.root, 'emulator', 'emulator'), bin); chmodSync(bin, 0o755); }
  sdk.set({ avdPaths: { ...sdk.state().avdPaths, [NAME]: path } });
  const c = spawn(bin, ['-avd', NAME, '-port', String(port), '-no-window'], { stdio: 'ignore' });
  others.push(c);
  return c;
}
const until = async (f: () => boolean, ms = 10_000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); } };
async function stopAll() {
  for (const c of others.splice(0)) c.kill('SIGTERM');
  for (const e of Object.values(sdk.state().emulators)) { try { process.kill(e.pid, 'SIGTERM'); } catch { /* gone */ } }
  await until(() => Object.values(sdk.state().emulators).every((e) => { try { process.kill(e.pid, 0); return false; } catch { return true; } }));
  sdk.set({ emulators: {}, avdPaths: {}, badSnapshots: [], ignoreKill: false, exitSave: true, instrument: false, shellFails: false, userActivityAgoMs: 3_600_000, bootDelayMs: 0 });
}
beforeEach(async () => { await stopAll(); sdk.clearLog(); });
after(async () => { await stopAll().catch(() => undefined); sdk.killAll(); });

test('a same-named emulator running another AVD is never touched by sleep, wake or cleanup (#1)', async () => {
  foreignEmulator(5570, '/opt/other-avds/pdtest-x.avd');   // another AVD home (Android Studio's)
  await until(() => !!sdk.state().emulators['emulator-5570']);
  assert.equal((await backend.listDevices()).find((d) => d.nativeId === NAME)?.state, 'stopped', 'inventory: not ours');
  assert.equal(await backend.runningSerial(NAME), undefined);
  await assert.rejects(backend.saveSleep!(NAME));
  await backend.discardSleep!(NAME);
  await backend.stopAfterSleep!(NAME).catch(() => undefined);
  const touched = sdk.log().filter((l) => / -s emulator-5570 (emu (avd snapshot|kill)|shell)/.test(l));
  assert.deepEqual(touched, [], 'nothing was sent to the other emulator');
});

test('one checkpoint per sleep: only default_boot on disk while asleep, and the wake resumes it (#14)', async () => {
  await backend.boot!(NAME, { headless: true });
  const saved = await backend.saveSleep!(NAME);
  await backend.stopAfterSleep!(NAME);
  assert.deepEqual(snaps(), ['default_boot'], 'no second RAM image');
  const r = await backend.wakeFromSleep!(NAME, saved);
  assert.equal(r.resumed, true);
  assert.deepEqual(snaps(), ['default_boot']);
});

test('a wake whose saved state won’t load keeps it, and a retry does not call it a success (#5)', async () => {
  await backend.boot!(NAME, { headless: true });
  const saved = await backend.saveSleep!(NAME);
  await backend.stopAfterSleep!(NAME);
  const before = snaps();
  sdk.set({ badSnapshots: ['default_boot', 'phonedock_sleep'] });
  await assert.rejects(backend.wakeFromSleep!(NAME, saved));
  const retry = await backend.wakeFromSleep!(NAME, saved).then((r) => r, (e: PhoneDockError) => e);
  assert.ok(!('resumed' in retry), `the retry must fail too, not report ${JSON.stringify(retry)}`);
  assert.deepEqual(snaps(), before, 'the saved state is still on disk');
  sdk.set({ badSnapshots: [] });
  assert.equal((await backend.wakeFromSleep!(NAME, saved)).resumed, true, 'once it loads, the wake resumes it');
});

test('resumedFrom: the token written just before the save must match, not just the kernel session (#5)', () => {
  const saved = { bootId: 'ec09a1c4-9305-482d-9159-ecd5c7d1b1bb', uptimeSec: 100, token: 'mine' } as SleepState & { token: string };
  assert.equal(resumedFrom({ bootId: saved.bootId, uptimeSec: 130, token: 'mine' } as never, saved), true);
  assert.equal(resumedFrom({ bootId: saved.bootId, uptimeSec: 130, token: 'an-older-save' } as never, saved), false, 'another checkpoint of the same session');
});

test('a stop with no proof the emulator exited is a failure, not "memory freed" (#15)', { timeout: 240_000 }, async () => {
  foreignEmulator(5574, dir, 'qemu-unlisted');   // ours, but its process can't be found by name
  await until(() => !!sdk.state().emulators['emulator-5574']);
  sdk.set({ ignoreKill: true });
  await assert.rejects(backend.stopAfterSleep!(NAME, { timeoutMs: 1500 } as never));
});

test('public snapshot names that normalise to the checkpoint are refused; a person’s "phonedock_sleep" is theirs (#4)', async () => {
  await backend.boot!(NAME, { headless: true });
  await assert.rejects(backend.saveSnapshot!(NAME, 'default boot'), (e: PhoneDockError) => e.code === 'bad_request');
  await assert.rejects(backend.restoreSnapshot!(NAME, 'default boot'), (e: PhoneDockError) => e.code === 'bad_request');
  await assert.rejects(backend.deleteSnapshot!(NAME, 'default boot'), (e: PhoneDockError) => e.code === 'bad_request');
  assert.ok(!sdk.log().some((l) => /snapshot (save|load|delete) default_boot/.test(l)));
  await backend.saveSnapshot!(NAME, 'phonedock_sleep');
  assert.ok((await backend.listSnapshots!(NAME)).some((s) => s.name === 'phonedock_sleep'), 'listed');
  const saved = await backend.saveSleep!(NAME);
  await backend.stopAfterSleep!(NAME);
  await backend.wakeFromSleep!(NAME, saved);
  assert.ok(snaps().includes('phonedock_sleep'), 'the wake leaves the person’s snapshot alone');
  await backend.deleteSnapshot!(NAME, 'phonedock_sleep');
});

test('use PhoneDock can’t see keeps it awake: guest input, instrumentation, adb sessions; unknown means awake (#6)', async () => {
  await backend.boot!(NAME, { headless: true });
  const serial = (await backend.runningSerial(NAME))!;
  const ka = (opts = {}) => backend.keepAwake!(NAME, { timeoutSec: 900, guest: true, ...opts } as never);
  assert.equal(await ka(), undefined, 'idle for an hour: nothing keeps it awake');
  sdk.set({ userActivityAgoMs: 60_000 });
  assert.match((await ka()) ?? '', /used/i);
  sdk.set({ userActivityAgoMs: 3_600_000, instrument: true });
  assert.match((await ka()) ?? '', /test/i);
  sdk.set({ instrument: false, shellFails: true });
  assert.match((await ka()) ?? '', /can’t tell/i);
  sdk.set({ shellFails: false });
  // someone's `adb -s <serial> logcat` in a terminal
  const d = mkdtempSync(join(tmpdir(), 'pd-adb-session-')); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'adb'), '#!/bin/sh\nsleep 30\n'); chmodSync(join(d, 'adb'), 0o755);
  // Not this process's child (a terminal's is not the daemon's): started from a shell that exits, so it is re-parented.
  const { execFileSync } = await import('node:child_process');
  const pid = Number(execFileSync('/bin/sh', ['-c', `"${join(d, 'adb')}" -s ${serial} logcat >/dev/null 2>&1 & echo $!`]).toString().trim());
  try {
    await new Promise((r) => setTimeout(r, 3500));   // past the shared `ps` cache
    assert.match((await ka()) ?? '', /adb session/i);
  } finally { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
});

test('two wakes at once: one boots, the other waits for it; nothing touches the disk images of a running emulator', async () => {
  await backend.boot!(NAME, { headless: true });
  const saved = await backend.saveSleep!(NAME);
  await backend.stopAfterSleep!(NAME);
  sdk.set({ bootDelayMs: 1500 });
  const [r1, r2] = await Promise.all([backend.wakeFromSleep!(NAME, saved), backend.wakeFromSleep!(NAME, saved)]);
  assert.equal(r1.resumed, true); assert.equal(r2.resumed, true);
  assert.equal(Object.keys(sdk.state().emulators).length, 1, 'one emulator');
  assert.ok(!existsSync(join(dir, 'phonedock-sleep-recovery')));
});

test('a wake whose boot times out stops that emulator, and only then puts the saved state back', async () => {
  await backend.boot!(NAME, { headless: true });
  const saved = await backend.saveSleep!(NAME);
  await backend.stopAfterSleep!(NAME);
  sdk.set({ bootDelayMs: 60_000 });   // never reachable in time
  await assert.rejects(backend.wakeFromSleep!(NAME, saved, { bootTimeoutMs: 1500 } as never));
  const { execFileSync } = await import('node:child_process');
  const left = execFileSync('/bin/ps', ['-axww', '-o', 'args=']).toString().split('\n').filter((l) => / -avd pdtest-x /.test(l) && /emulator/.test(l));
  assert.deepEqual(left, [], 'no emulator left running');
  assert.ok(snaps().includes('default_boot'), 'the saved state is there');
  sdk.set({ bootDelayMs: 0 });
  assert.equal((await backend.wakeFromSleep!(NAME, saved)).resumed, true);
});

test('enoughDiskForSleep: the guest’s RAM plus a gigabyte', async () => {
  const { enoughDiskForSleep } = await import('./android-emulator.ts');
  const GB = 1024 ** 3;
  assert.equal(enoughDiskForSleep(4 * GB, 3072), true);
  assert.equal(enoughDiskForSleep(4 * GB - 1, 3072), false);
  assert.equal(enoughDiskForSleep(10 * GB, 8192), true);
});

test('adbSessionOn: someone’s adb session on this serial, never PhoneDock’s own live view (also when orphaned)', async () => {
  const { adbSessionOn } = await import('./android-emulator.ts');
  assert.equal(adbSessionOn('/opt/sdk/platform-tools/adb -s emulator-5554 logcat', 'emulator-5554'), 'logcat');
  assert.equal(adbSessionOn('adb -s emulator-5554 shell', 'emulator-5554'), 'shell');
  assert.equal(adbSessionOn('adb -s emulator-5556 shell', 'emulator-5554'), undefined, 'another phone');
  assert.equal(adbSessionOn('/opt/sdk/platform-tools/adb -s emulator-5554 logcat -T 1 -v brief -s ScreenRecord:D PowerManagerService:I', 'emulator-5554'), undefined);
  assert.equal(adbSessionOn('/opt/sdk/platform-tools/adb -s emulator-5554 exec-out screenrecord --output-format=h264 --size 720x1560 --bit-rate 6000000 --time-limit 0 -', 'emulator-5554'), undefined);
});
