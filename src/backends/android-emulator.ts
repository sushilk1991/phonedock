// Android Emulator backend. Managed AVDs live in ANDROID_AVD_HOME=stateDir('avd'), isolated from the
// user's ~/.android/avd (those are listed read-only as managed=false and never modified).
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, statfsSync, writeFileSync, closeSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { run, sleep } from '../core/exec.ts';
import { stateDir, toolEnv, which } from '../core/paths.ts';
import {
  PhoneDockError,
  type Availability, type Backend, type BootOptions, type Device, type DeviceSpec, type DeviceState,
  type HardwareProfile, type OsImage, type ScreenInfo, type SleepState, type Snapshot, type VideoPacket, type VideoStream,
  type WakeReport,
} from '../core/types.ts';
import * as A from './android-common.ts';
import * as T from './android-trace.ts';
import * as C from './android-clipboard.ts';
import { adbFrameStream, adbVideoStream } from './android-video.ts';
import { DEVICE_PROFILES, deviceProfileById } from '../core/device-profiles.ts';
import {
  clonePersistedDisguise, disguiseDeviceMeta, parseDisguiseOption, prepareDisguiseRamdisk, resolveDisguiseCreation,
  type PersistedDisguise, type PrepareDisguiseDeps,
} from './android-disguise.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

/** Host-side capture via the emulator console (`screenrecord screenshot`): reads the emulator's own
 *  framebuffer instead of running screencap inside the guest — measured 0.2–0.5s vs 3–6s under load.
 *  Falls back to in-guest screencap if the console path fails. */
async function emulatorScreenshot(serial: string): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'pd-emushot-'));
  try {
    // The console grabs the panel framebuffer in its *natural* orientation; when the display is rotated that no
    // longer matches the coordinate space of `input` (and the contract), so use in-guest screencap then.
    const [r, rot] = await Promise.all([
      run(A.adbPath(), ['-s', serial, 'emu', 'screenrecord', 'screenshot', dir], { env: toolEnv(), allowFail: true, timeoutMs: 10_000 }),
      // the window manager's rotation (A.displayRotation); unknown counts as turned, so screencap is used
      A.displayRotation(serial).then((g) => g.rotation, () => -1),
    ]);
    const f = readdirSync(dir).find((n) => n.endsWith('.png'));
    if (r.code === 0 && f && rot === 0) { const buf = readFileSync(join(dir, f)); if (A.pngSize(buf)) { A.noteScreenshot(serial, buf); return buf; } }
  } catch { /* fall through */ } finally { rmSync(dir, { recursive: true, force: true }); }
  return A.screenshot(serial);
}

/** Two-finger pinch through the emulator console: raw multi-touch (MT protocol B) events go straight to the guest's
 *  virtio multi-touch screen (/dev/input/event1, ABS range 0..32767), which `input` cannot do (no pointer ids) and
 *  `sendevent` cannot either (SELinux denies the shell uid). ~10 ms per `adb emu event send`. Verified: Google Maps
 *  zooms in (scale 4) and out. Coordinates are screenshot pixels; rotated displays are mapped back to the panel. */
let mtTracking = 4000;
async function emulatorPinch(serial: string, x: number, y: number, scale: number, durationMs: number): Promise<void> {
  if (![x, y, scale].every(Number.isFinite) || scale <= 0) throw new PhoneDockError('The pinch coordinates or scale are invalid', 'bad_request', 400, undefined, 'pinch needs finite x, y and scale > 0');
  const g = await A.displayRotation(serial);
  const { width: W, height: H, rotation } = g;
  if (x < 0 || y < 0 || x >= W || y >= H) throw new PhoneDockError(`(${x}, ${y}) is outside the ${W}x${H} screen`, 'bad_request', 400);
  // Fingers move along whichever axis has more room around the centre.
  const roomX = Math.min(x, W - 1 - x), roomY = Math.min(y, H - 1 - y);
  const horizontal = roomX >= roomY;
  const maxHalf = Math.min((horizontal ? roomX : roomY) - 8, Math.min(W, H) * 0.45);
  const minHalf = Math.max(30, Math.min(W, H) * 0.03);
  if (maxHalf <= minHalf) throw new PhoneDockError('pinch centre is too close to the screen edge', 'bad_request', 400);
  let h0: number, h1: number;
  if (scale >= 1) { h1 = maxHalf; h0 = Math.max(minHalf, h1 / scale); } else { h0 = maxHalf; h1 = Math.max(minHalf, h0 * scale); }
  const W0 = rotation % 2 ? H : W, H0 = rotation % 2 ? W : H;       // natural (rotation 0) panel size
  const toRaw = (px: number, py: number): [number, number] => {
    let nx = px, ny = py;                                             // inverse of InputReader's display rotation
    if (rotation === 1) { nx = W0 - py; ny = px; } else if (rotation === 2) { nx = W0 - px; ny = H0 - py; } else if (rotation === 3) { nx = py; ny = H0 - px; }
    const c = (v: number) => Math.max(0, Math.min(32767, Math.round(v)));
    return [c((nx * 32768) / W0), c((ny * 32768) / H0)];
  };
  const pts = (half: number): [[number, number], [number, number]] => horizontal
    ? [toRaw(x - half, y), toRaw(x + half, y)] : [toRaw(x, y - half), toRaw(x, y + half)];
  const send = (evs: string[]) => A.adb(serial, ['emu', 'event', 'send', ...evs], { timeoutMs: 5000, allowFail: true });
  const pos = (slot: number, p: [number, number]) => [`EV_ABS:ABS_MT_SLOT:${slot}`, `EV_ABS:ABS_MT_POSITION_X:${p[0]}`, `EV_ABS:ABS_MT_POSITION_Y:${p[1]}`];
  const id0 = ++mtTracking, id1 = ++mtTracking; if (mtTracking > 60000) mtTracking = 4000;
  const [a0, b0] = pts(h0);
  const ms = Math.max(150, Math.min(durationMs || 400, 5000));
  const steps = Math.max(6, Math.min(60, Math.round(ms / 16)));
  const t0 = Date.now();
  try {
    const r = await send([
      'EV_ABS:ABS_MT_SLOT:0', `EV_ABS:ABS_MT_TRACKING_ID:${id0}`, 'EV_ABS:ABS_MT_TOUCH_MAJOR:8', 'EV_ABS:ABS_MT_PRESSURE:512', ...pos(0, a0).slice(1),
      'EV_ABS:ABS_MT_SLOT:1', `EV_ABS:ABS_MT_TRACKING_ID:${id1}`, 'EV_ABS:ABS_MT_TOUCH_MAJOR:8', 'EV_ABS:ABS_MT_PRESSURE:512', ...pos(1, b0).slice(1),
      'EV_SYN:0:0']);
    if (!/OK/.test(r.stdout)) throw new PhoneDockError("Couldn’t send the touch events", 'input_failed', 500, undefined, `emulator console rejected the touch events: ${r.stdout.trim()}`);
    for (let i = 1; i <= steps; i++) {
      const due = t0 + (ms * i) / steps;
      const wait = due - Date.now(); if (wait > 0) await sleep(wait);
      const [a, b] = pts(h0 + ((h1 - h0) * i) / steps);
      await send([...pos(0, a), ...pos(1, b), 'EV_SYN:0:0']);
    }
    await sleep(40);   // hold briefly so the last MOVE is not merged into the lift (no fling)
  } finally {
    // always lift both fingers (lifting an inactive slot is a no-op for evdev)
    await send(['EV_ABS:ABS_MT_SLOT:0', 'EV_ABS:ABS_MT_TRACKING_ID:-1', 'EV_ABS:ABS_MT_SLOT:1', 'EV_ABS:ABS_MT_TRACKING_ID:-1', 'EV_SYN:0:0']);
  }
}

const ID = 'android-emulator';
const managedHome = () => stateDir('avd');
const userHome = () => process.env.ANDROID_AVD_HOME_USER ?? join(homedir(), '.android', 'avd');

const BASE_PROFILES: HardwareProfile[] = [
  { id: 'pixel_9', name: 'Pixel 9', width: 1080, height: 2424, dpi: 420, ramMB: 4096 },
  { id: 'pixel_9_pro_xl', name: 'Pixel 9 Pro XL', width: 1344, height: 2992, dpi: 480, ramMB: 4096 },
  { id: 'pixel_8a', name: 'Pixel 8a', width: 1080, height: 2400, dpi: 420, ramMB: 4096 },
  { id: 'small_phone', name: 'Small phone', width: 720, height: 1280, dpi: 320, ramMB: 2048 },
  { id: 'pixel_tablet', name: 'Pixel Tablet', width: 2560, height: 1600, dpi: 320, ramMB: 4096 },
  { id: 'pixel_fold', name: 'Pixel Fold (inner)', width: 1840, height: 2208, dpi: 420, ramMB: 4096 },
];

const PROFILES: HardwareProfile[] = [
  ...BASE_PROFILES,
  ...DEVICE_PROFILES
    .filter((p) => !BASE_PROFILES.some((b) => b.id === p.id))
    .map((p): HardwareProfile => ({ id: p.id, name: p.name, width: p.screen.width, height: p.screen.height, dpi: p.screen.dpi, ramMB: p.ramMB })),
];

export function isPersistedDisguise(v: unknown): v is PersistedDisguise {
  if (!v || typeof v !== 'object') return false;
  const d = v as Partial<PersistedDisguise>;
  return d.v === 1 && typeof d.profile === 'string' && !!d.identity && typeof d.identity === 'object' && typeof d.identity.serial === 'string';
}

export function imageIdFromSysdir(sysdir: string | undefined): string | undefined {
  if (!sysdir) return undefined;
  const parts = sysdir.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length !== 4 || parts[0] !== 'system-images') return undefined;
  return parts.join(';');
}

/** Pick an installed arm64 image matching `sdk`, strongly preferring Google Play Store images for disguised virtual phones. */
export function chooseDisguiseImage(sdk: number, installed: OsImage[]): string {
  const matching = installed.filter((i) => {
    if (!i.installed || !i.id.endsWith(';arm64-v8a')) return false;
    const api = parseInt((i.version ?? '').split('.')[0], 10);
    if (Number.isInteger(api) && api === sdk) return true;
    return i.id.startsWith(`system-images;android-${sdk};`);
  });
  matching.sort((a, b) => {
    const rank = (id: string) => (id.includes(';google_apis_playstore;') ? 0 : id.includes(';google_apis;') ? 1 : 2);
    return rank(a.id) - rank(b.id) || a.id.localeCompare(b.id);
  });
  if (!matching.length) {
    const suggested = `system-images;android-${sdk};google_apis_playstore;arm64-v8a`;
    throw new PhoneDockError(
      `No Android API ${sdk} arm64 system image is installed for this virtual phone profile`,
      'no_image',
      400,
      [`Install ${suggested} first.`],
      `Install one: POST /v1/backends/android-emulator/images/install {"image":"${suggested}"}`,
    );
  }
  return matching[0].id;
}

const API_TO_ANDROID: Record<string, string> = {
  '37': '17', '36': '16', '35': '15', '34': '14', '33': '13', '32': '12L', '31': '12', '30': '11', '29': '10', '28': '9', '27': '8.1', '26': '8.0', '25': '7.1', '24': '7.0', '23': '6.0', '22': '5.1', '21': '5.0',
};

function readIni(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const i = line.indexOf('='); if (i <= 0 || line.startsWith('#')) continue;
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  } catch { /* missing */ }
  return out;
}
function writeIni(path: string, kv: Record<string, string>) {
  writeFileSync(path, Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
}
export function sanitizeName(n: string): string {
  const s = n.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '').slice(0, 80);
  if (!s) throw new PhoneDockError('Invalid device name', 'bad_request', 400, ['Use letters, digits, periods, underscores, or hyphens.']);
  return s;
}

export interface AvdEntry { name: string; home: string; avdDir: string; config: Record<string, string>; managed: boolean; meta?: Record<string, unknown> }

function scanAvds(home: string, managed: boolean): AvdEntry[] {
  if (!existsSync(home)) return [];
  const out: AvdEntry[] = [];
  for (const f of readdirSync(home)) {
    if (!f.endsWith('.ini')) continue;
    const name = f.slice(0, -4);
    const ini = readIni(join(home, f));
    const avdDir = ini.path && existsSync(ini.path) ? ini.path : join(home, `${name}.avd`);
    if (!existsSync(avdDir)) continue;
    let meta: Record<string, unknown> | undefined;
    try { meta = JSON.parse(readFileSync(join(avdDir, 'phonedock.json'), 'utf8')); } catch { /* none */ }
    out.push({ name, home, avdDir, config: readIni(join(avdDir, 'config.ini')), managed, meta });
  }
  return out;
}
function findAvd(name: string): AvdEntry | undefined {
  return scanAvds(managedHome(), true).find((a) => a.name === name) ?? scanAvds(userHome(), false).find((a) => a.name === name);
}
function requireAvd(name: string): AvdEntry {
  const a = findAvd(name);
  if (!a) throw new PhoneDockError(`No emulator named "${name}" was found.`, 'not_found', 404);
  return a;
}

/** Chrome's first-run screens (welcome, sign-in, notifications) stand between every open_url and the page on a fresh
 *  emulator (blind run 7). Chrome reads its flags from /data/local/tmp/chrome-command-line at start on debuggable
 *  builds (the Google APIs emulator images), so preset that file to skip them, and grant Chrome's notification
 *  permission so its "Chrome notifications make things easier" sheet doesn't cover the page either. Called only for
 *  emulators PhoneDock created, once (an existing file, e.g. someone's own flags, is left alone). */
export const CHROME_FLAGS_FILE = '/data/local/tmp/chrome-command-line';
export const CHROME_FLAGS = '_ --disable-fre --no-default-browser-check --no-first-run';
async function presetChrome(serial: string): Promise<void> {
  await A.adb(serial, ['shell', `[ -e ${CHROME_FLAGS_FILE} ] || { echo '${CHROME_FLAGS}' > ${CHROME_FLAGS_FILE}; pm grant com.android.chrome android.permission.POST_NOTIFICATIONS 2>/dev/null; }`],
    { allowFail: true, timeoutMs: 15_000 });
}

// ── running emulator discovery ──────────────────────────────────────────────
const serialCache = new Map<string, { name: string; path: string; at: number }>();
interface Running { serial: string; state: string; name: string; path: string }
let discovery: { at: number; list: Promise<Running[]> } | undefined;
/** The running emulators and the AVD each one runs. `fresh`: asked of each emulator now, never from the 60 s cache (a
 *  console port can be taken over by another emulator meanwhile): for what idle sleep does to a phone. `shared`: one
 *  discovery for 2 s, for the sweep's cheap checks of many phones (never for a command: a phone that just started or
 *  stopped would read wrong). */
function runningEmulators(mode: 'fresh' | 'shared' | 'normal' = 'normal'): Promise<Running[]> {
  if (mode === 'shared' && discovery && Date.now() - discovery.at < 2000) return discovery.list;
  const list = discover(mode === 'fresh');
  if (mode === 'shared') { discovery = { at: Date.now(), list }; list.catch(() => { if (discovery?.list === list) discovery = undefined; }); }
  return list;
}
async function discover(fresh: boolean): Promise<Running[]> {
  const devs = (await A.adbDevices()).filter((d) => /^emulator-\d+$/.test(d.serial));
  const live = new Set(devs.map((d) => d.serial));
  for (const k of serialCache.keys()) if (!live.has(k)) serialCache.delete(k);
  return Promise.all(devs.map(async (d) => {
    let c = fresh ? undefined : serialCache.get(d.serial);
    if (!c || Date.now() - c.at > 60_000) {
      const [n, p] = await Promise.all([
        A.adb(d.serial, ['emu', 'avd', 'name'], { allowFail: true, timeoutMs: 5000 }),
        A.adb(d.serial, ['emu', 'avd', 'path'], { allowFail: true, timeoutMs: 5000 }),
      ]);
      const name = n.stdout.split('\n')[0].trim(); const path = p.stdout.split('\n')[0].trim();
      // An unknown path (the console didn't answer) is asked again next time, not remembered.
      if (name && name !== 'KO' && path && path !== 'KO') { c = { name, path, at: Date.now() }; serialCache.set(d.serial, c); }
      else return { serial: d.serial, state: d.state, name: name === 'KO' ? '' : name, path: '' };
    }
    return { serial: d.serial, state: d.state, name: c?.name ?? '', path: c?.path ?? '' };
  }));
}
const canonical = (p: string) => { try { return realpathSync(p); } catch { return resolve(p).replace(/\/+$/, ''); } };
/** The running emulator of this AVD: the one whose `emu avd path` is the AVD's folder. A same-named emulator of another
 *  AVD (Android Studio's) is not it. One whose path is unknown (its console didn't answer) matches by name, except
 *  `strict`: what idle sleep does to a phone (save, stop, wake) needs a positive match. Inventory and every command
 *  use this one matcher, so they can't disagree. */
export function runningFor<R extends { name: string; path: string }>(running: R[], a: { name: string; avdDir: string }, strict = false): R | undefined {
  const dir = canonical(a.avdDir);
  return running.find((r) => r.path && canonical(r.path) === dir) ?? (strict ? undefined : running.find((r) => r.name === a.name && !r.path));
}
async function serialFor(name: string, mode: 'shared' | 'normal' = 'normal'): Promise<string | undefined> {
  const a = findAvd(name);
  const running = await runningEmulators(mode);
  if (!a) return running.find((e) => e.name === name)?.serial;
  return runningFor(running, a)?.serial;
}
/** PhoneDock's own AVD: created by it (`spec` in its phonedock.json, which only create and clone write) in its own folder
 *  (`<home>/<name>.avd`; an .ini there may point at an AVD elsewhere, e.g. Android Studio's). Idle sleep acts on no other. */
const ownAvd = (a: AvdEntry) => !!a.meta && typeof a.meta.spec === 'object' && a.meta.spec !== null
  && canonical(a.avdDir) === canonical(join(managedHome(), `${a.name}.avd`));
/** A managed AVD (PhoneDock's own) by name, never a same-named one of the person's: idle sleep acts only on these. */
function requireManagedAvd(name: string): AvdEntry {
  const a = scanAvds(managedHome(), true).find((x) => x.name === name);
  if (!a) throw new PhoneDockError(`PhoneDock has no emulator named "${name}"`, 'not_found', 404, ['It may have been deleted outside PhoneDock.'], `No AVD "${name}" in ${managedHome()}`);
  if (!ownAvd(a)) throw new PhoneDockError(`PhoneDock didn’t create "${name}" in its own folder`, 'not_found', 404, ['Idle sleep acts only on emulators PhoneDock created.'],
    `${a.avdDir}: no spec in its phonedock.json, or not ${join(managedHome(), `${name}.avd`)}`);
  return a;
}
/** The serial of the emulator running this managed AVD, matched by its path, asked of the emulators now. */
async function managedSerial(name: string): Promise<string | undefined> {
  return runningFor(await runningEmulators('fresh'), requireManagedAvd(name), true)?.serial;
}
/** The emulator positively running this AVD (its `emu avd path`), for a console command that changes it (snapshot save,
 *  load or delete; the stop): never a same-named one whose path can't be read, which may be the person's own (and a
 *  sleeping phone's id names no running emulator at all). undefined: none runs. */
async function consoleSerial(name: string): Promise<string | undefined> {
  const a = requireAvd(name);
  const running = await runningEmulators('fresh');
  const r = runningFor(running, a, true);
  if (r) return r.serial;
  if (runningFor(running, a)) {
    throw new PhoneDockError(`PhoneDock can’t tell whether the running emulator named "${name}" is this phone`, 'ambiguous_device', 409,
      ['Nothing was sent. Try again in a few seconds; if it lasts, quit the other emulator of that name.'], `An emulator named ${name} runs, and its console doesn't say which AVD it runs`, 'not_sent');
  }
  return undefined;
}
async function requireSerial(name: string): Promise<string> {
  const s = await serialFor(name);
  if (!s && !findAvd(name)) throw new PhoneDockError('Couldn’t find the device', 'not_found', 404, ['Check the list of available devices.'], `No emulator (AVD) named ${JSON.stringify(name)}\nGET /v1/devices lists known devices`);
  if (!s) throw new PhoneDockError(`Emulator "${name}" is not running`, 'not_running', 409, ['Start the emulator first.'], 'Boot it first: POST /v1/devices/:id/boot');
  return s;
}

const booting = new Map<string, number>(); // name → started at
const children = new Map<string, ChildProcess>();
const reservedPorts = new Set<number>();

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}
async function pickPort(): Promise<number> {
  const used = new Set((await A.adbDevices()).map((d) => /^emulator-(\d+)$/.exec(d.serial)?.[1]).filter(Boolean).map(Number));
  for (let p = 5554; p <= 5680; p += 2) {
    if (used.has(p) || reservedPorts.has(p)) continue;
    if (await portFree(p) && await portFree(p + 1)) return p;
  }
  throw new PhoneDockError("No emulator connection is available", 'no_port', 503, undefined, 'No free emulator console port in 5554–5680');
}

function emulatorBin(): string {
  const p = join(A.sdkRoot(), 'emulator', 'emulator');
  if (!existsSync(p)) throw new PhoneDockError('Android emulator not installed', 'emulator_missing', 501, ['Install the Android emulator.'], 'sdkmanager "emulator"');
  return p;
}
function sdkmanagerBin(): string | undefined {
  const s = A.sdkRoot();
  for (const p of [join(s, 'cmdline-tools', 'latest', 'bin', 'sdkmanager'), which('sdkmanager')]) if (p && existsSync(p)) return p;
  try { for (const d of readdirSync(join(s, 'cmdline-tools'))) { const p = join(s, 'cmdline-tools', d, 'bin', 'sdkmanager'); if (existsSync(p)) return p; } } catch { /* */ }
  return undefined;
}

export function toDevice(a: AvdEntry, run: Running | undefined): Device {
  const c = a.config;
  const api = (c.target ?? '').replace(/^android-/, '') || /android-([\w.]+)/.exec(c['image.sysdir.1'] ?? '')?.[1] || '';
  let state: DeviceState = 'stopped';
  if (run) state = run.state === 'device' ? (booting.has(a.name) ? 'booting' : 'running') : 'booting';
  else if (booting.has(a.name)) state = 'booting';
  const width = +c['hw.lcd.width'] || undefined, height = +c['hw.lcd.height'] || undefined;
  const spec = (a.meta?.spec as Partial<DeviceSpec> | undefined) ?? undefined;
  const disguise = isPersistedDisguise(a.meta?.disguise) ? a.meta.disguise : undefined;
  const disguisedModel = disguise ? deviceProfileById(disguise.profile)?.model : undefined;
  return {
    id: `${ID}:${a.name}`, backend: ID, nativeId: a.name, name: (a.meta?.displayName as string) ?? c['avd.ini.displayname'] ?? a.name,
    platform: 'android', kind: 'virtual', state, managed: a.managed,
    osVersion: api ? `Android ${API_TO_ANDROID[api.split('.')[0]] ?? '?'} (API ${api})` : undefined,
    model: disguisedModel ?? c['hw.device.name'] ?? undefined, connection: 'local',
    // running: the screen as it is turned now (follows rotation); otherwise the panel from the AVD config
    screen: (state === 'running' && run ? A.knownScreen(run.serial) : undefined)
      ?? (width && height ? { width, height, scale: 1, density: +c['hw.lcd.density'] || undefined, orientation: A.orientationOf(width, height) } : undefined),
    spec: spec ?? { backend: ID, name: a.name, cpus: +c['hw.cpu.ncore'] || undefined, ramMB: parseRam(c['hw.ramSize']), width, height, dpi: +c['hw.lcd.density'] || undefined },
    capabilities: [...backend.capabilities],
    meta: {
      avdHome: a.home, avdDir: a.avdDir, image: c['image.sysdir.1'], tag: c['tag.id'], abi: c['abi.type'],
      ...(run ? { serial: run.serial, consolePort: +run.serial.split('-')[1] } : {}),
      ...(children.get(a.name)?.pid ? { pid: children.get(a.name)!.pid } : {}),
      ...(disguise ? { disguise: disguiseDeviceMeta(disguise) } : {}),
    },
  };
}
function parseRam(v?: string): number | undefined {
  if (!v) return undefined;
  const m = /^(\d+)\s*([MG]?)/i.exec(v); if (!m) return undefined;
  return m[2].toUpperCase() === 'G' ? +m[1] * 1024 : +m[1];
}

// ── images ───────────────────────────────────────────────────────────────────
function imageName(api: string, tagDisplay: string, abi: string): string {
  const major = api.split('.')[0];
  return `Android ${API_TO_ANDROID[major] ?? '?'} (API ${api}) · ${tagDisplay} · ${abi.replace('-v8a', '').replace('arm64', 'arm64')}`;
}
function installedImages(): OsImage[] {
  const root = join(A.sdkRoot(), 'system-images');
  const out: OsImage[] = [];
  if (!existsSync(root)) return out;
  for (const plat of readdirSync(root)) for (const tag of safeLs(join(root, plat))) for (const abi of safeLs(join(root, plat, tag))) {
    const dir = join(root, plat, tag, abi);
    const sp = readIni(join(dir, 'source.properties'));
    if (!sp['SystemImage.Abi'] && !existsSync(join(dir, 'system.img'))) continue;
    const api = sp['AndroidVersion.ApiLevel'] ?? plat.replace('android-', '');
    out.push({
      id: `system-images;${plat};${tag};${abi}`, backend: ID, platform: 'android',
      name: imageName(api, sp['SystemImage.TagDisplay'] ?? tag, abi), version: api, installed: true,
      notes: sp['Pkg.Desc'],
    });
  }
  return out;
}
function safeLs(p: string): string[] { try { return readdirSync(p).filter((f) => statSync(join(p, f)).isDirectory()); } catch { return []; } }

let remoteCache: { at: number; images: OsImage[] } | undefined;
async function remoteImages(): Promise<OsImage[]> {
  if (remoteCache && Date.now() - remoteCache.at < 600_000) return remoteCache.images;
  const sm = sdkmanagerBin(); if (!sm) return [];
  const r = await run(sm, ['--list', `--sdk_root=${A.sdkRoot()}`], { env: toolEnv(), allowFail: true, timeoutMs: 90_000 });
  const images: OsImage[] = [];
  let section = '';
  for (const line of r.stdout.split('\n')) {
    if (/^Available Packages:/.test(line)) section = 'avail';
    else if (/^Installed packages:/i.test(line)) section = 'inst';
    else if (/^Available Updates:/.test(line)) section = 'upd';
    if (section !== 'avail') continue;
    const m = /^\s*(system-images;android-([\w.-]+);([\w-]+);(arm64-v8a))\s*\|\s*([^|]*)\|\s*(.*)$/.exec(line);
    if (!m) continue;
    const api = m[2].replace(/-ext\d+$/, '');
    images.push({ id: m[1], backend: ID, platform: 'android', name: imageName(api, m[6].replace(/ARM 64 v8a System Image/i, '').replace(/\bARM64-V8a\s*/i, '').trim() || m[3], m[4]), version: api, installed: false, notes: m[6].trim() });
  }
  remoteCache = { at: Date.now(), images };
  return images;
}

function imageDirFromId(id: string): { dir: string; rel: string; plat: string; tag: string; abi: string } {
  const parts = id.split(';');
  if (parts.length !== 4 || parts[0] !== 'system-images') throw new PhoneDockError('The Android image is invalid', 'bad_request', 400, ['Choose an available Android image.'], `Bad image id "${id}". Use an id from GET /v1/backends/android-emulator/images`);
  const [, plat, tag, abi] = parts;
  return { dir: join(A.sdkRoot(), 'system-images', plat, tag, abi), rel: `system-images/${plat}/${tag}/${abi}/`, plat, tag, abi };
}

async function installImage(imageId: string, onProgress?: (l: string) => void): Promise<void> {
  imageDirFromId(imageId);
  const sm = sdkmanagerBin();
  if (!sm) throw new PhoneDockError('Android SDK tools were not found', 'sdkmanager_missing', 501, ['Install the Android SDK command-line tools.'], 'sdkmanager not found; brew install --cask android-commandlinetools');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(sm, [`--sdk_root=${A.sdkRoot()}`, imageId], { env: toolEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    const yes = setInterval(() => { try { child.stdin.write('y\n'); } catch { /* */ } }, 500);
    child.stdin.write('y\n');
    let last = '';
    const onData = (d: Buffer) => {
      for (const l of d.toString().split(/[\r\n]+/)) { const t = l.trim(); if (t && t !== last) { last = t; onProgress?.(t); } }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', (e) => { clearInterval(yes); reject(e); });
    child.on('close', (code) => { clearInterval(yes); code === 0 ? resolve() : reject(new PhoneDockError("Couldn’t install the Android image", 'install_failed', 500, undefined, `sdkmanager exited ${code}: ${last}`)); });
  });
  remoteCache = undefined;
}

function chooseDefaultImage(): string {
  const imgs = installedImages().filter((i) => i.id.endsWith(';arm64-v8a'));
  imgs.sort((a, b) => parseFloat(b.version ?? '0') - parseFloat(a.version ?? '0') || (a.id.includes('google_apis;') ? -1 : 1));
  if (!imgs.length) throw new PhoneDockError('No Android system image installed', 'no_image', 400, ['Install an Android system image.'], 'Install one: POST /v1/backends/android-emulator/images/install {"image":"system-images;android-36;google_apis;arm64-v8a"}');
  return imgs[0].id;
}

// ── backend ──────────────────────────────────────────────────────────────────
export const backend: Backend & { runningSerial(name: string): Promise<string | undefined> } = {
  id: ID,
  displayName: 'Android Emulator',
  platform: 'android',
  kind: 'virtual',
  capabilities: ['boot', 'shutdown', 'delete', 'clone', 'snapshot', ...A.ANDROID_CAPS, 'location', 'root', 'pinch', 'clipboard'],

  async available(): Promise<Availability> {
    try {
      const emu = emulatorBin(); A.adbPath();
      const r = await run(emu, ['-version'], { allowFail: true, timeoutMs: 15_000, env: toolEnv() });
      const v = /version\s+([\d.]+)/i.exec(r.stdout)?.[1];
      const hints: string[] = [];
      if (!installedImages().length) hints.push('No system image installed – POST /v1/backends/android-emulator/images/install');
      if (!A.ffmpegPath()) hints.push('ffmpeg missing: live stream falls back to screenshots (brew install ffmpeg)');
      return { ok: true, version: v, hints: hints.length ? hints : undefined };
    } catch (e) {
      const pe = e as PhoneDockError;
      return { ok: false, reason: pe.message, hints: pe.hints };
    }
  },

  async listDevices(): Promise<Device[]> {
    const managed = scanAvds(managedHome(), true);
    const names = new Set(managed.map((a) => a.name));
    const user = scanAvds(userHome(), false).filter((a) => !names.has(a.name));
    let running: Running[] = [];
    try { running = await runningEmulators(); } catch { /* adb missing */ }
    return [...managed, ...user].map((a) => toDevice(a, runningFor(running, a)));
  },

  async listImages() {
    const inst = installedImages();
    let remote: OsImage[] = [];
    try { remote = await remoteImages(); } catch { /* offline */ }
    const have = new Set(inst.map((i) => i.id));
    return [...inst, ...remote.filter((r) => !have.has(r.id))];
  },

  installImage,

  async listProfiles() { return PROFILES; },

  async create(spec: DeviceSpec, onProgress?: (l: string) => void): Promise<Device> {
    const name = sanitizeName(spec.name);
    const home = managedHome();
    if (existsSync(join(home, `${name}.ini`)) || existsSync(join(home, `${name}.avd`))) throw new PhoneDockError(`Emulator "${name}" already exists.`, 'exists', 409);
    if (scanAvds(userHome(), false).some((a) => a.name === name)) throw new PhoneDockError("An emulator with this name already exists", 'exists', 409, ["Choose another name."], [`An AVD named "${name}" already exists in ${userHome()}`, ...['Pick another name']].filter(Boolean).join('\n'));
    const disguiseOpt = parseDisguiseOption(spec.options?.disguise);
    const prelimDisguise = disguiseOpt ? resolveDisguiseCreation(spec.options?.disguise, { specProfile: spec.profile }) : undefined;
    const imageId = spec.image ?? (prelimDisguise ? chooseDisguiseImage(prelimDisguise.profile.sdk, installedImages()) : chooseDefaultImage());
    const img = imageDirFromId(imageId);
    if (!existsSync(img.dir)) {
      onProgress?.(`Installing system image ${imageId}…`);
      await installImage(imageId, onProgress);
    }
    const sp = readIni(join(img.dir, 'source.properties'));
    const parsedSdk = parseInt((sp['AndroidVersion.ApiLevel'] ?? img.plat.replace(/^android-/, '')).split('.')[0], 10);
    const imageSdk = Number.isInteger(parsedSdk) ? parsedSdk : undefined;
    const disguise = disguiseOpt
      ? resolveDisguiseCreation(spec.options?.disguise, { specProfile: spec.profile, imageSdk })
      : undefined;
    const prof = PROFILES.find((p) => p.id === spec.profile || p.name === spec.profile) ?? (spec.profile ? undefined : PROFILES[0]);
    if (spec.profile && !prof && !disguise) throw new PhoneDockError('The device profile is unknown', 'bad_request', 400, ['Choose an available device profile.'], `Unknown profile "${spec.profile}". Profiles: ${PROFILES.map((p) => p.id).join(', ')}`);
    const width = spec.width ?? disguise?.profile.screen.width ?? prof?.width ?? 1080;
    const height = spec.height ?? disguise?.profile.screen.height ?? prof?.height ?? 2424;
    const dpi = spec.dpi ?? disguise?.profile.screen.dpi ?? prof?.dpi ?? 420;
    const ramMB = spec.ramMB ?? disguise?.profile.ramMB ?? prof?.ramMB ?? 3072;
    const cpus = spec.cpus ?? 4;
    const tagId = sp['SystemImage.TagId'] ?? img.tag;
    const tagDisplay = sp['SystemImage.TagDisplay'] ?? img.tag;
    const target = img.plat; // android-36
    const avdDir = join(home, `${name}.avd`);
    mkdirSync(avdDir, { recursive: true });
    onProgress?.(`Writing AVD ${name} (${width}x${height}@${dpi}, ${cpus} cpu, ${ramMB} MB${disguise ? `, disguise=${disguise.profile.id}` : ''}) → ${avdDir}`);
    const cfg: Record<string, string> = {
      'avd.ini.encoding': 'UTF-8', 'AvdId': name, 'avd.ini.displayname': spec.name,
      'PlayStore.enabled': /playstore/.test(tagId) ? 'true' : 'false',
      'abi.type': img.abi, 'hw.cpu.arch': img.abi.startsWith('arm64') ? 'arm64' : img.abi.startsWith('x86_64') ? 'x86_64' : img.abi,
      'image.sysdir.1': img.rel, 'tag.id': tagId, 'tag.display': tagDisplay, 'tag.ids': tagId, 'tag.displaynames': tagDisplay, 'target': target,
      'hw.lcd.width': String(width), 'hw.lcd.height': String(height), 'hw.lcd.density': String(dpi), 'hw.lcd.depth': '32', 'hw.lcd.vsync': '60',
      'hw.ramSize': String(ramMB), 'vm.heapSize': String(Math.min(576, Math.max(228, Math.round(ramMB / 12)))) + 'M',
      'hw.cpu.ncore': String(cpus), 'disk.dataPartition.size': spec.storageMB ? `${spec.storageMB}M` : '6G',
      'disk.cachePartition': 'yes', 'disk.cachePartition.size': '66MB',
      'hw.keyboard': disguise ? 'no' : 'yes', 'hw.keyboard.charmap': 'qwerty2', 'hw.gpu.enabled': 'yes', 'hw.gpu.mode': String(spec.options?.gpu ?? 'auto'),
      'hw.device.name': disguise?.profile.model ?? prof?.id ?? 'custom', 'hw.device.manufacturer': disguise?.profile.manufacturer ?? 'Google',
      'hw.mainKeys': 'no', 'hw.dPad': 'no', 'hw.trackBall': 'no', 'hw.screen': 'multi-touch', 'hw.initialOrientation': width > height ? 'landscape' : 'portrait',
      'hw.accelerometer': 'yes', 'hw.gyroscope': 'yes', 'hw.gps': 'yes', 'hw.battery': 'yes', 'hw.audioInput': 'yes', 'hw.audioOutput': 'yes',
      'hw.camera.back': 'emulated', 'hw.camera.front': disguise ? 'emulated' : 'none', 'hw.sdCard': 'yes', 'sdcard.size': '512M',
      'hw.sensors.proximity': 'yes', 'hw.sensors.light': 'yes', 'hw.sensors.orientation': 'yes', 'hw.sensors.magnetic_field': 'yes', 'hw.sensors.pressure': 'yes',
      'hw.lcd.backlight': 'yes', 'hw.arc': 'false', 'hw.useext4': 'yes', 'userdata.useQcow2': 'no',
      'fastboot.forceColdBoot': 'no', 'fastboot.forceFastBoot': 'yes', 'fastboot.forceChosenSnapshotBoot': 'no',
      'firstboot.bootFromDownloadableSnapshot': 'yes', 'firstboot.bootFromLocalSnapshot': 'yes', 'firstboot.saveToLocalSnapshot': 'yes',
      'runtime.network.latency': 'none', 'runtime.network.speed': 'full', 'showDeviceFrame': 'no',
      'kernel.newDeviceNaming': 'autodetect', 'kernel.supportsYaffs2': 'autodetect',
    };
    writeIni(join(avdDir, 'config.ini'), cfg);
    writeIni(join(home, `${name}.ini`), { 'avd.ini.encoding': 'UTF-8', path: avdDir, target });
    writeFileSync(join(avdDir, 'phonedock.json'), JSON.stringify({
      displayName: spec.name,
      spec: { ...spec, image: imageId, width, height, dpi, ramMB, cpus },
      ...(disguise ? { disguise: disguise.persisted } : {}),
      createdAt: new Date().toISOString(),
    }, null, 2));
    onProgress?.('AVD created');
    return toDevice(requireAvd(name), undefined);
  },

  async boot(name: string, opts: BootOptions & { onProgress?: (l: string) => void } = {}): Promise<void> {
    const a = requireAvd(name);
    const p = opts.onProgress;
    if (await serialFor(name)) { p?.('already running'); return; }
    if (booting.has(name)) throw new PhoneDockError(`"${name}" is already booting`, 'busy', 409);
    booting.set(name, Date.now());
    let port = 0;
    try {
      const disguiseBoot = await resolveDisguiseBoot(a, {
        adbBin: A.adbPath(),
        sdkRootDir: A.sdkRoot(),
        onProgress: p,
        withBootstrapSerial: (fn) => runTransientBootstrap(a, p, fn),
      });
      port = await pickPort(); reservedPorts.add(port);
      const headless = opts.window ? false : opts.headless ?? true;
      const args = ['-avd', name, '-port', String(port), '-no-audio', '-no-boot-anim'];
      if (headless) args.push('-no-window');
      // Headless defaults to SwiftShader (software GL) which makes screencap/streaming CPU-bound.
      // Host GPU (Metal via gfxstream) works headless on Apple Silicon; override with PHONEDOCK_EMULATOR_GPU.
      args.push('-gpu', process.env.PHONEDOCK_EMULATOR_GPU ?? 'host');
      // The disk rule: the quick-boot state a sleep left loads only if nothing has written the disk since (else it goes).
      let coldBoot = !!opts.coldBoot;
      if (a.managed && existsSync(exitSaveRecord(a))) {
        if (!exitSaveIntact(a)) { rmSync(snapshotPb(a), { force: true }); coldBoot = true; }
        rmSync(exitSaveRecord(a), { force: true });
      }
      if (coldBoot || disguiseBoot?.forceColdBoot) args.push('-no-snapshot-load');
      if (disguiseBoot?.ramdiskPath) args.push('-ramdisk', disguiseBoot.ramdiskPath);
      // Vulkan: an app that uses it (Chrome does) makes the emulator refuse to save a snapshot (UNSUPPORTED_VK_APP).
      // Without it Chrome renders through OpenGL ES and snapshots save fine (measured; screenshots as fast).
      if (!vulkanEnabled(a)) args.push('-feature', '-Vulkan');
      // Experiments only (e.g. "-feature -Vulkan"); whitespace-separated.
      if (process.env.PHONEDOCK_EMULATOR_EXTRA_ARGS) args.push(...process.env.PHONEDOCK_EMULATOR_EXTRA_ARGS.split(/\s+/).filter(Boolean));
      const logFile = join(stateDir('logs'), `emulator-${name}.log`);
      const fd = openSync(logFile, 'a');
      p?.(`spawning emulator ${args.join(' ')} (log: ${logFile})`);
      const child = spawn(emulatorBin(), args, {
        detached: true, stdio: ['ignore', fd, fd],
        env: { ...toolEnv(), ANDROID_AVD_HOME: a.home },
      });
      closeSync(fd);
      child.unref();
      children.set(name, child);
      let exited: string | undefined;
      child.on('exit', (code, sig) => { exited = `emulator exited (${code ?? sig}) – see ${logFile}: ${tail(logFile)}`; children.delete(name); });
      const serial = `emulator-${port}`;
      const t0 = Date.now();
      // wait for adb to see it, then for boot_completed
      await A.waitBootCompleted(serial, 240_000, () => exited);
      disguiseBoot?.commit();
      p?.(`boot completed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      // Wake and unlock like a snapshot restore does. Not KEYCODE_MENU (82), the old emulator unlock: with no lock
      // screen up, the launcher takes it and opens its Wallpaper/Widgets/Home settings menu on every fresh boot.
      await A.adb(serial, ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], { allowFail: true });
      await A.adb(serial, ['shell', 'wm', 'dismiss-keyguard'], { allowFail: true });
      if (a.managed) await presetChrome(serial);
      serialCache.delete(serial);
    } finally {
      booting.delete(name);
      if (port) reservedPorts.delete(port);
    }
  },

  async shutdown(name: string) {
    const s = await consoleSerial(name);
    if (!s) return;
    await A.adb(s, ['emu', 'kill'], { allowFail: true, timeoutMs: 10_000 });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (!(await A.adbDevices()).some((d) => d.serial === s)) break;
      await sleep(500);
    }
    // Wait for the qemu process to release its locks (clone/delete right after shutdown).
    const a = findAvd(name);
    if (a) for (let i = 0; i < 40 && readdirSync(a.avdDir).some((f) => f.endsWith('.lock')); i++) await sleep(250);
    serialCache.delete(s);
  },

  async delete(name: string) {
    const a = requireAvd(name);
    if (!a.managed) throw new PhoneDockError("This emulator was not created by PhoneDock", 'forbidden', 403, undefined, [`"${name}" is not managed by PhoneDock (lives in ${a.home})`, ...['PhoneDock never deletes AVDs it did not create']].filter(Boolean).join('\n'));
    await backend.shutdown!(name);
    rmSync(a.avdDir, { recursive: true, force: true });
    rmSync(join(a.home, `${name}.ini`), { force: true });
  },

  async clone(name: string, newName: string): Promise<Device> {
    const a = requireAvd(name);
    if (await serialFor(name)) throw new PhoneDockError('Clone requires the source device to be stopped', 'not_stopped', 409, ['Shut it down first.']);
    const nn = sanitizeName(newName);
    const home = managedHome();
    if (findAvd(nn)) throw new PhoneDockError(`Emulator "${nn}" already exists.`, 'exists', 409);
    const dst = join(home, `${nn}.avd`);
    // APFS clonefile – instant, copy-on-write.
    const r = await run('/bin/cp', ['-c', '-R', a.avdDir, dst], { allowFail: true, timeoutMs: 600_000 });
    if (r.code !== 0) cpSync(a.avdDir, dst, { recursive: true });
    for (const f of readdirSync(dst)) {
      if (f.endsWith('.lock') || f === 'hardware-qemu.ini' || f === 'emulator-user.ini' || f === 'emu-launch-params.txt') rmSync(join(dst, f), { recursive: true, force: true });
    }
    // Snapshots embed the source AVD path; drop them so the clone cold-boots cleanly from its copied disks.
    rmSync(join(dst, 'snapshots'), { recursive: true, force: true });
    const cfg = readIni(join(dst, 'config.ini'));
    cfg.AvdId = nn; cfg['avd.ini.displayname'] = newName;
    writeIni(join(dst, 'config.ini'), cfg);
    const srcIni = readIni(join(a.home, `${name}.ini`));
    writeIni(join(home, `${nn}.ini`), { 'avd.ini.encoding': 'UTF-8', path: dst, target: srcIni.target ?? cfg.target ?? '' });
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(readFileSync(join(dst, 'phonedock.json'), 'utf8')); } catch { /* */ }
    const nextDisguise = isPersistedDisguise(meta.disguise) ? clonePersistedDisguise(meta.disguise) : undefined;
    writeFileSync(join(dst, 'phonedock.json'), JSON.stringify({
      ...meta,
      displayName: newName,
      clonedFrom: name,
      spec: { ...(meta.spec as object ?? {}), name: newName },
      ...(nextDisguise ? { disguise: nextDisguise } : {}),
      createdAt: new Date().toISOString(),
    }, null, 2));
    return toDevice(requireAvd(nn), undefined);
  },

  async listSnapshots(name: string): Promise<Snapshot[]> {
    // From disk, running or not: the emulator's own list gives a size only while it runs, which made the size come and go.
    const a = requireAvd(name);
    const dir = join(a.avdDir, 'snapshots');
    return userSnapshotNames(a.avdDir).map((n) => {
      const d = join(dir, n);
      let at = statSync(d).mtime;
      try { at = statSync(join(d, 'snapshot.pb')).mtime; } catch { /* */ }
      let sizeMB: number | undefined; try { sizeMB = snapshotDiskMB(d); } catch { /* */ }
      return { name: n, createdAt: at.toISOString(), ...(sizeMB !== undefined ? { sizeMB } : {}) };
    }).sort((x, y) => (x.createdAt ?? '').localeCompare(y.createdAt ?? ''));
  },
  async saveSnapshot(name: string, snap: string) { await emuSnapshot(name, 'save', personsSnapshot(name, snap)); },
  async restoreSnapshot(name: string, snap: string) {
    await emuSnapshot(name, 'load', personsSnapshot(name, snap));
    // The restored state can be a sleeping screen (the snapshot was saved with it off). The phone must end up
    // running and showing its screen: wake it, and report honestly if it didn't come back.
    const s = await serialFor(name);
    const gone = () => new PhoneDockError('The phone didn’t come back after restoring the snapshot', 'snapshot_failed', 500, ['Start the phone again, then try restoring.'], `Emulator "${name}" is not reachable after loading snapshot "${snap}"`);
    if (!s) throw gone();
    await A.waitBootCompleted(s, 60_000).catch(() => { throw gone(); });
    await A.adb(s, ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], { allowFail: true });
    await A.adb(s, ['shell', 'wm', 'dismiss-keyguard'], { allowFail: true });
    const deadline = Date.now() + 8_000;
    for (;;) {
      const p = await A.adb(s, ['shell', 'dumpsys', 'power'], { allowFail: true, timeoutMs: 8_000 });
      if (/mWakefulness=Awake/.test(p.stdout)) break;
      if (Date.now() > deadline) throw new PhoneDockError('The phone restored but its screen stayed off', 'snapshot_failed', 500, ['Press the power button on the phone, or try restoring again.'], `mWakefulness not Awake after wakeup: ${p.stdout.match(/mWakefulness=\w+/)?.[0] ?? p.stdout.slice(0, 200)}`);
      await A.adb(s, ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], { allowFail: true });
      await sleep(500);
    }
  },
  async deleteSnapshot(name: string, snap: string) {
    personsSnapshot(name, snap);
    const s = await consoleSerial(name);
    if (s) { await emuSnapshot(name, 'del', snap); return; }
    const a = requireAvd(name);
    const d = join(a.avdDir, 'snapshots', sanitizeName(snap));
    if (!existsSync(d)) throw new PhoneDockError(`No snapshot "${snap}"`, 'not_found', 404);
    rmSync(d, { recursive: true, force: true });
  },

  async openWindow(name: string) {
    const s = await serialFor(name);
    if (!s) { await backend.boot!(name, { headless: false }); return; }
    const scrcpy = which('scrcpy');
    if (!scrcpy) throw new PhoneDockError('The emulator window could not be opened', 'scrcpy_missing', 501, ['Install scrcpy or start the emulator with a window.'], 'scrcpy not found; brew install scrcpy; or boot with {"headless":false} for the emulator window');
    const c = spawn(scrcpy, ['-s', s, '--window-title', name], { detached: true, stdio: 'ignore', env: { ...toolEnv(), ADB: A.adbPath() } });
    c.unref();
  },

  async getSettings(id) { return A.getSettings(await requireSerial(id)); },
  async setSettings(id, patch) { await A.setSettings(await requireSerial(id), patch, `android-emulator:${id}`); },
  async resetSettings(id) { await A.resetSettings(await requireSerial(id), `android-emulator:${id}`); },
  async screenshot(name) { return emulatorScreenshot(await requireSerial(name)); },
  async screenInfo(name) { return A.screenInfo(await requireSerial(name)); },
  stream(name, opts) {
    // serial resolution is async; wrap.
    let inner: ReturnType<typeof adbFrameStream> | undefined; let stopped = false;
    const fcb: ((j: Buffer, s?: ScreenInfo) => void)[] = []; const ecb: ((e?: Error) => void)[] = [];
    void requireSerial(name).then((s) => {
      if (stopped) return;
      inner = adbFrameStream(s, { ...opts, capture: () => emulatorScreenshot(s) });
      inner.onFrame((j, si) => fcb.forEach((c) => c(j, si)));
      inner.onEnd((e) => ecb.forEach((c) => c(e)));
    }, (e) => ecb.forEach((c) => c(e)));
    return {
      onFrame: (cb) => { fcb.push(cb); }, onEnd: (cb) => { ecb.push(cb); }, stop: () => { stopped = true; inner?.stop(); },
      restart: () => inner?.restart?.(), asleep: () => !!inner?.asleep?.(),
    };
  },
  video(name, opts) {
    let inner: VideoStream | undefined; let stopped = false;
    const pcb: ((p: VideoPacket) => void)[] = []; const ecb: ((e?: Error) => void)[] = [];
    void requireSerial(name).then((s) => {
      if (stopped) return;
      inner = adbVideoStream(s, opts);
      inner.onPacket((p) => pcb.forEach((c) => c(p)));
      inner.onEnd((e) => ecb.forEach((c) => c(e)));
    }, (e) => ecb.forEach((c) => c(e)));
    return {
      onPacket: (cb) => { pcb.push(cb); }, onEnd: (cb) => { ecb.push(cb); },
      stop: () => { stopped = true; inner?.stop(); }, restart: () => inner?.restart?.(), requestKeyFrame: () => inner?.requestKeyFrame?.(),
    };
  },
  async uiTree(name) { return A.uiTree(await requireSerial(name)); },
  async tap(name, x, y) { await A.tap(await requireSerial(name), x, y); },
  async longPress(name, x, y, ms) { await A.longPress(await requireSerial(name), x, y, ms); },
  async swipe(name, x1, y1, x2, y2, ms) { await A.swipe(await requireSerial(name), x1, y1, x2, y2, ms); },
  async type(name, text) { await A.typeText(await requireSerial(name), text); },
  async key(name, k) { await A.key(await requireSerial(name), k); },
  async installApp(name, path) { return A.installApp(await requireSerial(name), path); },
  async uninstallApp(name, id) { await A.uninstallApp(await requireSerial(name), id); },
  async listApps(name: string, opts?: { system?: boolean }) { return A.listApps(await requireSerial(name), !!opts?.system); },
  async appInfo(name, id) { return A.appInfo(await requireSerial(name), id); },
  async launchApp(name, id, opts) { await A.launchApp(await requireSerial(name), id, opts); },
  async terminateApp(name, id) { await A.terminateApp(await requireSerial(name), id); },
  async openUrl(name, url) { await A.openUrl(await requireSerial(name), url); },
  async shell(name, cmd) { return A.shell(await requireSerial(name), cmd); },
  async pushFile(name, l, r) { await A.pushFile(await requireSerial(name), l, r); },
  async pullFile(name, r, l) { await A.pullFile(await requireSerial(name), r, l); },
  async logs(name, o) { return A.logs(await requireSerial(name), o); },
  async setLocation(name, lat, lon) {
    const s = await requireSerial(name);
    const r = await A.adb(s, ['emu', 'geo', 'fix', String(lon), String(lat)], { allowFail: true });
    if (!/OK/.test(r.stdout)) throw new PhoneDockError("Couldn’t set the location", 'location_failed', 500, undefined, `geo fix failed: ${r.stdout.trim()}`);
  },
  async rotate(name, o) { await A.rotate(await requireSerial(name), o); },
  // ── v0.2 ──
  async doubleTap(name, x, y) { await A.doubleTap(await requireSerial(name), x, y); },
  async drag(name, x1, y1, x2, y2, ms, hold) { await A.drag(await requireSerial(name), x1, y1, x2, y2, ms, hold); },
  async pinch(name, x, y, scale, ms) { await emulatorPinch(await requireSerial(name), x, y, scale, ms); },
  async hideKeyboard(name) { await A.hideKeyboard(await requireSerial(name)); },
  async foregroundApp(name) { return A.foregroundApp(await requireSerial(name)); },
  async listCrashes(name, o) { return A.listCrashes(await requireSerial(name), o); },
  async getCrash(name, id) { return A.getCrash(await requireSerial(name), id); },
  async startRecording(name, out, o) { await A.startRecording(await requireSerial(name), out, { ...o, emulator: true }); },
  async stopRecording(name) { return A.stopRecording(await requireSerial(name)); },
  async exportAppData(name, pkg, dir) { await A.exportAppData(await requireSerial(name), pkg, dir); },
  async importAppData(name, pkg, dir) { await A.importAppData(await requireSerial(name), pkg, dir); },
  async clipboardGet(name) { return C.clipboardGet(await requireSerial(name)); },
  async clipboardSet(name, text) { await C.clipboardSet(await requireSerial(name), text); },
  async startTrace(name, dir, o) { return T.startPerfetto(await requireSerial(name), dir, o); },
  async stopTrace(name) { return T.stopPerfetto(await requireSerial(name)); },
  async abortTrace(name) { const s = await serialFor(name).catch(() => undefined); if (s) await T.abortPerfetto(s); },
  async info(name) {
    const a = requireAvd(name);
    const s = await serialFor(name);
    const disguise = isPersistedDisguise(a.meta?.disguise) ? disguiseDeviceMeta(a.meta.disguise) : undefined;
    return {
      avd: name, avdDir: a.avdDir, managed: a.managed, config: a.config,
      ...(disguise ? { disguise } : {}),
      ...(s ? await A.info(s) : { running: false }),
    };
  },
  runningSerial: serialFor,
  // ── idle sleep (src/daemon/idle-sleep.ts): the ordinary shutdown (`emu kill` saves default_boot on the way out) and
  // the ordinary boot, under the disk rule (exitSaveIntact): a quick-boot state loads only if nothing wrote the disk since.
  async prepareSleep(name: string): Promise<SleepState> {
    const a = requireManagedAvd(name);
    const s = await managedSerial(name);
    if (!s) throw new PhoneDockError(`Emulator "${name}" is not running`, 'not_running', 409, undefined, `No running emulator is positively ${a.avdDir}`);
    // Its exit save writes up to the guest's whole RAM: not onto a nearly full disk.
    const ramMB = parseRam(a.config['hw.ramSize']) ?? 2048;
    const free = freeBytes(a.avdDir);
    if (free === undefined || !enoughDiskForSleep(free, ramMB)) {
      const gb = (n: number) => (n / 1024 ** 3).toFixed(1);
      throw new PhoneDockError(free === undefined ? 'PhoneDock can’t tell how much disk is free' : 'Not enough free disk to save the phone’s state', 'disk_full', 507,
        [`It keeps running. Sleeping needs about ${gb(ramMB * 1024 ** 2 + SLEEP_DISK_MARGIN)} GB free${free === undefined ? '' : `; ${gb(free)} GB is`}.`],
        `${a.avdDir}: ${free ?? 'unknown'} bytes free, hw.ramSize=${ramMB} MB`);
    }
    return { at: new Date().toISOString(), avdPath: realpathSync(a.avdDir), ...await guestIdentity(s) };
  },

  async stopForSleep(name: string, saved: SleepState, opts: { timeoutMs?: number; confirm?: () => string | undefined } = {}): Promise<SleepState> {
    const a = requireManagedAvd(name);
    if (saved.avdPath && !samePath(a.avdDir, saved.avdPath)) throw sleepingAvdGone(name);
    const s = await managedSerial(name);
    if (!s) {
      // Not running any more (stopped elsewhere, or crashed): nothing of this sleep's to trust, so every boot starts fresh.
      if (await emulatorProcessOf(name) === undefined) { rmSync(exitSaveRecord(a), { force: true }); rmSync(snapshotPb(a), { force: true }); return saved; }
      throw new PhoneDockError('The phone didn’t stop', 'sleep_failed', 500, undefined, `${name}: adb doesn't list it, and PhoneDock can't tell whether its emulator process is gone`);
    }
    const abort = (why: string) => new PhoneDockError(`It keeps running: ${why}`, 'sleep_failed', 500, undefined, `${name} (${s}): ${why}; nothing was stopped`);
    processCache = undefined;   // its process as of now (a list from before it started wouldn't have it)
    const proc = await emulatorProcessOf(name, s);   // the stop is bound to this process, on this console port
    if (!proc) throw abort('PhoneDock can’t tell which process is its emulator');
    // From here only this sleep's own exit save can be loaded: the old one goes (its snapshot.pb; see the disk rule), so a
    // crash from now on boots cold. A record no boot can match stands until the proof replaces it (should this daemon die
    // after the stop is sent); a sleep that goes no further takes it back, and the phone's next exit saves a new state.
    try { writeExitSaveRecord(a, { v: 1, pbMtimeMs: -1, disks: {} }); rmSync(snapshotPb(a), { force: true }); }
    catch (e) { throw abort(`its saved state couldn’t be set aside (${(e as NodeJS.ErrnoException).code})`); }
    try {
      // Writes still in the guest's memory would be lost if the next boot starts fresh: flushed, or no stop.
      const sync = await A.adb(s, ['shell', 'sync'], { allowFail: true, timeoutMs: 30_000 });
      if (sync.code !== 0) throw abort('its writes couldn’t be flushed to its disk');
      // Still this emulator on that serial (its console port is free for another once it is gone), asked now.
      if ((await managedSerial(name)) !== s || !processAlive(proc.pid)) throw abort('its adb connection changed');
      // Use on the Mac, asked again now (an adb push or a scrcpy started during the guest's checks or its sync).
      processCache = undefined;
      const ps = await processList();
      const busy = ps.ok ? hostActivity(ps.list, proc, s) : 'PhoneDock can’t tell whether it is in use (couldn’t list processes)';
      if (busy) throw new PhoneDockError(`It keeps running: ${busy}`, 'sleep_called_off', 409);
      const why = opts.confirm?.();   // the daemon's last look (use, leases, the setting), with no await before the stop
      if (why) throw new PhoneDockError(`It keeps running: ${why}`, 'sleep_called_off', 409);
    } catch (e) {
      try { rmSync(exitSaveRecord(a), { force: true }); } catch { /* it stays: the next boot is cold, the data kept */ }
      throw e;
    }
    const t0 = Date.now();
    await A.adb(s, ['emu', 'kill'], { allowFail: true, timeoutMs: 10_000 });
    // Its memory is free once its process is gone and adb no longer lists it.
    const exited = async () => !processAlive(proc.pid) && !(await A.adbDevices().then((l) => l.some((d) => d.serial === s), () => true));
    const timeoutMs = opts.timeoutMs ?? 180_000;
    while (!(await exited())) {
      if (Date.now() - t0 > timeoutMs) throw new PhoneDockError('The phone didn’t stop', 'sleep_failed', 500, ['Shut it down from PhoneDock, or quit the emulator process.'], `emulator pid ${proc.pid} / ${s} still there ${Math.round(timeoutMs / 1000)} s after emu kill`);
      await sleep(250);
    }
    serialCache.delete(s); processCache = undefined;
    const pb = recordExitSave(a, t0);
    if (pb === undefined) { rmSync(snapshotPb(a), { force: true }); return saved; }   // a partial save must not load either
    return { ...saved, exitSave: { mtimeMs: pb } };
  },

  async wakeFromSleep(name: string, saved: SleepState, opts: BootOptions & { onProgress?: (l: string) => void } = {}): Promise<WakeReport> {
    const a = requireManagedAvd(name);
    if (saved.avdPath && !samePath(a.avdDir, saved.avdPath)) throw sleepingAvdGone(name);
    const { onProgress, ...boot } = opts;
    const already = await managedSerial(name);
    let report: WakeReport;
    if (already) {
      // Running already (started outside PhoneDock while it slept, or still starting): once it has booted, say how.
      await A.waitBootCompleted(already, 240_000);
      report = resumedFrom(await guestIdentityRetry(already), saved) ? { resumed: true, via: 'quickboot' }
        : { resumed: false, via: 'cold', note: 'It was started outside PhoneDock while it slept.' };
      report.clock = await setGuestClock(already);
      return report;
    }
    const intact = exitSaveIntact(a);
    await backend.boot!(name, { headless: true, ...boot, coldBoot: !!boot.coldBoot || !intact, onProgress } as BootOptions);
    const s = await managedSerial(name);
    if (!s) throw new PhoneDockError(`Emulator "${name}" is not running`, 'not_running', 409, ['Start it from PhoneDock.'], `It booted, but no running emulator is positively ${a.avdDir}`);
    if (!intact) report = { resumed: false, via: 'cold', note: saved.exitSave ? 'Its disk or saved state changed while it slept.' : 'It didn’t save its state when it stopped.' };
    else if (boot.coldBoot) report = { resumed: false, via: 'cold', note: 'A cold boot was asked for.' };
    else if (resumedFrom(await guestIdentityRetry(s), saved)) report = { resumed: true, via: 'quickboot' };
    else report = { resumed: false, via: 'cold', note: 'Its saved state didn’t load.' };
    report.clock = await setGuestClock(s);
    return report;
  },

  async checkSleeping(name: string, saved: SleepState): Promise<void> {
    const a = findAvd(name);   // PhoneDock's own first; a person's same-named AVD only once PhoneDock's is gone
    if (!a?.managed || !samePath(a.avdDir, saved.avdPath ?? a.avdDir)) throw sleepingAvdGone(name);
  },

  async keepAwake(name: string, opts: { timeoutSec?: number | null; guest?: boolean } = {}): Promise<string | undefined> {
    // Use PhoneDock can't see: its window, scrcpy, someone's adb session, and (guest) the phone's own idle clock and test
    // runs. Whatever can't be read counts as in use. The guest check asks the emulators now; the cheap one shares a sweep's.
    const cantTell = (why: string) => `PhoneDock can’t tell whether it is in use (${why})`;
    const own = scanAvds(managedHome(), true).find((x) => x.name === name);
    if (!own || !ownAvd(own)) return 'PhoneDock didn’t create it in its own folder, so it never sleeps';
    const s = await (opts.guest ? managedSerial(name) : serialFor(name, 'shared')).catch(() => undefined);
    if (!s) return cantTell('adb doesn’t list it');
    const ps = await processList();
    if (!ps.ok) return cantTell('couldn’t list processes');
    const proc = await emulatorProcessOf(name, s);
    if (!proc) return cantTell('its emulator process can’t be identified');   // e.g. started elsewhere without -port
    const host = hostActivity(ps.list, proc, s);
    if (host) return host;
    if (!opts.guest) return undefined;
    const r = await A.adb(s, ['shell', GUEST_ACTIVITY], { allowFail: true, timeoutMs: 10_000 }).catch(() => undefined);
    const g = parseGuestActivity(r?.code === 0 ? r.stdout : undefined);
    if (g.error) return cantTell(g.error);
    if (g.instrumenting) return 'a test is running on it (instrumentation)';
    if (opts.timeoutSec && g.lastInputAgoMs! < opts.timeoutSec * 1000) return `it was used ${Math.round(g.lastInputAgoMs! / 60_000)} min ago through something other than PhoneDock (adb, Android Studio or a test)`;
    return undefined;
  },
};

export interface DisguiseBootResult {
  ramdiskPath: string;
  forceColdBoot: boolean;
  overlaySha256: string;
  baseCached: boolean;
  ramdiskCached: boolean;
  /** Persist `overlaySha256` to `phonedock.json` once the disguised boot completes cleanly. */
  commit: () => void;
}

/**
 * Prepare the disguised ramdisk for an AVD before spawning `emulator`.
 * Returns `undefined` for non-disguised or unmanaged AVDs. Requests `forceColdBoot` whenever the
 * overlay changed (first boot, clone, or updated overlay scripts) so stale quick-boot snapshots
 * never resurrect old props; callers invoke `commit()` after boot completes so a failed boot
 * always retries cold.
 */
export async function resolveDisguiseBoot(
  a: Pick<AvdEntry, 'name' | 'avdDir' | 'config' | 'managed' | 'meta'>,
  deps: PrepareDisguiseDeps & { sdkRootDir: string },
): Promise<DisguiseBootResult | undefined> {
  if (!a.managed || !isPersistedDisguise(a.meta?.disguise)) return undefined;
  const disguise = a.meta.disguise;
  const imageId = (a.meta.spec as Partial<DeviceSpec> | undefined)?.image ?? imageIdFromSysdir(a.config['image.sysdir.1']);
  if (!imageId) {
    throw new PhoneDockError(`Cannot determine Android system image for disguised AVD "${a.name}"`, 'bad_request', 400);
  }
  const parts = imageId.split(';');
  if (parts.length !== 4 || parts[0] !== 'system-images') {
    throw new PhoneDockError(`Invalid system image "${imageId}" on disguised AVD "${a.name}"`, 'bad_request', 400);
  }
  const stockRamdiskPath = join(deps.sdkRootDir, 'system-images', parts[1], parts[2], parts[3], 'ramdisk.img');
  const prepared = await prepareDisguiseRamdisk(
    { imageId, stockRamdiskPath, disguise },
    deps,
  );
  const forceColdBoot = disguise.overlaySha256 !== prepared.overlaySha256;
  const commit = () => {
    if (!forceColdBoot) return;
    const metaFile = join(a.avdDir, 'phonedock.json');
    let meta: Record<string, unknown> = a.meta ? { ...a.meta } : {};
    try { meta = JSON.parse(readFileSync(metaFile, 'utf8')); } catch { /* keep in-memory meta */ }
    const updated: PersistedDisguise = { ...disguise, overlaySha256: prepared.overlaySha256 };
    writeFileSync(metaFile, JSON.stringify({ ...meta, disguise: updated }, null, 2));
  };
  return {
    ramdiskPath: prepared.ramdiskPath,
    forceColdBoot,
    overlaySha256: prepared.overlaySha256,
    baseCached: prepared.baseCached,
    ramdiskCached: prepared.ramdiskCached,
    commit,
  };
}

/**
 * Boot a transient read-only stock emulator solely to run in-guest `magiskboot` once per system image.
 * Always shuts down the transient emulator and releases locks/port before returning so the real
 * disguised boot starts clean on unmodified AVD userdata.
 */
async function runTransientBootstrap(
  a: AvdEntry,
  onProgress: ((l: string) => void) | undefined,
  fn: (serial: string) => Promise<void>,
): Promise<void> {
  const bootPort = await pickPort();
  reservedPorts.add(bootPort);
  const serial = `emulator-${bootPort}`;
  const args = [
    '-avd', a.name, '-port', String(bootPort),
    '-no-audio', '-no-boot-anim', '-no-window',
    '-gpu', process.env.PHONEDOCK_EMULATOR_GPU ?? 'host',
    '-no-snapshot', '-read-only',
  ];
  if (!vulkanEnabled(a)) args.push('-feature', '-Vulkan');
  const logFile = join(stateDir('logs'), `emulator-${a.name}-bootstrap.log`);
  const fd = openSync(logFile, 'a');
  onProgress?.(`Booting transient stock emulator on ${serial} to patch base ramdisk (cached once per image)…`);
  const child = spawn(emulatorBin(), args, {
    detached: true, stdio: ['ignore', fd, fd],
    env: { ...toolEnv(), ANDROID_AVD_HOME: a.home },
  });
  closeSync(fd);
  child.unref();
  let exited: string | undefined;
  child.on('exit', (code, sig) => { exited = `bootstrap emulator exited (${code ?? sig}) – see ${logFile}: ${tail(logFile)}`; });
  try {
    await A.waitBootCompleted(serial, 240_000, () => exited);
    await fn(serial);
  } finally {
    await A.adb(serial, ['emu', 'kill'], { allowFail: true, timeoutMs: 10_000 }).catch(() => undefined);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (!(await A.adbDevices().catch(() => [])).some((d) => d.serial === serial)) break;
      await sleep(500);
    }
    for (let i = 0; i < 40 && readdirSync(a.avdDir).some((f) => f.endsWith('.lock')); i++) await sleep(250);
    serialCache.delete(serial);
    reservedPorts.delete(bootPort);
  }
}


/** Should this AVD boot with Vulkan? Only AVDs PhoneDock created are touched. The choice is made once per AVD and
 *  remembered in its phonedock.json: Vulkan off, unless it already holds snapshots (those were saved with Vulkan
 *  on and can only be loaded with the same emulator features). PHONEDOCK_EMULATOR_VULKAN=1|0 overrides it. */
function vulkanEnabled(a: AvdEntry): boolean {
  const env = process.env.PHONEDOCK_EMULATOR_VULKAN;
  if (env === '1' || env === 'true') return true;
  if (env === '0' || env === 'false') return false;
  if (!a.managed) return true;
  const f = join(a.avdDir, 'phonedock.json');
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(readFileSync(f, 'utf8')); } catch { /* none yet */ }
  if (typeof meta.vulkan === 'boolean') return meta.vulkan;
  const vulkan = userSnapshotNames(a.avdDir).length > 0;
  try { writeFileSync(f, JSON.stringify({ ...meta, vulkan }, null, 2)); } catch { /* */ }
  return vulkan;
}
const INTERNAL_SNAPSHOT = 'default_boot';   // the emulator's own quick-boot snapshot: not the person's
/** Whether this folder name is the emulator's own quick-boot state on this AVD's disk: `default_boot`, and on a
 *  case-insensitive volume (the Mac's default) any spelling of it. A distinct `DEFAULT_BOOT` elsewhere is the person's. */
function isInternalSnapshot(avdDir: string, n: string): boolean {
  if (n === INTERNAL_SNAPSHOT) return true;
  if (n.toLowerCase() !== INTERNAL_SNAPSHOT) return false;
  const base = basename(avdDir), flip = base === base.toUpperCase() ? base.toLowerCase() : base.toUpperCase();
  try { const x = statSync(avdDir), y = statSync(join(dirname(avdDir), flip)); return x.ino === y.ino && x.dev === y.dev; }
  catch (e) { return (e as NodeJS.ErrnoException).code !== 'ENOENT'; }   // ENOENT: case-sensitive. Can't tell: the emulator's
}
function userSnapshotNames(avdDir: string): string[] { return safeLs(join(avdDir, 'snapshots')).filter((n) => !isInternalSnapshot(avdDir, n)); }
/** A snapshot name from a person (the API): never one that names the emulator's own quick-boot state (`default boot`). */
function personsSnapshot(name: string, snap: string): string {
  const a = findAvd(name);
  if (isInternalSnapshot(a?.avdDir ?? '/', sanitizeName(snap))) throw new PhoneDockError(`"${snap}" is reserved for the emulator`, 'bad_request', 400, ['Choose another snapshot name.'], `"${snap}" names "${INTERNAL_SNAPSHOT}", the emulator's quick-boot state`);
  return snap;
}

// ── idle sleep helpers ───────────────────────────────────────────────────────
/** The guest's kernel boot id and uptime: a resumed guest has the same boot id and is at least as old. */
async function guestIdentity(serial: string): Promise<{ bootId?: string; uptimeSec?: number }> {
  const r = await A.adb(serial, ['shell', 'cat', '/proc/sys/kernel/random/boot_id', '/proc/uptime'], { allowFail: true, timeoutMs: 10_000 });
  const [boot, up] = r.stdout.trim().split('\n').map((l) => l.trim());
  const uptimeSec = Number.parseFloat(up ?? '');
  return { ...(/^[0-9a-f-]{36}$/.test(boot ?? '') ? { bootId: boot } : {}), ...(Number.isFinite(uptimeSec) ? { uptimeSec } : {}) };
}
/** Right after a boot adb can drop a command or two. */
async function guestIdentityRetry(serial: string): Promise<{ bootId?: string; uptimeSec?: number }> {
  for (let i = 0; ; i++) {
    const id = await guestIdentity(serial).catch(() => ({} as { bootId?: string }));
    if (id.bootId || i >= 4) return id;
    await sleep(500);
  }
}
/** The guest is the one that went to sleep: same kernel boot, at least as old. Unknown (unreadable) is not. */
export function resumedFrom(now: { bootId?: string; uptimeSec?: number }, saved: Pick<SleepState, 'bootId' | 'uptimeSec'>): boolean {
  if (!saved.bootId || now.bootId !== saved.bootId) return false;
  return saved.uptimeSec === undefined || (now.uptimeSec ?? -1) >= saved.uptimeSec - 1;
}
/** Room for the exit save: up to the guest's whole RAM, and a margin. */
const SLEEP_DISK_MARGIN = 1024 ** 3;
function enoughDiskForSleep(freeBytes: number, ramMB: number): boolean { return freeBytes >= ramMB * 1024 ** 2 + SLEEP_DISK_MARGIN; }
function freeBytes(dir: string): number | undefined {
  try { const s = statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return undefined; }
}
// The disk rule: a saved state may be loaded only if nothing has written the disk since it was saved. Loading one that
// is older brings back an older disk (measured, case d). The quick-boot state is loadable only through its snapshot.pb
// (without one the emulator cold-boots, keeping apps and data), so a sleep removes that file before its stop: the exit
// save writes a new one (measured: it keeps its RAM image open and saves over it; removing the folder stops the save).
const snapshotPb = (a: AvdEntry) => join(a.avdDir, 'snapshots', INTERNAL_SNAPSHOT, 'snapshot.pb');
/** Written after a proven exit save: its snapshot.pb and the disk images, as they were once the emulator had exited. */
const exitSaveRecord = (a: AvdEntry) => join(a.avdDir, 'phonedock-exit-save.json');
interface ExitSaveRecord { v: 1; pbMtimeMs: number; disks: Record<string, number> }
/** The disk images' mtimes (every .img and .qcow2 in the AVD); undefined when any can't be read. */
function diskTimes(a: AvdEntry): Record<string, number> | undefined {
  try {
    const out: Record<string, number> = {};
    for (const f of readdirSync(a.avdDir)) if (/\.(img|qcow2)$/.test(f)) out[f] = statSync(join(a.avdDir, f)).mtimeMs;
    return Object.keys(out).length ? out : undefined;
  } catch { return undefined; }
}
/** Its quick-boot state is this sleep's exit save, and no disk image changed since: positive evidence, else false. */
function exitSaveIntact(a: AvdEntry): boolean {
  try {
    const r = JSON.parse(readFileSync(exitSaveRecord(a), 'utf8')) as ExitSaveRecord;
    const now = diskTimes(a);
    return r.v === 1 && statSync(snapshotPb(a)).mtimeMs === r.pbMtimeMs && !!now && Object.keys(now).length === Object.keys(r.disks).length
      && Object.entries(r.disks).every(([k, v]) => now[k] === v);
  } catch { return false; }
}
/** After the stop: proven when a full snapshot.pb (not the stub a failed load leaves) and a RAM image were written. */
function recordExitSave(a: AvdEntry, killedAt: number): number | undefined {
  try {
    const pb = statSync(snapshotPb(a)), disks = diskTimes(a);
    if (pb.size < 32 || pb.mtimeMs < killedAt - 2000 || statSync(join(a.avdDir, 'snapshots', INTERNAL_SNAPSHOT, 'ram.bin')).size <= 0 || !disks) return undefined;
    writeExitSaveRecord(a, { v: 1, pbMtimeMs: pb.mtimeMs, disks });
    return pb.mtimeMs;
  } catch { return undefined; }
}
function writeExitSaveRecord(a: AvdEntry, r: ExitSaveRecord) {
  const tmp = `${exitSaveRecord(a)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(r));
  renameSync(tmp, exitSaveRecord(a));
}
const samePath = (p: string, q: string | undefined) => { try { return !!q && realpathSync(p) === realpathSync(q); } catch { return false; } };
/** The guest's own idle clock and whether a test runs (an `am instrument` client, or an instrumentation Android lists as
 *  active: ProcessList's dump, Android 14), each with proof it was read (a part that fails says nothing). */
const GUEST_ACTIVITY = 'dumpsys power | grep -E "^ *lastUserActivityTime=" | head -1; if p=$(ps -A -o ARGS); then echo "ps ok $(echo "$p" | grep -c "[c]om.android.commands.am.Am instrument")"; fi; '
  + 'if a=$(dumpsys activity processes); then case "$a" in *"ACTIVITY MANAGER RUNNING PROCESSES"*) echo "instr ok $(echo "$a" | grep "Instrumentation #" | grep -vc " FINISHED ")";; esac; fi';
function parseGuestActivity(out: string | undefined): { error?: string; instrumenting?: boolean; lastInputAgoMs?: number } {
  if (out === undefined) return { error: 'the phone didn’t answer' };
  const ps = /^ps ok (\d+)\s*$/m.exec(out), instr = /^instr ok (\d+)\s*$/m.exec(out);
  if (!ps) return { error: 'it didn’t list its processes' };
  if (!instr) return { error: 'it didn’t list its active test runs' };
  if (Number(ps[1]) > 0 || Number(instr[1]) > 0) return { instrumenting: true };
  const ago = /lastUserActivityTime=.*\((\d+) ms ago\)/.exec(out)?.[1];
  if (ago === undefined) return { error: 'it didn’t say when it was last used' };
  return { lastInputAgoMs: Number(ago) };
}
/** A resumed phone keeps its old time until its modem corrects it (a virtual phone often boots without one): set it from
 *  the Mac's clock (`cmd alarm set-time`, allowed to the shell user). */
async function setGuestClock(serial: string): Promise<{ skewSec: number; set: boolean; error?: string }> {
  const read = async () => {
    const r = await A.adb(serial, ['shell', 'date', '+%s'], { allowFail: true, timeoutMs: 10_000 });
    const g = Number.parseInt(r.stdout.trim(), 10);
    return Number.isFinite(g) ? g - Math.round(Date.now() / 1000) : NaN;
  };
  const skew = await read();
  if (!Number.isFinite(skew)) return { skewSec: 0, set: false, error: 'could not read the phone’s clock' };
  if (Math.abs(skew) <= 2) return { skewSec: skew, set: false };
  await A.adb(serial, ['shell', 'cmd', 'alarm', 'set-time', String(Date.now())], { allowFail: true, timeoutMs: 10_000 });
  const after = await read();
  return Number.isFinite(after) && Math.abs(after) <= 2 ? { skewSec: skew, set: true } : { skewSec: skew, set: false, error: `the clock is still ${after} s off after setting it` };
}
interface Proc { pid: number; ppid: number; args: string }
let processCache: { at: number; list: Promise<{ ok: boolean; list: Proc[] }> } | undefined;
/** `ps` once every few seconds, shared by every check in that time. `ok: false` when it couldn't be read. */
function processList(): Promise<{ ok: boolean; list: Proc[] }> {
  if (processCache && Date.now() - processCache.at < 3000) return processCache.list;
  const list = run('/bin/ps', ['-axww', '-o', 'pid=,ppid=,args='], { allowFail: true, timeoutMs: 10_000 }).then((r) => {
    const procs = r.stdout.split('\n').map((l) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
      return m ? { pid: Number(m[1]), ppid: Number(m[2]), args: m[3] } : undefined;
    }).filter((x): x is Proc => !!x);
    return { ok: r.code === 0 && procs.length > 0, list: procs };
  }, () => ({ ok: false, list: [] as Proc[] }));
  processCache = { at: Date.now(), list };
  return list;
}
/** Started (directly or not) by process `root`: this daemon's own adb commands are not someone else's session. */
function descendsFrom(p: Proc, root: number, all: Proc[]): boolean {
  const parent = new Map(all.map((x) => [x.pid, x.ppid]));
  let cur: number | undefined = p.ppid;
  for (let i = 0; i < 32 && cur && cur > 1; i++) { if (cur === root) return true; cur = parent.get(cur); }
  return false;
}
/** adb commands aimed at no device (the adb server among them), and the read-only probes PhoneDock's inventory makes. */
const ADB_NOT_USE = /^(devices|start-server|kill-server|version|help|connect|disconnect|pair|mdns|keygen|track-devices|fork-server|server|nodaemon|get-state|get-serialno|get-devpath)$/;
/** An adb command someone runs that may be on this emulator (a session, a push or pull, an install, or one PhoneDock
 *  doesn't know: unknown means in use): its subcommand, else undefined. PhoneDock's own (the live view's screenrecord
 *  and logcat watcher, also orphaned by a daemon that died; its inventory's `emu avd name|path`) are not. */
export function adbSessionOn(args: string, serial: string): string | undefined {
  if (/ logcat -T 1 -v brief -s ScreenRecord:D PowerManagerService:I(\s|$)/.test(args) || / exec-out screenrecord --output-format=h264 /.test(args)) return undefined;
  const w = args.split(/\s+/);
  const i = w.findIndex((x) => /(^|\/)adb$/.test(x));
  if (i < 0) return undefined;
  // Its device: `-s <serial>`; `-d` is USB. `-e` (an emulator), `-t <id>` or none (`$ANDROID_SERIAL`, or the only
  // device) may be this one, so they count: unknown means in use.
  let j = i + 1, target: string | undefined;
  for (; j < w.length && w[j].startsWith('-'); j++) {
    if (w[j] === '-s') target = w[++j] ?? '';
    else if (w[j] === '-d') target = '';
    else if (['-t', '-H', '-P', '-L'].includes(w[j])) j++;
  }
  if (target !== undefined && target !== serial) return undefined;
  const cmd = w[j];
  if (!cmd || ADB_NOT_USE.test(cmd) || (cmd === 'emu' && w[j + 1] === 'avd' && /^(name|path)$/.test(w[j + 2] ?? ''))) return undefined;
  return cmd;
}
/** Use on the Mac that PhoneDock's own requests don't show: the emulator's own window, scrcpy, someone's adb command. */
function hostActivity(ps: Proc[], proc: Proc, s: string): string | undefined {
  if (!hasArg(proc.args, '-no-window')) return 'its emulator window is open';
  if (ps.some((x) => scrcpyOn(x.args, s))) return 'it is open in a separate window';
  const session = ps.find((x) => adbSessionOn(x.args, s) && !descendsFrom(x, process.pid, ps));
  return session ? `an adb session may be open on it (${adbSessionOn(session.args, s)})` : undefined;
}
/** Whether a scrcpy process may be showing this emulator: `-s`/`--serial` naming it, or no selector (`$ANDROID_SERIAL`,
 *  or the only device). `-d` and `-e` pick a USB or a TCP/IP device, never an emulator. */
export function scrcpyOn(args: string, serial: string): boolean {
  const w = args.split(/\s+/);
  const i = w.findIndex((x) => /(^|\/)scrcpy$/.test(x));
  if (i < 0) return false;
  let sel: string | undefined;
  for (let j = i + 1; j < w.length; j++) {
    if (w[j] === '-s' || w[j] === '--serial') sel = w[++j] ?? '';
    else if (w[j].startsWith('--serial=')) sel = w[j].slice(9);
    else if (/^-s./.test(w[j])) sel = w[j].slice(2);
    else if (/^(-d|-e|--select-usb|--select-tcpip)$/.test(w[j]) || w[j].startsWith('--tcpip')) sel = '';
  }
  return sel === undefined || sel === serial;
}
/** A sleeping id whose own AVD is gone: never act on a same-named one instead. */
const sleepingAvdGone = (name: string) => new PhoneDockError(`PhoneDock's emulator "${name}" is gone`, 'not_found', 404,
  ['It was deleted or moved outside PhoneDock while it slept.'], `The AVD that went to sleep as "${name}" is no longer where it was`);
const hasArg = (args: string, a: string) => (' ' + args + ' ').includes(` ${a} `);
const hasArgPair = (args: string, a: string, v: string) => (' ' + args + ' ').includes(` ${a} ${v} `);
const isEmulatorArgs = (args: string) => /(^|\/)(qemu-system-[\w-]+|emulator)(\s|$)/.test(args.split(' -')[0] + ' ');
/** This AVD's emulator process: with a serial, the one on that console port; else any of that AVD name.
 *  undefined: positively none; null: can't tell. */
async function emulatorProcessOf(name: string, serial?: string): Promise<Proc | undefined | null> {
  const ps = await processList();
  if (!ps.ok) return null;
  const port = serial?.replace(/^emulator-/, '');
  const mine = ps.list.filter((x) => isEmulatorArgs(x.args) && hasArgPair(x.args, '-avd', name));
  return port ? mine.find((x) => hasArgPair(x.args, '-port', port)) : mine[0];
}
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}
/** Space a snapshot takes on disk (ram.bin is a sparse file as big as the guest's RAM: count allocated blocks). */
function snapshotDiskMB(dir: string): number {
  let bytes = 0;
  for (const f of readdirSync(dir)) { try { bytes += statSync(join(dir, f)).blocks * 512; } catch { /* */ } }
  return Math.round(bytes / (1024 * 1024));
}

/** A clear error for what `adb emu avd snapshot <op>` printed when it failed. */
export function snapshotFailure(op: 'save' | 'load' | 'del', output: string): PhoneDockError {
  const out = output.trim();
  const verb = op === 'save' ? 'save' : op === 'load' ? 'restore' : 'delete';
  if (/UNSUPPORTED_VK_APP|UNSUPPORTED_VK_API|Cannot stop Vulkan/i.test(out)) {
    return new PhoneDockError(`Couldn’t ${verb} the snapshot`, 'snapshot_vulkan', 409, [
      'This emulator can’t save a snapshot after an app used Vulkan graphics (Chrome does).',
      'Restart the phone, then save before opening that app.',
    ], `snapshot ${op} failed: ${out}`);
  }
  if (/different emulator features|missing in the snapshot/i.test(out)) {
    return new PhoneDockError('Couldn’t restore the snapshot', 'snapshot_incompatible', 409, [
      'This snapshot was saved with different graphics settings than the phone is running with.',
      'Restart the phone and restore again, or set PHONEDOCK_EMULATOR_VULKAN=1 (or 0) for the PhoneDock service so it matches the snapshot.',
    ], `snapshot ${op} failed: ${out}`);
  }
  if (/not found|No snapshot/i.test(out)) return new PhoneDockError('Couldn’t find that snapshot', 'not_found', 404, ['Check the list of snapshots.'], `snapshot ${op} failed: ${out}`);
  if (/already exists/i.test(out)) return new PhoneDockError('A snapshot with that name already exists', 'conflict', 409, ['Choose another name, or delete the old snapshot first.'], `snapshot ${op} failed: ${out}`);
  return new PhoneDockError(`Couldn’t ${verb} the snapshot`, 'snapshot_failed', 500, ['Wait a few seconds and try again; if it keeps failing, restart the phone.'], `snapshot ${op} failed: ${out}`);
}
async function emuSnapshot(name: string, op: 'save' | 'load' | 'del', snap: string) {
  const s = await consoleSerial(name);
  if (!s) throw new PhoneDockError(`Emulator "${name}" is not running.`, 'not_running', 409, ['Start the emulator first.'], 'Stopped devices can only list or delete snapshots');
  const sn = sanitizeName(snap);
  const r = await A.adb(s, ['emu', 'avd', 'snapshot', op === 'del' ? 'delete' : op, sn], { allowFail: true, timeoutMs: 180_000 });
  if (!/^OK/m.test(r.stdout) || /KO/.test(r.stdout)) throw snapshotFailure(op, r.stdout + r.stderr);
}
function tail(file: string): string {
  try { const t = readFileSync(file, 'utf8'); return t.slice(-600).replace(/\s+/g, ' '); } catch { return ''; }
}

