// Test support only (never imported by PhoneDock itself): a fake Android SDK whose `adb` and `emulator` are one small
// Node script driven by a JSON state file, so the emulator backend's real code runs against it. It behaves like the
// real tools where idle sleep depends on them (measured on emulator 35.x, Android 14):
//  - a snapshot keeps the guest's identity (kernel boot id, uptime, the token PhoneDock writes before it sleeps);
//  - `emu kill` saves `default_boot` on the way out (the quick-boot exit save) unless `exitSave` is false;
//  - a snapshot is two halves: its folder (RAM) and an entry in each of the AVD's qcow2 disk images; deleting it (also
//    when a load fails) removes both;
//  - a quick boot resumes `default_boot`; with `-force-snapshot-load` a missing or bad one makes the emulator delete it
//    and exit, as the real one does;
//  - `dumpsys power` reports the last user activity as "(N ms ago)".
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FakeGuest { bootId: string; uptimeBase: number; startedAt: number; token?: string }
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
  shellFails: boolean;
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
const snapDir = (emu, n) => path.join(emu.path, 'snapshots', n);
const qcows = (dir) => { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.qcow2')).map((f) => path.join(dir, f)); } catch { return []; } };
const disk = (dir, n, on) => { for (const q of qcows(dir)) { const l = fs.readFileSync(q, 'utf8').split('\n').filter((x) => x && x !== 'snap:' + n); if (on) l.push('snap:' + n); fs.writeFileSync(q, l.join('\n') + '\n'); } };
const onDisk = (dir, n) => qcows(dir).every((q) => fs.readFileSync(q, 'utf8').split('\n').includes('snap:' + n));
const drop = (dir, n) => { fs.rmSync(path.join(dir, 'snapshots', n), { recursive: true, force: true }); disk(dir, n, false); };
function save(s, emu, n) {
  disk(emu.path, n, true);
  const d = snapDir(emu, n); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'snapshot.pb'), JSON.stringify({ bootId: emu.guest.bootId, uptime: uptime(emu.guest), token: emu.guest.token }));
  fs.writeFileSync(path.join(d, 'ram.bin'), Buffer.alloc(4096, 1));
}
function loadable(s, dir, n) {
  if (s.badSnapshots.includes(n) || !onDisk(dir, n)) return undefined;
  try { const j = JSON.parse(fs.readFileSync(path.join(dir, 'snapshots', n, 'snapshot.pb'), 'utf8')); return j.bootId ? j : undefined; } catch { return undefined; }
}
if (tool !== 'adb') {   // emulator (or a renamed copy of it)
  const name = argv[argv.indexOf('-avd') + 1], port = argv[argv.indexOf('-port') + 1];
  const s = read();
  const dir = s.avdPaths[name] || path.join(process.env.ANDROID_AVD_HOME || '', name + '.avd');
  let snap = argv.includes('-no-snapshot-load') ? undefined : loadable(s, dir, 'default_boot');
  if (!snap && !argv.includes('-no-snapshot-load') && fs.existsSync(path.join(dir, 'snapshots', 'default_boot'))) {
    drop(dir, 'default_boot');   // the real one deletes it, disk half included
    if (argv.includes('-force-snapshot-load')) { console.log('Failed to load snapshot; Emulator will delete existing snapshot and exit.'); process.exit(0); }
  } else if (!snap && argv.includes('-force-snapshot-load')) { console.log('Failed to load snapshot'); process.exit(0); }
  const guest = snap ? { bootId: snap.bootId, uptimeBase: snap.uptime, startedAt: Date.now(), token: snap.token } : { bootId: crypto.randomUUID(), uptimeBase: 0, startedAt: Date.now() };
  s.emulators['emulator-' + port] = { name, path: dir, pid: process.pid, guest };
  write(s);
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1 << 30);
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
      if (op === 'save') { save(s, emu, n); console.log('OK'); }
      else if (op === 'load') { const j = loadable(s, emu.path, n); if (!j) { console.log('KO: snapshot not found'); process.exit(0); } emu.guest = { bootId: j.bootId, uptimeBase: j.uptime, startedAt: Date.now(), token: j.token }; write(s); console.log('OK'); }
      else if (op === 'delete') { drop(emu.path, n); console.log('OK'); }
      process.exit(0);
    }
    if (c[0] === 'kill') {
      console.log('OK: killing emulator, bye bye');
      if (s.ignoreKill) process.exit(0);
      if (s.exitSave) save(s, emu, 'default_boot');
      delete s.emulators[serial]; write(s);
      try { process.kill(emu.pid, 'SIGTERM'); } catch {}
      process.exit(0);
    }
    console.log('OK'); process.exit(0);
  }
  if (rest[0] === 'shell' || rest[0] === 'exec-out') {
    const cmd = rest.slice(1).join(' ');
    if (s.shellFails) { console.error('error: closed'); process.exit(1); }
    const m = /echo (\S+) > \/data\/local\/tmp\/\.phonedock-sleep/.exec(cmd);
    if (m) { emu.guest.token = m[1]; write(s); }
    const out = [];
    if (/boot_id/.test(cmd)) out.push(emu.guest.bootId);
    if (/\/proc\/uptime/.test(cmd)) out.push(uptime(emu.guest).toFixed(2) + ' 0.00');
    if (/cat[^;|]*\.phonedock-sleep/.test(cmd)) out.push(emu.guest.token || '');
    if (/getprop sys\.boot_completed/.test(cmd)) out.push('1');
    if (/dumpsys power/.test(cmd)) out.push('  mWakefulness=' + s.wakefulness, '  lastUserActivityTime=4242 (' + s.userActivityAgoMs + ' ms ago)');
    if (/ps -A/.test(cmd) && s.instrument) out.push('app_process /system/bin com.android.commands.am.Am instrument -w pdtest.app.test/androidx.test.runner.AndroidJUnitRunner');
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
}

/** A fresh fake SDK; points ANDROID_HOME and ANDROID_SDK_ROOT at it. */
export function fakeAndroidSdk(initial: Partial<FakeSdkState> = {}): FakeSdk {
  const root = mkdtempSync(join(tmpdir(), 'pd-fake-sdk-'));
  const statePath = join(root, 'state.json');
  const st: FakeSdkState = { emulators: {}, avdPaths: {}, badSnapshots: [], exitSave: true, ignoreKill: false, userActivityAgoMs: 3_600_000, instrument: false, shellFails: false, wakefulness: 'Awake', ...initial };
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
  };
}

/** A PhoneDock-managed AVD on disk (as `phonedock create` writes it), under $PHONEDOCK_HOME/avd. */
export function fakeManagedAvd(home: string, name: string, ramMB = 2048): string {
  const avdHome = join(home, 'avd'); const dir = join(avdHome, `${name}.avd`);
  mkdirSync(join(dir, 'snapshots'), { recursive: true });
  writeFileSync(join(avdHome, `${name}.ini`), `avd.ini.encoding=UTF-8\npath=${dir}\ntarget=android-34\n`);
  writeFileSync(join(dir, 'config.ini'), `hw.ramSize=${ramMB}\nhw.lcd.width=1080\nhw.lcd.height=2340\nimage.sysdir.1=system-images/android-34/google_apis_playstore/arm64-v8a/\n`);
  writeFileSync(join(dir, 'phonedock.json'), JSON.stringify({ vulkan: false }));
  for (const q of ['userdata-qemu.img.qcow2', 'cache.img.qcow2']) writeFileSync(join(dir, q), '');   // the disk images
  return dir;
}
