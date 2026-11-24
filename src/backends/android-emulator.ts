// Android Emulator backend. Managed AVDs live in ANDROID_AVD_HOME=stateDir('avd'), isolated from the
// user's ~/.android/avd (those are listed read-only as managed=false and never modified).
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, closeSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
async function runningEmulators(): Promise<Running[]> {
  const devs = (await A.adbDevices()).filter((d) => /^emulator-\d+$/.test(d.serial));
  const live = new Set(devs.map((d) => d.serial));
  for (const k of serialCache.keys()) if (!live.has(k)) serialCache.delete(k);
  return Promise.all(devs.map(async (d) => {
    let c = serialCache.get(d.serial);
    if (!c || Date.now() - c.at > 60_000) {
      const [n, p] = await Promise.all([
        A.adb(d.serial, ['emu', 'avd', 'name'], { allowFail: true, timeoutMs: 5000 }),
        A.adb(d.serial, ['emu', 'avd', 'path'], { allowFail: true, timeoutMs: 5000 }),
      ]);
      const name = n.stdout.split('\n')[0].trim(); const path = p.stdout.split('\n')[0].trim();
      if (name && name !== 'KO') { c = { name, path, at: Date.now() }; serialCache.set(d.serial, c); }
    }
    return { serial: d.serial, state: d.state, name: c?.name ?? '', path: c?.path ?? '' };
  }));
}
async function serialFor(name: string): Promise<string | undefined> {
  const a = findAvd(name);
  const r = (await runningEmulators()).filter((e) => e.name === name);
  if (r.length > 1 && a) return (r.find((e) => e.path && e.path.replace(/\/$/, '') === a.avdDir.replace(/\/$/, '')) ?? r[0]).serial;
  return r[0]?.serial;
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
    const byPath = (a: AvdEntry) => running.find((r) => r.path && r.path.replace(/\/$/, '') === a.avdDir.replace(/\/$/, '')) ?? running.find((r) => r.name === a.name && !r.path);
    return [...managed, ...user].map((a) => toDevice(a, byPath(a)));
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
    await bootAvd(name, opts);
  },

  async shutdown(name: string) {
    const s = await serialFor(name);
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
  async saveSnapshot(name: string, snap: string) { await emuSnapshot(name, 'save', snap); },
  async restoreSnapshot(name: string, snap: string) {
    await emuSnapshot(name, 'load', snap);
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
    const s = await serialFor(name);
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
  // ── idle sleep (src/daemon/idle-sleep.ts) ──
  async saveSleep(name: string): Promise<SleepState> {
    const a = requireAvd(name);
    if (!a.managed) throw new PhoneDockError('PhoneDock only puts phones it created to sleep', 'forbidden', 403, undefined, `"${name}" lives in ${a.home}, outside PhoneDock's own emulators`);
    const s = await requireSerial(name);
    const id = await guestIdentity(s);
    const t0 = Date.now();
    await emuSnapshot(name, 'save', SLEEP_SNAPSHOT);
    // The console said OK; check the files are really there and new before anything stops the phone.
    const dir = join(a.avdDir, 'snapshots', SLEEP_SNAPSHOT);
    let written = false;
    try {
      const pb = statSync(join(dir, 'snapshot.pb')), ram = statSync(join(dir, 'ram.bin'));
      written = pb.mtimeMs >= t0 - 2000 && ram.size > 0;
    } catch { /* missing */ }
    if (!written) throw new PhoneDockError('Couldn’t save the phone’s state', 'snapshot_failed', 500, ['It keeps running; PhoneDock tries again after it has been idle for another while.'], `${dir}: snapshot.pb or ram.bin missing or older than the save`);
    return { snapshot: SLEEP_SNAPSHOT, savedAt: new Date(t0).toISOString(), ...id };
  },

  async stopAfterSleep(name: string): Promise<void> {
    const s = await serialFor(name);
    if (!s) return;
    const pid = (await emulatorProcess(name))?.pid ?? children.get(name)?.pid;
    // The emulator saves its own quick-boot state on the way out (a few seconds); its memory is free only once the
    // process is gone, not when adb drops the serial.
    await A.adb(s, ['emu', 'kill'], { allowFail: true, timeoutMs: 10_000 });
    const deadline = Date.now() + 180_000;
    if (pid) {
      while (Date.now() < deadline && processAlive(pid)) await sleep(250);
      if (processAlive(pid)) throw new PhoneDockError('The phone didn’t stop', 'sleep_failed', 500, ['Shut it down from PhoneDock, or quit the emulator process.'], `emulator pid ${pid} still running 180 s after emu kill`);
    }
    // adb lists the serial for a moment after the process is gone: wait, so the device list says stopped at once.
    const adbDeadline = Date.now() + (pid ? 15_000 : 180_000);
    while (Date.now() < adbDeadline && (await A.adbDevices().catch(() => [])).some((d) => d.serial === s)) await sleep(250);
    processCache = undefined;
    serialCache.delete(s);
  },

  async wakeFromSleep(name: string, saved: SleepState, opts: { onProgress?: (l: string) => void } = {}): Promise<WakeReport> {
    const p = opts.onProgress;
    const started = await bootAvd(name, { headless: true, onProgress: p });
    const s = await requireSerial(name);
    let report: WakeReport;
    if (started.coldBoot) {
      // A virtual phone whose disguise changed (a PhoneDock update) must start cold, or the saved state would bring
      // the old identity back. Its apps and data are kept; what was open is not.
      report = { resumed: false, via: 'cold', note: 'This virtual phone’s setup changed in this PhoneDock version, so it started fresh (apps and data are kept).' };
    } else if (resumedFrom(await guestIdentity(s).catch(() => ({})), saved)) {
      report = { resumed: true, via: 'quickboot' };
    } else if (started.alreadyRunning) {
      // Someone started it while it slept (another tool, or an older PhoneDock): it may be in use. Leave it as it is.
      report = { resumed: false, via: 'cold', note: 'It was started elsewhere while it slept, so it kept the state it has now.' };
    } else {
      // The quick-boot state the emulator saved on its way out didn't load (or was older): load the one PhoneDock
      // saved and checked before it stopped the phone.
      p?.('loading the state saved before it slept');
      await emuSnapshot(name, 'load', SLEEP_SNAPSHOT);
      await A.waitBootCompleted(s, 60_000).catch(() => undefined);
      await A.adb(s, ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], { allowFail: true });
      await A.adb(s, ['shell', 'wm', 'dismiss-keyguard'], { allowFail: true });
      report = resumedFrom(await guestIdentity(s).catch(() => ({})), saved)
        ? { resumed: true, via: 'snapshot' }
        : { resumed: false, via: 'cold', note: 'The saved state didn’t load, so the phone started fresh (apps and data are kept).' };
    }
    await emuSnapshot(name, 'del', SLEEP_SNAPSHOT).catch(() => undefined);   // ~3 GB per phone on disk: not kept
    report.clock = await setGuestClock(s);
    return report;
  },

  async discardSleep(name: string): Promise<void> {
    try {
      if (await serialFor(name)) { await emuSnapshot(name, 'del', SLEEP_SNAPSHOT); return; }
      const a = findAvd(name);
      if (a?.managed) rmSync(join(a.avdDir, 'snapshots', SLEEP_SNAPSHOT), { recursive: true, force: true });
    } catch { /* best effort */ }
  },

  async keepAwake(name: string): Promise<string | undefined> {
    // The person may be using the phone where PhoneDock sees no input: the emulator's own window, or scrcpy.
    const proc = await emulatorProcess(name);
    if (proc && !hasArg(proc.args, '-no-window')) return 'its emulator window is open';
    const s = await serialFor(name).catch(() => undefined);
    if (s && (await processes()).some((x) => /(^|\/)scrcpy(\s|$)/.test(x.args) && hasArgPair(x.args, '-s', s))) return 'it is open in a separate window';
    return undefined;
  },
};

/** Boot an AVD (backend.boot). `coldBoot`: it started without its quick-boot state (asked for, or forced because a
 *  virtual phone's disguise changed). */
async function bootAvd(name: string, opts: BootOptions & { onProgress?: (l: string) => void } = {}): Promise<{ coldBoot: boolean; alreadyRunning?: boolean }> {
  const a = requireAvd(name);
  const p = opts.onProgress;
  if (await serialFor(name)) { p?.('already running'); return { coldBoot: false, alreadyRunning: true }; }
  if (booting.has(name)) throw new PhoneDockError(`"${name}" is already booting`, 'busy', 409);
  booting.set(name, Date.now());
  let port = 0; let coldBoot = false;
  try {
    const disguiseBoot = await resolveDisguiseBoot(a, {
      adbBin: A.adbPath(),
      sdkRootDir: A.sdkRoot(),
      onProgress: p,
      withBootstrapSerial: (fn) => runTransientBootstrap(a, p, fn),
    });
    coldBoot = !!(opts.coldBoot || disguiseBoot?.forceColdBoot);
    port = await pickPort(); reservedPorts.add(port);
    const headless = opts.window ? false : opts.headless ?? true;
    const args = ['-avd', name, '-port', String(port), '-no-audio', '-no-boot-anim'];
    if (headless) args.push('-no-window');
    // Headless defaults to SwiftShader (software GL) which makes screencap/streaming CPU-bound.
    // Host GPU (Metal via gfxstream) works headless on Apple Silicon; override with PHONEDOCK_EMULATOR_GPU.
    args.push('-gpu', process.env.PHONEDOCK_EMULATOR_GPU ?? 'host');
    if (coldBoot) args.push('-no-snapshot-load');
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
    return { coldBoot };
  } finally {
    booting.delete(name);
    if (port) reservedPorts.delete(port);
  }
}

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
/** The state PhoneDock saves before it puts an idle phone to sleep (saveSleep): not the person's either. */
export const SLEEP_SNAPSHOT = 'phonedock_sleep';
function userSnapshotNames(avdDir: string): string[] { return safeLs(join(avdDir, 'snapshots')).filter((n) => n !== INTERNAL_SNAPSHOT && n !== SLEEP_SNAPSHOT); }

// ── idle sleep helpers ───────────────────────────────────────────────────────
/** Who the guest is right now: its kernel boot id and uptime. A guest resumed from a save has the same boot id and is
 *  at least as old as it was just before the save; a cold boot (or an older quick-boot state) is not. */
async function guestIdentity(serial: string): Promise<{ bootId?: string; uptimeSec?: number }> {
  const r = await A.adb(serial, ['shell', 'cat', '/proc/sys/kernel/random/boot_id', '/proc/uptime'], { allowFail: true, timeoutMs: 10_000 });
  const [boot, up] = r.stdout.trim().split('\n').map((l) => l.trim());
  const uptimeSec = Number.parseFloat(up ?? '');
  return { ...(/^[0-9a-f-]{36}$/.test(boot ?? '') ? { bootId: boot } : {}), ...(Number.isFinite(uptimeSec) ? { uptimeSec } : {}) };
}
export function resumedFrom(now: { bootId?: string; uptimeSec?: number }, saved: Pick<SleepState, 'bootId' | 'uptimeSec'>): boolean {
  if (!saved.bootId || now.bootId !== saved.bootId) return false;
  return saved.uptimeSec === undefined || (now.uptimeSec ?? -1) >= saved.uptimeSec - 1;
}
/** A phone resumed from a save keeps the time it had then until something corrects it. The emulator corrects it only
 *  through its modem, which a virtual phone often boots without, so set it from the Mac's clock. The shell user may
 *  (`cmd alarm set-time`, AlarmManager's shell command); no root needed. */
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
interface Proc { pid: number; args: string }
let processCache: { at: number; list: Promise<Proc[]> } | undefined;
/** `ps` once every few seconds, shared by every check in that time. */
function processes(): Promise<Proc[]> {
  if (processCache && Date.now() - processCache.at < 3000) return processCache.list;
  const list = run('/bin/ps', ['-axww', '-o', 'pid=,args='], { allowFail: true, timeoutMs: 10_000 }).then((r) => r.stdout.split('\n').map((l) => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(l);
    return m ? { pid: Number(m[1]), args: m[2] } : undefined;
  }).filter((x): x is Proc => !!x), () => [] as Proc[]);
  processCache = { at: Date.now(), list };
  return list;
}
const hasArg = (args: string, a: string) => (' ' + args + ' ').includes(` ${a} `);
const hasArgPair = (args: string, a: string, v: string) => (' ' + args + ' ').includes(` ${a} ${v} `);
/** The emulator (qemu) process running this AVD, if any. */
async function emulatorProcess(name: string): Promise<Proc | undefined> {
  return (await processes()).find((x) => /(^|\/)(qemu-system-[\w-]+|emulator)(\s|$)/.test(x.args.split(' -')[0] + ' ') && hasArgPair(x.args, '-avd', name));
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
  const s = await serialFor(name);
  if (!s) throw new PhoneDockError(`Emulator "${name}" is not running.`, 'not_running', 409, ['Start the emulator first.'], 'Stopped devices can only list or delete snapshots');
  const sn = sanitizeName(snap);
  const r = await A.adb(s, ['emu', 'avd', 'snapshot', op === 'del' ? 'delete' : op, sn], { allowFail: true, timeoutMs: 180_000 });
  if (!/^OK/m.test(r.stdout) || /KO/.test(r.stdout)) throw snapshotFailure(op, r.stdout + r.stderr);
}
function tail(file: string): string {
  try { const t = readFileSync(file, 'utf8'); return t.slice(-600).replace(/\s+/g, ' '); } catch { return ''; }
}

