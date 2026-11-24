// Test support only: a fake Android SDK (`adb` and `emulator`: one Node script and a JSON state file) that acts like the
// real tools where idle sleep depends on them (measured: emulator 37.3.10, Android 14). A snapshot keeps the guest's
// identity and disk (loading a stale one undoes later writes); `emu kill` saves `default_boot` (unless `exitSave` is
// false); an ordinary boot loads it, rewriting its snapshot.pb, or cold-boots when it is missing or bad.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FakeGuest { bootId: string; uptimeBase: number; startedAt: number }
export interface FakeEmulator { name: string; path: string; pid: number; guest: FakeGuest }
export interface FakeSdkState {
  emulators: Record<string, FakeEmulator>;
  /** Where `emulator -avd NAME` says its AVD lives (`emu avd path`); default $ANDROID_AVD_HOME/NAME.avd. */
  avdPaths: Record<string, string>;
  /** Snapshots that don't load (as if saved by another emulator version). */
  badSnapshots: string[];
  exitSave: boolean;
  ignoreKill: boolean;
  userActivityAgoMs: number;
  instrument: boolean;
  /** The guest's shell doesn't answer at all / only its `ps` fails / only `dumpsys power` says nothing. */
  shellFails: boolean; psFails: boolean; dumpsysFails: boolean;
  /** An instrumentation Android lists as active (`dumpsys activity processes`) / that dump fails alone. */
  activeInstrumentation: boolean; instrFails: boolean;
  /** The guest's `sync` fails / the emulator dies during it / meanwhile another AVD's emulator takes this serial. */
  syncFails: boolean; syncKills?: boolean; syncSwapsTo?: string;
  /** `sys.boot_completed` (false: still booting). */
  bootCompleted: boolean;
  wakefulness: 'Awake' | 'Asleep';
}

const SCRIPT = String.raw`#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const STATE = process.env.FAKE_SDK_STATE || __STATE__;
const LOG = STATE + '.log';
const read = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
const write = (s) => { fs.writeFileSync(STATE + '.tmp' + process.pid, JSON.stringify(s)); fs.renameSync(STATE + '.tmp' + process.pid, STATE); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const argv = process.argv.slice(2);
const tool = path.basename(process.argv[1]);
fs.appendFileSync(LOG, tool + ' ' + argv.join(' ') + '\n');
const uptime = (g) => g.uptimeBase + (Date.now() - g.startedAt) / 1000;
// The guest's disk, with the copy each snapshot keeps of it (the real ones live inside the qcow2 images).
const diskFile = (dir) => path.join(dir, 'userdata-qemu.img.qcow2');
const disk = (dir) => { try { return JSON.parse(fs.readFileSync(diskFile(dir), 'utf8')); } catch { return { files: {}, snaps: {} }; } };
const putDisk = (dir, d) => fs.writeFileSync(diskFile(dir), JSON.stringify(d));
function save(emu, n) {
  const d = disk(emu.path); d.snaps[n] = { ...d.files }; putDisk(emu.path, d);
  const sd = path.join(emu.path, 'snapshots', n); fs.mkdirSync(sd, { recursive: true }); fs.writeFileSync(path.join(sd, 'ram.bin'), Buffer.alloc(4096, 1));
  fs.writeFileSync(path.join(sd, 'snapshot.pb'), JSON.stringify({ bootId: emu.guest.bootId, uptime: uptime(emu.guest) }));
}
function loadable(s, dir, n) {
  if (s.badSnapshots.includes(n)) return undefined;
  try { const j = JSON.parse(fs.readFileSync(path.join(dir, 'snapshots', n, 'snapshot.pb'), 'utf8')); return j.bootId && disk(dir).snaps[n] ? j : undefined; } catch { return undefined; }
}
function load(dir, n, j) {   // the guest and its disk as they were at the save; the emulator rewrites snapshot.pb as it loads
  const d = disk(dir); d.files = { ...d.snaps[n] }; putDisk(dir, d);
  const pb = path.join(dir, 'snapshots', n, 'snapshot.pb'); const t = new Date(); fs.utimesSync(pb, t, t);
  return { bootId: j.bootId, uptimeBase: j.uptime, startedAt: Date.now() };
}
if (tool !== 'adb') {   // emulator (or a renamed copy of it)
  const name = argv[argv.indexOf('-avd') + 1], port = argv.includes('-port') ? argv[argv.indexOf('-port') + 1] : process.env.FAKE_EMU_PORT || '5554';   // no -port: the emulator picks one
  const s = read();
  const dir = s.avdPaths[name] || path.join(process.env.ANDROID_AVD_HOME || '', name + '.avd');
  const snap = argv.includes('-no-snapshot-load') ? undefined : loadable(s, dir, 'default_boot');
  const guest = snap ? load(dir, 'default_boot', snap) : { bootId: crypto.randomUUID(), uptimeBase: 0, startedAt: Date.now() };
  s.emulators['emulator-' + port] = { name, path: dir, pid: process.pid, guest }; write(s);
  process.on('SIGTERM', () => process.exit(0));
  setTimeout(() => process.exit(0), 300_000);   // never outlives a test run by long, even orphaned
} else {
  const s = read();
  for (const [k, e] of Object.entries(s.emulators)) if (!alive(e.pid)) delete s.emulators[k];
  if (argv[0] === 'devices') { console.log('List of devices attached'); for (const k of Object.keys(s.emulators)) console.log(k + '\tdevice product:sdk model:sdk device:emu transport_id:1'); process.exit(0); }
  if (argv[0] === 'start-server' || argv[0] === 'version') process.exit(0);
  const serial = argv[0] === '-s' ? argv[1] : undefined, rest = argv[0] === '-s' ? argv.slice(2) : argv;
  const emu = serial && s.emulators[serial];
  if (!emu) { console.error("error: device '" + serial + "' not found"); process.exit(1); }
  if (rest[0] === 'wait-for-device') process.exit(0);
  if (rest[0] === 'emu') {
    const c = rest.slice(1);
    if (c[0] === 'avd' && c[1] === 'name') { console.log(emu.name + '\nOK'); process.exit(0); }
    if (c[0] === 'avd' && c[1] === 'path') { console.log(emu.path + '\nOK'); process.exit(0); }
    if (c[0] === 'avd' && c[1] === 'snapshot') {
      const op = c[2], n = c[3];
      if (op === 'save') save(emu, n);
      console.log('OK');
      process.exit(0);
    }
    if (c[0] === 'kill') {
      console.log('OK: killing emulator, bye bye');
      if (s.ignoreKill) process.exit(0);
      if (s.exitSave) save(emu, 'default_boot');
      delete s.emulators[serial]; write(s);
      try { process.kill(emu.pid, 'SIGTERM'); } catch {}
      process.exit(0);
    }
    console.log('OK'); process.exit(0);
  }
  if (rest[0] === 'shell') {
    const cmd = rest.slice(1).join(' ');
    if (s.shellFails) { console.error('error: closed'); process.exit(1); }
    if (cmd === 'sync') {
      if (s.syncKills) { try { process.kill(emu.pid, 'SIGKILL'); } catch {} console.error('error: closed'); process.exit(1); }
      if (s.syncFails) { console.error('sync: I/O error'); process.exit(1); }
      if (s.syncSwapsTo) { emu.path = s.syncSwapsTo; write(s); }
      process.exit(0);
    }
    const w = /^echo (\S+) > \/data\/local\/tmp\/(\S+)$/.exec(cmd);
    if (w) { const d = disk(emu.path); d.files[w[2]] = w[1]; putDisk(emu.path, d); process.exit(0); }
    if (/^cat /.test(cmd)) {   // each file in turn, like the real one; a missing one is an error at the end
      const files = disk(emu.path).files, out = cmd.split(/\s+/).slice(1).map((p) => /boot_id$/.test(p) ? emu.guest.bootId : p === '/proc/uptime' ? uptime(emu.guest).toFixed(2) + ' 0.00' : p.startsWith('/data/local/tmp/') ? files[p.slice(16)] : undefined);
      if (out.some((x) => x !== undefined)) console.log(out.filter((x) => x !== undefined).join('\n'));
      process.exit(out.includes(undefined) ? 1 : 0);
    }
    const out = [];
    if (/getprop sys\.boot_completed/.test(cmd)) out.push(s.bootCompleted === false ? '0' : '1');
    if (/dumpsys power/.test(cmd)) {
      if (/mWakefulness/.test(cmd)) out.push('  mWakefulness=' + s.wakefulness);
      if (/lastUserActivityTime/.test(cmd) && !s.dumpsysFails) out.push('  lastUserActivityTime=4242 (' + s.userActivityAgoMs + ' ms ago)');
    }
    // A guest script that reports its ps itself (PhoneDock's check), or a plain "ps | grep" that shows the process.
    if (/ps -A/.test(cmd) && !s.psFails) out.push(/echo "ps ok/.test(cmd) ? 'ps ok ' + (s.instrument ? 1 : 0) : s.instrument ? 'app_process /system/bin com.android.commands.am.Am instrument -w pdtest.app.test/androidx.test.runner.AndroidJUnitRunner' : '');
    if (/dumpsys activity processes/.test(cmd) && !s.instrFails) out.push('instr ok ' + (s.activeInstrumentation ? 1 : 0));
    if (/date \+%s/.test(cmd)) out.push(String(Math.round(Date.now() / 1000)));
    console.log(out.join('\n'));
    process.exit(0);
  }
  process.exit(0);
}
`;

export interface FakeSdk {
  root: string;
  state(): FakeSdkState;
  set(patch: Partial<FakeSdkState>): void;
  /** Every adb/emulator command line run so far, oldest first ("adb -s emulator-5560 emu kill"). */
  log(): string[];
  clearLog(): void;
  /** Stop every fake emulator this SDK started (also orphaned ones). */
  killAll(): void;
}

/** A fresh fake SDK; points ANDROID_HOME and ANDROID_SDK_ROOT at it. */
export function fakeAndroidSdk(initial: Partial<FakeSdkState> = {}): FakeSdk {
  const root = mkdtempSync(join(tmpdir(), 'pd-fake-sdk-'));
  const statePath = join(root, 'state.json');
  const st: FakeSdkState = { emulators: {}, avdPaths: {}, badSnapshots: [], exitSave: true, ignoreKill: false, userActivityAgoMs: 3_600_000, instrument: false, shellFails: false, psFails: false, dumpsysFails: false, activeInstrumentation: false, instrFails: false, syncFails: false, bootCompleted: true, wakefulness: 'Awake', ...initial };
  writeFileSync(statePath, JSON.stringify(st));
  writeFileSync(statePath + '.log', '');
  const script = SCRIPT.replace('__STATE__', JSON.stringify(statePath));
  for (const [dir, file] of [['platform-tools', 'adb'], ['emulator', 'emulator']]) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, file), script);
    chmodSync(join(root, dir, file), 0o755);
  }
  process.env.ANDROID_HOME = root; process.env.ANDROID_SDK_ROOT = root;
  const read = (): FakeSdkState => JSON.parse(readFileSync(statePath, 'utf8'));
  return {
    root,
    state: read,
    set(patch) { writeFileSync(statePath, JSON.stringify({ ...read(), ...patch })); },
    log: () => readFileSync(statePath + '.log', 'utf8').split('\n').filter(Boolean),
    clearLog: () => writeFileSync(statePath + '.log', ''),
    killAll() { try { execFileSync('/usr/bin/pkill', ['-f', join(root, 'emulator')]); } catch { /* none left */ } },
  };
}

/** A PhoneDock-managed AVD on disk (as `phonedock create` writes it), under $PHONEDOCK_HOME/avd. */
export function fakeManagedAvd(home: string, name: string, ramMB = 2048): string {
  const avdHome = join(home, 'avd'); const dir = join(avdHome, `${name}.avd`);
  mkdirSync(join(dir, 'snapshots'), { recursive: true });
  writeFileSync(join(avdHome, `${name}.ini`), `avd.ini.encoding=UTF-8\npath=${dir}\ntarget=android-34\n`);
  writeFileSync(join(dir, 'config.ini'), `hw.ramSize=${ramMB}\nhw.lcd.width=1080\nhw.lcd.height=2340\nimage.sysdir.1=system-images/android-34/google_apis_playstore/arm64-v8a/\n`);
  writeFileSync(join(dir, 'phonedock.json'), JSON.stringify({ vulkan: false }));
  writeFileSync(join(dir, 'userdata-qemu.img.qcow2'), JSON.stringify({ files: {}, snaps: {} }));   // its disk
  return dir;
}
