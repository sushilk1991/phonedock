// iOS Simulator backend: CoreSimulator via `xcrun simctl` (always with toolEnv() so DEVELOPER_DIR points at
// Xcode) + AXe (https://github.com/cameroncooke/AXe) for HID input, accessibility tree and video frames.
//
// Coordinates: the contract uses screenshot pixels; simctl/AXe use points. points = pixels / scale.
// Hardware back does not exist on iOS: key('back') is emulated with a left-edge swipe (x=2pt → 60% width).
// rotate uses Xcode's `devicectl device orientation` (CoreDevice; simulators included). AXe streams the panel in its
// natural (portrait) orientation, so a landscape stream is turned upright with ffmpeg; simctl screenshots are upright.
// pinch is not offered: AXe has no multi-touch. hideKeyboard is not offered: there is no reliable dismissal
// (HID keyboard events make the simulator assume a hardware keyboard and hide the software one, stickily).
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, cpSync, renameSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { run, runBuffer, sleep, waitFor, type RunOptions } from '../core/exec.ts';
import { developerDir, stateDir, toolEnv, which } from '../core/paths.ts';
import {
  PhoneDockError,
  type AppInfo, type Availability, type Backend, type BootOptions, type Capability, type CrashReport, type Device, type DeviceSpec,
  type DeviceState, type ExecResult, type FrameStream, type HardwareProfile, type KeyName, type OsImage,
  type Orientation, type ScreenInfo, type Snapshot, type UiElement, type UiTree,
} from '../core/types.ts';
import {
  JpegSplitter, JsonState, ffmpegBin, finalizeMp4, ipsKind, ipsRender, ipsSummary, ipsTime, parseIps, pngSize, probeVideo, splitArgs, type IpsReport,
} from './ios-common.ts';
import { abortXctrace, parseLaunchctlPid, startXctrace, stopXctrace } from './ios-trace.ts';

const ID = 'ios-simulator';

const CAPS: Capability[] = [
  'boot', 'shutdown', 'delete', 'clone', 'snapshot', 'screenshot', 'stream', 'uiTree', 'ocr',
  'tap', 'longPress', 'swipe', 'type', 'key', 'install', 'apps', 'launch', 'openUrl',
  'shell', 'files', 'logs', 'location', 'push', 'clipboard', 'window',
  'doubleTap', 'record', 'crashes', 'appData', 'appearance', 'rotate', 'trace',
];

interface ManagedEntry { name: string; createdAt: string; spec?: Partial<DeviceSpec>; clonedFrom?: string }
interface StateFile {
  devices?: Record<string, ManagedEntry>;
  /** Runtimes a create failed on with "runtime is not available" (simctl still lists them as available). */
  unusableRuntimes?: Record<string, { build?: string; reason: string; at: string }>;
}
const state = new JsonState<StateFile>('ios-simulator.json');

interface SimDevice {
  udid: string; name: string; state: string; isAvailable?: boolean; deviceTypeIdentifier?: string;
  dataPath?: string; logPath?: string; lastBootedAt?: string; availabilityError?: string;
}
interface SimRuntime {
  identifier: string; version: string; buildversion?: string; name: string; platform?: string;
  isAvailable?: boolean; bundlePath?: string; runtimeRoot?: string; supportedDeviceTypes?: { identifier: string; name: string; productFamily?: string }[];
}
interface SimDeviceType { identifier: string; name: string; productFamily?: string; modelIdentifier?: string; bundlePath?: string }

// ── subprocess helpers ─────────────────────────────────────────────────────

function simctl(args: string[], opts: RunOptions = {}) {
  return run('xcrun', ['simctl', ...args], { env: toolEnv(), failureMessage: 'Couldn’t complete the simulator action', ...opts });
}

/** simctl create failures that have a clear fix get plain words; the raw simctl output stays in `detail`. */
function createError(e: unknown, runtimeName: string): unknown {
  if (!(e instanceof PhoneDockError)) return e;
  const raw = e.detail ?? '';
  // Seen when a runtime is registered but its disk image is missing or unmounted (simctl still lists it as available).
  if (/runtime is not available|runtime path not found/i.test(raw)) {
    return new PhoneDockError(`${runtimeName} isn’t ready to use on this Mac`, 'no_image', 409,
      [`Download ${runtimeName} again in Xcode › Settings › Components, or choose another iOS version.`], raw);
  }
  if (/Invalid device type|incompatible device/i.test(raw)) {
    return new PhoneDockError(`That iPhone model can’t run ${runtimeName}`, 'bad_request', 400,
      ['Choose another model, or another iOS version.'], raw);
  }
  return e;
}

/** Whether a registered runtime can really create devices. simctl lists some as available when their disk image is
 *  missing; only creating a device finds out. One throwaway probe per runtime build, remembered while the service runs. */
const probeCache = new Map<string, Promise<boolean>>();
function runtimeUsable(rt: SimRuntime): Promise<boolean> {
  const key = `${rt.identifier}|${rt.buildversion ?? ''}`;
  let p = probeCache.get(key);
  if (!p) {
    p = (async () => {
      const types = rt.supportedDeviceTypes?.filter((t) => t.productFamily === 'iPhone') ?? [];
      if (!types.length) return true;   // can't tell: assume it works
      let udid: string | undefined;
      try {
        udid = (await simctl(['create', `phonedock-probe-${process.pid}`, types.at(-1)!.identifier, rt.identifier])).stdout.trim();
        return true;
      } catch (e) {
        const detail = e instanceof PhoneDockError ? e.detail ?? '' : String(e);
        return !/runtime is not available|runtime path not found|Unable to create a device/i.test(detail);
      } finally {
        if (udid) await simctl(['delete', udid]).catch(() => undefined);
      }
    })();
    probeCache.set(key, p);
  }
  return p;
}

function axePath(): string {
  const p = process.env.PHONEDOCK_AXE ?? which('axe');
  if (!p) throw new PhoneDockError('Simulator controls are not installed', 'not_supported', 501,
    ['Install the simulator controls first.'], 'Install AXe: brew install cameroncooke/axe/axe');
  return p;
}

function axe(args: string[], opts: RunOptions = {}) {
  return run(axePath(), args, { env: toolEnv(), timeoutMs: 30_000, failureMessage: 'Couldn’t control the simulator', ...opts });
}

/** Map an exec failure to a nicer error. */
function wrapAxeError(e: unknown, what: string): never {
  const msg = (e as PhoneDockError).detail ?? (e as Error).message ?? String(e);
  if (/not booted|Shutdown|No booted|state: Shutdown/i.test(msg)) {
    throw new PhoneDockError('Simulator is not running', 'not_running', 409, ['Boot the device first'], msg);
  }
  throw new PhoneDockError('Couldn’t control the simulator', 'input_failed', 500, undefined, `${what}: ${msg}`);
}

// ── inventory ──────────────────────────────────────────────────────────────

let runtimeCache: { at: number; list: SimRuntime[] } | undefined;
async function runtimes(force = false): Promise<SimRuntime[]> {
  if (!force && runtimeCache && Date.now() - runtimeCache.at < 60_000) return runtimeCache.list;
  const r = await simctl(['list', '-j', 'runtimes']);
  const list = (JSON.parse(r.stdout).runtimes ?? []) as SimRuntime[];
  runtimeCache = { at: Date.now(), list };
  return list;
}

/** Runtimes that can't be used, by identifier → why: the disk image isn't Ready (`simctl runtime list`), or creating a
 *  simulator on it failed with "runtime is not available" on this build (blind run 1: iOS 27.0 listed as installed). */
async function unusableRuntimes(rts: SimRuntime[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const r = await simctl(['runtime', 'list', '-j'], { allowFail: true, timeoutMs: 20_000 }).catch(() => undefined);
  try {
    for (const img of Object.values(JSON.parse(r?.stdout || '{}')) as { runtimeIdentifier?: string; state?: string; unusableReason?: unknown }[]) {
      if (img?.runtimeIdentifier && img.state && img.state !== 'Ready') out.set(img.runtimeIdentifier, `its disk image is ${img.state}${img.unusableReason ? ` (${String(img.unusableReason)})` : ''}`);
    }
  } catch { /* older Xcode: no `simctl runtime` */ }
  const learned = state.read().unusableRuntimes ?? {};
  for (const rt of rts) {
    const u = learned[rt.identifier];
    if (u && (!u.build || u.build === rt.buildversion) && !out.has(rt.identifier)) out.set(rt.identifier, `creating a simulator on it failed (${u.reason}) on ${u.at.slice(0, 10)}`);
  }
  return out;
}

let devtypeCache: SimDeviceType[] | undefined;
async function deviceTypes(): Promise<SimDeviceType[]> {
  if (devtypeCache) return devtypeCache;
  const r = await simctl(['list', '-j', 'devicetypes']);
  devtypeCache = (JSON.parse(r.stdout).devicetypes ?? []) as SimDeviceType[];
  return devtypeCache;
}

async function rawDevices(): Promise<{ runtime: string; dev: SimDevice }[]> {
  const r = await simctl(['list', '-j', 'devices']);
  const byRt = (JSON.parse(r.stdout).devices ?? {}) as Record<string, SimDevice[]>;
  const out: { runtime: string; dev: SimDevice }[] = [];
  for (const [rt, devs] of Object.entries(byRt)) for (const d of devs) out.push({ runtime: rt, dev: d });
  return out;
}

const isIosRuntime = (rt: string) => /SimRuntime\.(iOS|iPadOS)-/i.test(rt);

const booting = new Set<string>();                       // udids we're booting (simctl says Booted too early)
const screenCache = new Map<string, ScreenInfo>();      // live: the screen as it is turned now (booted simulators)
// Each simulator's natural (portrait) screen, kept across shutdowns, restores and daemon restarts so Device.screen is
// always known; the live cache refines it (orientation) once the simulator is up.
const screenStore = new JsonState<Record<string, ScreenInfo>>('ios-simulator-screens.json');

function mapState(s: string, udid: string): DeviceState {
  if (booting.has(udid)) return 'booting';
  switch (s) {
    case 'Booted': return 'running';
    case 'Shutdown': return 'stopped';
    case 'Booting': return 'booting';
    case 'Shutting Down': return 'stopping';
    case 'Creating': return 'creating';
    default: return 'unknown';
  }
}

/** "iOS 26.5 (23F77)", like Android's "Android 16 (API 36)". */
function rtVersion(rt: string, list: SimRuntime[]): string | undefined {
  const hit = list.find((r) => r.identifier === rt);
  if (hit) return `iOS ${hit.version}${hit.buildversion ? ` (${hit.buildversion})` : ''}`;
  const m = rt.match(/-(\d+)-(\d+)(?:-(\d+))?$/);
  return m ? `iOS ${[m[1], m[2], m[3]].filter(Boolean).join('.')}` : undefined;
}

async function toDevice(runtime: string, d: SimDevice, rts: SimRuntime[], types: SimDeviceType[], managed: Record<string, ManagedEntry>): Promise<Device> {
  const dt = types.find((t) => t.identifier === d.deviceTypeIdentifier);
  const m = managed[d.udid];
  const st = mapState(d.state, d.udid);
  return {
    id: `${ID}:${d.udid}`,
    backend: ID,
    nativeId: d.udid,
    name: d.name,
    platform: 'ios',
    kind: 'virtual',
    state: st,
    managed: !!m,
    osVersion: rtVersion(runtime, rts),
    model: dt?.name,
    connection: 'local',
    screen: (st === 'running' ? screenCache.get(d.udid) : undefined) ?? naturalScreen(d.udid),
    spec: m?.spec ?? { backend: ID, name: d.name, image: runtime, profile: d.deviceTypeIdentifier },
    capabilities: (m ? CAPS : CAPS.filter((c) => c !== 'snapshot' && c !== 'delete')).filter((c) => c !== 'rotate' || canRotate),
    meta: {
      runtime, deviceType: d.deviceTypeIdentifier, family: dt?.productFamily, modelIdentifier: dt?.modelIdentifier,
      dataPath: d.dataPath, lastBootedAt: d.lastBootedAt, ...(m?.clonedFrom ? { clonedFrom: m.clonedFrom } : {}),
    },
  };
}

async function findSim(udid: string): Promise<{ runtime: string; dev: SimDevice }> {
  const hit = (await rawDevices()).find((x) => x.dev.udid === udid);
  if (!hit) throw new PhoneDockError('Couldn’t find the simulator', 'not_found', 404, undefined, `No simulator with UDID ${udid}`);
  return hit;
}

async function getDevice(udid: string): Promise<Device> {
  const [{ runtime, dev }, rts, types] = await Promise.all([findSim(udid), runtimes(), deviceTypes()]);
  return toDevice(runtime, dev, rts, types, state.read().devices ?? {});
}

function managedOrThrow(udid: string, what: string): ManagedEntry {
  const m = state.read().devices?.[udid];
  if (!m) throw new PhoneDockError('This action is only allowed on simulators created by PhoneDock', 'forbidden', 403,
    ['Create or clone a simulator first.'], `${what} requires a managed simulator. Create one with POST /v1/devices or clone this one.`);
  return m;
}

async function isBooted(udid: string): Promise<boolean> { return (await findSim(udid)).dev.state === 'Booted'; }

async function requireBooted(udid: string): Promise<void> {
  const { dev } = await findSim(udid);
  if (dev.state !== 'Booted') throw new PhoneDockError(`Simulator ${dev.name} is ${dev.state}, not running`, 'not_running', 409, ['Boot the device first']);
}

function dataDir(udid: string): string {
  return join(homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices', udid, 'data');
}

// ── screen geometry ────────────────────────────────────────────────────────

async function screenshotPng(udid: string): Promise<Buffer> {
  // Always use a private temp file: `simctl io screenshot -` is not reliably stdout — it has been seen
  // creating a literal file named "-" in the daemon's working directory.
  const dir = mkdtempSync(join(tmpdir(), 'pd-sim-shot-'));
  try {
    const f = join(dir, 's.png');
    const r = await runBuffer('xcrun', ['simctl', 'io', udid, 'screenshot', '--type=png', f], { env: toolEnv(), timeoutMs: 30_000, allowFail: true, cwd: dir });
    if (r.code !== 0) {
      if (/Shutdown|not booted|Invalid device state/i.test(r.stderr)) throw new PhoneDockError('Simulator is not running', 'not_running', 409, ['Boot the device first'], r.stderr.trim());
      throw new PhoneDockError('Couldn’t take a screenshot', 'screenshot_failed', 500, undefined, `simctl screenshot failed: ${r.stderr.trim().slice(0, 500)}`);
    }
    return readFileSync(f);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export interface AxNode {
  type?: string; role?: string; role_description?: string; AXLabel?: string | null; AXValue?: string | null;
  AXUniqueId?: string | null; title?: string | null; frame?: { x: number; y: number; width: number; height: number };
  AXFrame?: string; enabled?: boolean; children?: AxNode[]; subrole?: string | null; help?: string | null;
  custom_actions?: string[]; content_required?: boolean; pid?: number;
}

function parseAx(out: string): AxNode[] {
  const start = out.search(/[[{]/);
  const parsed = JSON.parse(start > 0 ? out.slice(start) : out) as AxNode | AxNode[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function describeUi(udid: string, opts: { fillRows?: boolean } = {}): Promise<AxNode[]> {
  let out: string;
  try { out = (await axe(['describe-ui', '--udid', udid], { timeoutMs: 30_000 })).stdout; } catch (e) { wrapAxeError(e, 'describe-ui'); }
  const roots = parseAx(out);
  if (opts.fillRows) await fillEmptyRows(udid, roots);
  return roots;
}

const EMPTY_CONTAINER = /^(Group|Other|GenericElement)$/;
const MAX_POINT_QUERIES = 6;

/** The full describe-ui leaves some rows as empty containers: on iOS Settings › Developer the "Dark Appearance" and
 *  "Enable UI Automation" switch rows are bare Groups. A point query at such a row's centre returns the real element
 *  (a CheckBox "Dark Appearance" with its switch and value), so graft that in. About 0.1–0.4 s, in parallel, and only
 *  when the screen has such rows; anything still empty is left to the daemon's OCR fill. Mutates `roots`. */
async function fillEmptyRows(udid: string, roots: AxNode[]): Promise<void> {
  if (process.env.PHONEDOCK_IOS_POINT_QUERY === '0') return;
  await Promise.all(emptyRows(roots).slice(0, MAX_POINT_QUERIES).map(async ({ node, f, point }) => {
    try {
      const out = (await axe(['describe-ui', '--udid', udid, '--point', `${point.x},${point.y}`], { timeoutMs: 5000 })).stdout;
      const hit = rowHit(parseAx(out), f);
      if (hit) node.children = [hit];
    } catch { /* leave the gap; the daemon OCRs it */ }
  }));
}

type Frame = { x: number; y: number; width: number; height: number };

/** Row-sized, on-screen containers with nothing in them (no children, label or value), and the point to query. */
export function emptyRows(roots: AxNode[]): { node: AxNode; f: Frame; point: { x: number; y: number } }[] {
  const screen = roots.map(nodeFrame).find((f) => f && f.width > 0 && f.height > 0);
  if (!screen) return [];
  const gaps: { node: AxNode; f: Frame; point: { x: number; y: number } }[] = [];
  const labelled: Frame[] = [];
  const walk = (n: AxNode) => {
    const kids = n.children ?? [];
    const f = nodeFrame(n);
    if (f && f.width > 0 && f.height > 0 && (n.AXLabel || n.title)) labelled.push(f);
    if (f && !kids.length && EMPTY_CONTAINER.test(n.type ?? '') && !n.AXLabel && !n.title && (n.AXValue == null || n.AXValue === '')
      && f.height >= Math.max(22, screen.height * 0.025) && f.height <= screen.height * 0.4 && f.width >= screen.width * 0.25) {
      const x = Math.round(f.x + f.width / 2); const y = Math.round(f.y + f.height / 2);
      if (x > 0 && y > 0 && x < screen.width && y < screen.height) gaps.push({ node: n, f, point: { x, y } });
    }
    for (const k of kids) walk(k);
  };
  roots.forEach(walk);
  // a cell's background Group sits under the cell's own labelled button: that row isn't missing anything
  const covered = (g: Frame) => labelled.some((l) => {
    if (l.width * l.height > g.width * g.height * 1.5) return false;
    const cx = l.x + l.width / 2; const cy = l.y + l.height / 2;
    return cx >= g.x && cy >= g.y && cx <= g.x + g.width && cy <= g.y + g.height;
  });
  return gaps.filter((g) => !covered(g.f));
}

/** From a point query's result, the element that fills the row: inside the row's frame (not a container around
 *  it) and with something to say (a label, or labelled children). */
export function rowHit(hits: AxNode[], f: Frame): AxNode | undefined {
  return hits.find((h) => {
    const hf = nodeFrame(h);
    if (!hf || hf.width <= 0 || hf.height <= 0) return false;
    const inside = hf.x >= f.x - 2 && hf.y >= f.y - 2 && hf.x + hf.width <= f.x + f.width + 2 && hf.y + hf.height <= f.y + f.height + 2;
    return inside && !!(h.AXLabel || h.title || h.children?.some((k) => k.AXLabel || k.title));
  });
}

function nodeFrame(n: AxNode): { x: number; y: number; width: number; height: number } | undefined {
  if (n.frame && typeof n.frame.width === 'number') return n.frame;
  const m = n.AXFrame?.match(/\{\{([-\d.]+),\s*([-\d.]+)\},\s*\{([-\d.]+),\s*([-\d.]+)\}\}/);
  return m ? { x: +m[1], y: +m[2], width: +m[3], height: +m[4] } : undefined;
}

async function screenInfoOf(udid: string, refresh = false): Promise<ScreenInfo> {
  const cached = screenCache.get(udid);
  if (cached && !refresh) return cached;
  const png = await screenshotPng(udid);
  const info = await screenInfoFrom(udid, png);
  screenAt.set(udid, Date.now());
  return info;
}

async function screenInfoFrom(udid: string, png: Buffer, roots?: AxNode[]): Promise<ScreenInfo> {
  const { width, height } = pngSize(png);
  const cached = screenCache.get(udid);
  if (cached && cached.width === width && cached.height === height && cached.scale) return cached;
  // the same screen turned: the scale is known (natural size from earlier runs counts too)
  const known = cached ?? naturalScreen(udid);
  if (known?.scale && Math.min(width, height) === Math.min(known.width, known.height) && Math.max(width, height) === Math.max(known.width, known.height)) {
    return setScreen(udid, { width, height, scale: known.scale });
  }
  let scale: number | undefined;
  try {
    const r = roots ?? await describeUi(udid);
    const f = r.map(nodeFrame).find((x) => x && x.width > 0);
    if (f) {
      // the application frame spans the full screen in points (portrait or landscape)
      const s1 = width / f.width, s2 = height / f.height;
      scale = Math.round(((s1 + s2) / 2) * 100) / 100;
      if (Math.abs(s1 - s2) > 0.1) scale = Math.round(Math.max(s1, s2));
    }
  } catch { /* fall through */ }
  if (!scale || !isFinite(scale) || scale <= 0) scale = Math.min(width, height) >= 1500 ? 2 : 3; // iPad ≈2x, iPhone 3x
  return setScreen(udid, { width, height, scale });
}

const screenAt = new Map<string, number>();              // when the live screen was last confirmed
const turnWatchers = new Map<string, Set<() => void>>();  // live streams to restart when the screen turns
const pendingTurn = new Map<string, Orientation>();       // a rotation the app on screen didn't take (yet)
function setScreen(udid: string, s: { width: number; height: number; scale?: number }): ScreenInfo {
  const info: ScreenInfo = { width: s.width, height: s.height, scale: s.scale, orientation: s.width > s.height ? 'landscape' : 'portrait' };
  const prev = screenCache.get(udid);
  screenCache.set(udid, info); screenAt.set(udid, Date.now());
  if (pendingTurn.get(udid) === info.orientation) pendingTurn.delete(udid);
  if (prev && prev.orientation !== info.orientation) for (const w of turnWatchers.get(udid) ?? []) w();
  const nat = { width: Math.min(s.width, s.height), height: Math.max(s.width, s.height), scale: s.scale, orientation: 'portrait' as const };
  const old = naturalScreen(udid);
  if (!old || old.width !== nat.width || old.height !== nat.height || old.scale !== nat.scale) {
    try { naturals = screenStore.update((v) => { v[udid] = nat; }); } catch { /* best effort */ }
  }
  return info;
}
/** The simulator's screen in its natural (portrait) orientation, from an earlier run; undefined before its first. */
let naturals: Record<string, ScreenInfo> | undefined;   // screenStore, read once
function naturalScreen(udid: string): ScreenInfo | undefined { naturals ??= screenStore.read(); return naturals[udid]; }

// ── orientation ────────────────────────────────────────────────────────────
// `xcrun devicectl device orientation` (Xcode 15+) sets the simulated device orientation; apps then turn if they
// support it (the iPhone home screen and Settings stay portrait). Taps and UI frames follow the turned screen.
let canRotate = true;
let rotateCheck: Promise<void> | undefined;
function checkRotate(): Promise<void> {
  rotateCheck ??= run('xcrun', ['devicectl', 'device', 'orientation', '--help'], { env: toolEnv(), allowFail: true, timeoutMs: 20_000 })
    .then((r) => { canRotate = r.code === 0 && /orientation/i.test(r.stdout + r.stderr); }, () => { canRotate = false; });
  return rotateCheck;
}
function devicectl(args: string[], timeoutMs = 20_000) {
  return run('xcrun', ['devicectl', 'device', 'orientation', ...args], { env: toolEnv(), allowFail: true, timeoutMs });
}
/** UIKit device orientation ('portrait', 'landscapeLeft', 'landscapeRight', …), or undefined when unknown. */
async function deviceOrientation(udid: string): Promise<{ orientation?: string; locked: boolean }> {
  const r = await devicectl(['get', '--device', udid, '-q', '--json-output', '-'], 15_000).catch(() => undefined);
  try { const j = JSON.parse(r?.stdout ?? '').result ?? {}; return { orientation: j.deviceOrientation, locked: !!j.deviceIsOrientationLocked }; }
  catch { return { locked: false }; }
}
async function rotateSim(udid: string, orientation: Orientation): Promise<void> {
  await requireBooted(udid);
  await checkRotate();
  if (!canRotate) throw new PhoneDockError('This Xcode can’t rotate simulators', 'not_supported', 501, ['Update Xcode to rotate simulators.'], 'xcrun devicectl device orientation is unavailable (Xcode 15 or later)');
  // devicectl matches names and real devices too: always the simulator's UDID
  const r = await devicectl(['set', '--device', udid, orientation === 'landscape' ? 'landscapeLeft' : 'portrait', '-q']);
  if (r.code !== 0) {
    const out = (r.stderr + r.stdout).trim();
    if (/lock/i.test(out)) throw new PhoneDockError('Rotation is locked on the simulator', 'rotation_locked', 409, ['Turn off Portrait Orientation Lock in Control Center, then try again.'], out.slice(-500));
    throw new PhoneDockError('Couldn’t rotate the simulator', 'rotate_failed', 500, undefined, `devicectl device orientation set failed: ${out.slice(-500)}`);
  }
  // The UI turns ~0.5 s later. Apps that keep their orientation never do: stop waiting after 2 s.
  const deadline = Date.now() + 2000;
  let info = await screenInfoOf(udid, true);
  while (info.orientation !== orientation && Date.now() < deadline) { await sleep(200); info = await screenInfoOf(udid, true); }
  if (info.orientation !== orientation) pendingTurn.set(udid, orientation); else pendingTurn.delete(udid);
}

async function scaleOf(udid: string): Promise<number> { return (await screenInfoOf(udid)).scale ?? 3; }
const pt = (v: number, scale: number) => String(Math.round((v / scale) * 10) / 10);

// ── UI tree ────────────────────────────────────────────────────────────────

const CLICKABLE = new Set(['Button', 'Link', 'Cell', 'TextField', 'SecureTextField', 'SearchField', 'Switch', 'Toggle', 'Slider',
  'Tab', 'TabBarButton', 'MenuItem', 'Key', 'CheckBox', 'RadioButton', 'PopUpButton', 'SegmentedControl', 'Stepper', 'Image', 'Icon', 'TextView', 'Incrementor', 'ComboBox']);
const SCROLLABLE = new Set(['ScrollView', 'Table', 'CollectionView', 'List', 'WebView']);

export function mapTree(roots: AxNode[], scale: number): UiElement[] {
  let n = 0;
  const conv = (node: AxNode): UiElement[] => {
    const f = nodeFrame(node);
    const kids = (node.children ?? []).flatMap(conv);
    if (!f || f.width <= 0 || f.height <= 0) return kids;        // drop zero-size nodes, keep their children
    // UISwitch comes as a CheckBox with subrole AXSwitch: call it what it looks like (blind run: "CheckBox" rows)
    const type = node.subrole === 'AXSwitch' ? 'Switch' : (node.type || node.role?.replace(/^AX/, '') || 'Element');
    const el: UiElement = {
      ref: `e${++n}`,
      type,
      bounds: { x: Math.round(f.x * scale), y: Math.round(f.y * scale), width: Math.round(f.width * scale), height: Math.round(f.height * scale) },
    };
    const label = node.AXLabel ?? node.title ?? undefined;
    if (label) { el.label = label; el.text = label; }
    const toggle = /^(Switch|Toggle|CheckBox)$/.test(type) && (node.AXValue === '1' || node.AXValue === '0');
    if (node.AXValue != null && node.AXValue !== '') { el.value = String(node.AXValue); if (!el.text && !toggle) el.text = el.value; }
    if (node.AXUniqueId) el.id = node.AXUniqueId;
    if (node.enabled !== undefined) el.enabled = node.enabled;
    if (toggle) el.checked = node.AXValue === '1';
    if (CLICKABLE.has(type) || (node.custom_actions?.length ?? 0) > 0) el.clickable = true;
    if (SCROLLABLE.has(type)) el.scrollable = true;
    if (kids.length) el.children = kids;
    return [el];
  };
  // refs are assigned in pre-order: renumber after the fact so parents come before children
  const tree = roots.flatMap(conv);
  let k = 0;
  const renum = (els: UiElement[]) => { for (const e of els) { e.ref = `e${++k}`; if (e.children) renum(e.children); } };
  renum(tree);
  return tree;
}

// ── input ──────────────────────────────────────────────────────────────────

const HID: Record<string, number> = {
  enter: 40, return: 40, escape: 41, esc: 41, delete: 42, backspace: 42, tab: 43, space: 44,
  right: 79, left: 80, down: 81, up: 82, forward_delete: 76, page_up: 75, page_down: 78, home_key: 74, end: 77,
};
const BUTTONS: Record<string, string> = { home: 'home', lock: 'lock', power: 'lock', siri: 'siri', side: 'side-button', apple_pay: 'apple-pay' };

// AXe types US-keyboard characters only via HID; anything else goes through the pasteboard + Cmd+V.
const HID_TYPABLE = /^[A-Za-z0-9 !@#$%^&*()_+\-={}[\]|\\:";'<>?,./`~\n\t]*$/;

async function typeText(udid: string, text: string): Promise<void> {
  if (!text) return;
  if (HID_TYPABLE.test(text)) {
    try { await axe(['type', '--stdin', '--udid', udid], { input: text, timeoutMs: 30_000 + text.length * 100 }); return; }
    catch (e) { wrapAxeError(e, 'type'); }
  }
  await simctl(['pbcopy', udid], { input: text });
  try { await axe(['key-combo', '--modifiers', '227', '--key', '25', '--udid', udid]); } catch (e) { wrapAxeError(e, 'paste'); }
}

// ── streaming ──────────────────────────────────────────────────────────────

function startStream(udid: string, opts: { maxSize?: number; fps?: number } = {}): FrameStream {
  const frameCbs: ((j: Buffer, s?: ScreenInfo) => void)[] = []; const endCbs: ((e?: Error) => void)[] = [];
  let child: ChildProcess | undefined; let turner: ChildProcess | undefined; let stopped = false; let ended = false; let stderr = '';
  let gen = 0; let pipe: ScreenInfo | undefined;
  const end = (err?: Error) => { if (ended) return; ended = true; clearInterval(watch); turnWatchers.get(udid)?.delete(onTurn); for (const cb of endCbs) cb(err); };
  const killPipe = () => {
    for (const c of [child, turner]) if (c && c.exitCode === null) { try { c.kill('SIGTERM'); } catch { /* */ } }
    child = turner = undefined;
  };
  const start = async (fresh: boolean) => {
    const my = ++gen;
    const fps = Math.max(1, Math.min(30, Math.round(opts.fps ?? 15)));
    let s: ScreenInfo; let turn = 0;   // ffmpeg transpose: 1 = 90° clockwise, 2 = 90° counter-clockwise
    try {
      s = await screenInfoOf(udid, fresh);
      // AXe captures the panel unturned: a landscape UI arrives on its side
      if (s.orientation === 'landscape') turn = (await deviceOrientation(udid)).orientation === 'landscapeRight' ? 1 : 2;
    } catch (e) { end(e as Error); return; }
    if (stopped || my !== gen) return;
    pipe = s;
    const scale = opts.maxSize ? Math.max(0.1, Math.min(1, opts.maxSize / Math.max(s.width, s.height))) : 1;
    const emit = (j: Buffer) => { if (my === gen) for (const cb of frameCbs) cb(j, s); };
    const ax = spawn(axePath(), ['stream-video', '--udid', udid, '--format', 'mjpeg', '--fps', String(fps), '--quality', '70', '--scale', scale.toFixed(3)],
      { env: toolEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    child = ax;
    const ff = turn ? ffmpegBin() : undefined;
    if (ff) {
      // no probing/buffering: each frame comes out as the next one goes in
      const t = spawn(ff, ['-loglevel', 'error', '-probesize', '32', '-analyzeduration', '0', '-fflags', 'nobuffer', '-flags', 'low_delay',
        '-f', 'jpeg_pipe', '-i', '-', '-vf', `transpose=${turn}`, '-threads', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '5', '-'],
        { env: toolEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
      turner = t;
      t.stdin!.on('error', () => { /* EPIPE on restart */ });
      const out = new JpegSplitter(emit);
      t.stdout!.on('data', (d: Buffer) => out.push(d));
      const into = new JpegSplitter((j) => { if (!t.stdin!.destroyed) t.stdin!.write(j); });
      ax.stdout!.on('data', (d: Buffer) => into.push(d));
    } else {
      const splitter = new JpegSplitter(emit);
      ax.stdout!.on('data', (d: Buffer) => splitter.push(d));
    }
    ax.stderr!.on('data', (d: Buffer) => { if (stderr.length < 8000) stderr += d.toString(); });
    ax.on('error', (e) => { if (my === gen) end(e); });
    ax.on('close', (code) => { if (my === gen) end(stopped || code === 0 ? undefined : new Error(`axe stream-video exited ${code}: ${stderr.trim().slice(-500)}`)); });
  };
  /** The screen turned: capture again the right way up (the last frame stays up meanwhile). */
  const restart = () => { if (stopped || ended) return; killPipe(); void start(false).catch((e) => end(e as Error)); };
  const onTurn = () => { if (pipe && screenCache.get(udid)?.orientation !== pipe.orientation) restart(); };
  if (!turnWatchers.has(udid)) turnWatchers.set(udid, new Set());
  turnWatchers.get(udid)!.add(onTurn);
  // After a rotation the app on screen didn't take, the next app opened turns by itself: look every second meanwhile.
  const watch = setInterval(() => { if (pendingTurn.has(udid) && !stopped) void screenInfoOf(udid, true).catch(() => undefined); }, 1000);
  void start(false).catch((e) => end(e as Error));
  return {
    onFrame(cb) { frameCbs.push(cb); },
    onEnd(cb) { endCbs.push(cb); },
    stop() { stopped = true; gen++; if (child) killPipe(); end(); },
    restart() { if (stopped || ended) return; void screenInfoOf(udid, true).then((s) => { if (!pipe || s.orientation !== pipe.orientation) restart(); }, () => undefined); },
  };
}

// ── apps ───────────────────────────────────────────────────────────────────

async function plistJson(file: string): Promise<Record<string, unknown>> {
  const r = await run('plutil', ['-convert', 'json', '-o', '-', file]);
  return JSON.parse(r.stdout);
}

function findApp(dir: string, depth = 0): string | undefined {
  if (depth > 3) return undefined;
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return undefined; }
  const payload = entries.find((e) => e === 'Payload');
  if (payload) { const hit = findApp(join(dir, payload), depth + 1); if (hit) return hit; }
  const app = entries.find((e) => e.endsWith('.app'));
  if (app) return join(dir, app);
  for (const e of entries) {
    const p = join(dir, e);
    if (e.startsWith('.') || e === '__MACOSX') continue;
    try { if (statSync(p).isDirectory()) { const hit = findApp(p, depth + 1); if (hit) return hit; } } catch { /* skip */ }
  }
  return undefined;
}

/** Throws a clear error when `app` was built for a real device instead of the simulator. */
async function assertSimulatorBuild(app: string, info: Record<string, unknown>): Promise<void> {
  const plats = info.CFBundleSupportedPlatforms as string[] | undefined;
  let platform: string | undefined;
  if (plats?.length) platform = plats.some((p) => /Simulator/i.test(p)) ? 'IOSSIMULATOR' : 'IOS';
  const exe = info.CFBundleExecutable as string | undefined;
  if (!platform && exe && existsSync(join(app, exe))) {
    const r = await run('xcrun', ['vtool', '-show-build', join(app, exe)], { env: toolEnv(), allowFail: true });
    const m = r.stdout.match(/platform\s+(\w+)/);
    if (m) platform = m[1];
  }
  if (platform && platform !== 'IOSSIMULATOR' && !/SIMULATOR/i.test(platform)) {
    throw new PhoneDockError('This app was built for a device and cannot run in the simulator', 'bad_app', 400,
      ['Build the app for the simulator.'], `${basename(app)} platform: ${platform}. Rebuild with: xcodebuild -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO. App Store / TestFlight .ipa files cannot run in the simulator.`);
  }
}

function safeJoin(root: string, rel: string): string {
  const p = resolve(root, rel.replace(/^\/+/, ''));
  if (p !== root && !p.startsWith(root + sep)) throw new PhoneDockError('Path escapes the container', 'bad_request', 400);
  return p;
}

/** Resolve a remote path: `app://<bundleId>/<rel>` (app data container), `group://<groupId>/<rel>`, `data://<rel>` (device data dir). */
async function resolveRemote(udid: string, remote: string): Promise<string> {
  let m = remote.match(/^app:\/\/([^/]+)\/?(.*)$/);
  if (m) {
    const r = await simctl(['get_app_container', udid, m[1], 'data']);
    return safeJoin(r.stdout.trim(), m[2]);
  }
  m = remote.match(/^group:\/\/([^/]+)\/?(.*)$/);
  if (m) {
    const r = await simctl(['get_app_container', udid, m[1], m[1]]).catch(() => undefined);
    if (r) return safeJoin(r.stdout.trim(), m[2]);
  }
  m = remote.match(/^data:\/\/\/?(.*)$/);
  if (m) return safeJoin(dataDir(udid), m[1]);
  throw new PhoneDockError('The simulator file location is not supported', 'bad_request', 400, undefined,
    `Unsupported iOS simulator path "${remote}". Use photos:<anything> for media, app://<bundleId>/<path> for app data, or data://<path> for simulator data.`);
}

// ── snapshots ──────────────────────────────────────────────────────────────

const SNAP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const snapRoot = (udid: string) => stateDir('ios-snapshots', udid);
function snapDir(udid: string, name: string): string {
  if (!SNAP_NAME.test(name)) throw new PhoneDockError('Snapshot names may contain letters, digits, . _ - (max 64)', 'bad_request', 400);
  return join(snapRoot(udid), name);
}

async function shutdownQuiet(udid: string): Promise<void> {
  const r = await simctl(['shutdown', udid], { allowFail: true, timeoutMs: 120_000 });
  if (r.code !== 0 && !/current state: Shutdown|Shutdown/i.test(r.stderr)) throw new PhoneDockError('Couldn’t shut down the simulator', 'exec_failed', 500, undefined, `shutdown failed: ${r.stderr.trim()}`);
  await waitFor(async () => (await findSim(udid)).dev.state === 'Shutdown', 60_000, 500, 'simulator shutdown');
}

async function bootAndWait(udid: string, opts: BootOptions = {}): Promise<void> {
  booting.add(udid);
  try {
    const r = await simctl(['boot', udid], { allowFail: true, timeoutMs: 120_000 });
    if (r.code !== 0 && !/current state: Booted/i.test(r.stderr)) throw new PhoneDockError('Couldn’t start the simulator', 'boot_failed', 500, undefined, `boot failed: ${r.stderr.trim()}`);
    await simctl(['bootstatus', udid, '-b'], { timeoutMs: 180_000 }).catch((e: Error) => {
      throw new PhoneDockError("The simulator did not finish starting in time", 'timeout', 504, undefined, `Simulator did not finish booting within 180s: ${e instanceof PhoneDockError ? e.detail ?? e.message : e.message}`);
    });
  } finally { booting.delete(udid); }
  screenCache.delete(udid); pendingTurn.delete(udid);
  if (opts.window || opts.headless === false) await openWindow(udid);
}

/** Xcode ≤ 26 ships Simulator.app (Developer/Applications); Xcode 27 replaced it with DeviceHub.app (Contents/Applications). */
function simulatorWindowApp(): { path: string; simulator: boolean } | undefined {
  const dd = developerDir();
  if (!dd) return undefined;
  const contents = dirname(dd);
  for (const path of [join(dd, 'Applications', 'Simulator.app'), join(contents, 'Applications', 'Simulator.app')]) {
    if (existsSync(path)) return { path, simulator: true };
  }
  const hub = join(contents, 'Applications', 'DeviceHub.app');
  return existsSync(hub) ? { path: hub, simulator: false } : undefined;
}

async function openWindow(udid: string): Promise<void> {
  const app = simulatorWindowApp();
  if (!app) {
    throw new PhoneDockError('Can’t open a window: Xcode’s Simulator isn’t installed', 'not_supported', 501,
      ['Install Xcode from the App Store; PhoneDock shows the screen without it']);
  }
  // Simulator honours -CurrentDeviceUDID; Device Hub ignores unknown arguments and opens on its device list.
  const args = app.simulator ? ['-a', app.path, '--args', '-CurrentDeviceUDID', udid] : ['-a', app.path];
  try { await run('open', args, { env: toolEnv() }); }
  catch (e) { throw new PhoneDockError(`Couldn’t open ${app.simulator ? 'Simulator' : 'Device Hub'}`, 'device_error', 502, ['Open it from Xcode’s developer tools.'], e instanceof PhoneDockError ? e.detail ?? e.message : String(e)); }
}

// ── profiles / images resolution for create() ──────────────────────────────

async function resolveRuntime(image?: string): Promise<SimRuntime> {
  const rts = (await runtimes(true)).filter((r) => r.isAvailable !== false && isIosRuntime(r.identifier));
  if (!rts.length) throw new PhoneDockError('No iOS simulator runtime installed', 'no_image', 400, ['Install an iOS simulator runtime.'], 'xcodebuild -downloadPlatform iOS');
  if (!image) {
    // newest first that works: not known to be broken (disk image state, a failed create), and a probe create succeeds
    const bad = await unusableRuntimes(rts);
    const sorted = [...rts].sort((a, b) => cmpVer(b.version, a.version));
    for (const r of sorted) if (!bad.has(r.identifier) && await runtimeUsable(r)) return r;
    return sorted[0];
  }
  const hit = rts.find((r) => r.identifier === image || r.version === image || r.name === image || r.name === `iOS ${image}` || r.buildversion === image);
  if (!hit) throw new PhoneDockError('The requested iOS runtime is unavailable', 'not_found', 404, ['Choose an installed runtime.'], `Requested: ${image}. Installed: ${rts.map((r) => r.identifier).join(', ')}`);
  return hit;
}

async function resolveDeviceType(profile: string | undefined, rt: SimRuntime): Promise<SimDeviceType> {
  const all = await deviceTypes();
  const supported = rt.supportedDeviceTypes?.length ? all.filter((t) => rt.supportedDeviceTypes!.some((s) => s.identifier === t.identifier)) : all;
  if (profile) {
    const p = profile.toLowerCase();
    const hit = all.find((t) => t.identifier === profile || t.name.toLowerCase() === p) ?? all.find((t) => t.identifier.toLowerCase().endsWith(p.replace(/\s+/g, '-')));
    if (!hit) throw new PhoneDockError('The requested device type was not found', 'not_found', 404, ['Choose an available device type.'], `Unknown device type: ${profile}. GET /v1/backends/ios-simulator/profiles`);
    if (!supported.includes(hit)) throw new PhoneDockError(`${hit.name} is not supported by ${rt.name}`, 'bad_request', 400);
    return hit;
  }
  const phones = supported.filter((t) => t.productFamily === 'iPhone');
  return phones.find((t) => / Pro$/.test(t.name)) ?? phones.at(-1) ?? supported[0];
}

function cmpVer(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d; }
  return 0;
}

// ── the backend ────────────────────────────────────────────────────────────

let availCache: { at: number; v: Availability } | undefined;

// ── v0.2: foreground app, crashes, recording, app data ─────────────────────

/** pid of a running app (its UIKitApplication launchd job inside the simulator); undefined when not running. */
async function simAppPid(udid: string, appId: string): Promise<number | undefined> {
  const r = await simctl(['spawn', udid, 'launchctl', 'list'], { allowFail: true, timeoutMs: 30_000 });
  return parseLaunchctlPid(r.stdout, appId);
}

/** Frontmost app: AXe's root AXApplication pid → `launchctl list` label inside the simulator. */
async function foregroundAppOf(udid: string): Promise<AppInfo | null> {
  await requireBooted(udid);
  const [roots, lc] = await Promise.all([
    describeUi(udid),
    simctl(['spawn', udid, 'launchctl', 'list'], { allowFail: true, timeoutMs: 30_000 }),
  ]);
  const root = roots.find((n) => n.role === 'AXApplication' || n.type === 'Application') ?? roots[0];
  if (typeof root?.pid !== 'number') return null;
  for (const line of lc.stdout.split('\n')) {
    const m = /^(\d+)\s+\S+\s+(\S+)/.exec(line.trim());
    if (!m || +m[1] !== root.pid) continue;
    const app = /^UIKitApplication:([^[\s]+)\[/.exec(m[2]);
    if (app) return { id: app[1], name: root.AXLabel ?? undefined, system: app[1].startsWith('com.apple.') };
    if (m[2] !== 'com.apple.SpringBoard') return null;
    // SpringBoard owns the tree: home screen / app switcher — or a system alert (permission prompt …) over an
    // app. In the alert case SpringBoard nests the covered app's scene as a full-screen Group labelled with the
    // app's name (the home screen has no such group: only the Dock and icon buttons).
    const W = root.frame?.width ?? 0, H = root.frame?.height ?? 0;
    const names = new Set<string>();
    const walk = (n: AxNode, depth: number) => {
      const f = n.frame, label = n.AXLabel?.trim();
      if (n.type === 'Group' && label && f && Math.abs(f.width - W) < 2 && Math.abs(f.height - H) < 2) names.add(label);
      if (depth < 40) for (const c of n.children ?? []) walk(c, depth + 1);
    };
    walk(root, 0);
    if (!names.size) return null;
    const running = new Set([...lc.stdout.matchAll(/UIKitApplication:([^[\s]+)\[/g)].map((x) => x[1]));
    const hit = (await (backend.listApps as (u: string, o?: { system?: boolean }) => Promise<AppInfo[]>)(udid, { system: true })).find((a) => a.name && names.has(a.name) && running.has(a.id));
    return hit ? { ...hit, obscured: true } as AppInfo : null;
  }
  return null;
}

// Simulator crash reports are written by the Mac's ReportCrash into ~/Library/Logs/DiagnosticReports (+ Retired/),
// mixed with Mac reports and every other simulator's. Attribution: coalitionName / procPath carry the device UDID.
interface SimIps { path: string; mtimeMs: number; size: number; udid?: string; report?: CrashReport }
const ipsCache = new Map<string, SimIps>();

function diagDirs(): string[] {
  const d = join(homedir(), 'Library', 'Logs', 'DiagnosticReports');
  return [d, join(d, 'Retired')];
}

function simUdidOf(r: IpsReport): string | undefined {
  const b = r.body;
  const c = typeof b.coalitionName === 'string' ? /CoreSimulator\.SimDevice\.([0-9A-F-]{36})/i.exec(b.coalitionName) : null;
  if (c) return c[1].toUpperCase();
  const p = typeof b.procPath === 'string' ? /CoreSimulator\/Devices\/([0-9A-F-]{36})\//i.exec(b.procPath) : null;
  return p?.[1].toUpperCase();
}

function scanSimCrashes(): SimIps[] {
  const out: SimIps[] = []; const seen = new Set<string>();
  for (const dir of diagDirs()) {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.ips')) continue;
      const path = join(dir, n);
      let st; try { st = statSync(path); } catch { continue; }
      if (!st.isFile()) continue;
      let e = ipsCache.get(path);
      if (!e || e.mtimeMs !== st.mtimeMs || e.size !== st.size) {
        e = { path, mtimeMs: st.mtimeMs, size: st.size };
        try {
          const r = parseIps(readFileSync(path, 'utf8'));
          const kind = r ? ipsKind(r.header.bug_type) : 'other';
          if (r && kind !== 'other') {
            e.udid = simUdidOf(r);
            if (e.udid) {
              const h = r.header, b = r.body;
              e.report = {
                id: `ips:${typeof h.incident_id === 'string' ? h.incident_id : n.replace(/\.ips$/, '')}`,
                appId: (h.bundleID ?? b.bundleInfo?.CFBundleIdentifier) || undefined,
                process: b.procName ?? h.app_name ?? h.name,
                time: ipsTime(b.captureTime) ?? ipsTime(h.timestamp) ?? new Date(st.mtimeMs).toISOString(),
                kind,
                summary: ipsSummary(r),
              };
            }
          }
        } catch { /* unreadable / partial file: cached as "not ours" until it changes */ }
        ipsCache.set(path, e);
      }
      seen.add(path); out.push(e);
    }
  }
  for (const k of ipsCache.keys()) if (!seen.has(k)) ipsCache.delete(k);
  return out;
}

async function listSimCrashes(udid: string, opts: { since?: string; appId?: string; limit?: number } = {}): Promise<CrashReport[]> {
  await findSim(udid);
  const since = opts.since ? Date.parse(opts.since) : NaN;
  if (opts.since && Number.isNaN(since)) throw new PhoneDockError('The starting date is invalid', 'bad_request', 400, undefined, `Invalid since: ${opts.since}`);
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 50)));
  const ids = new Set<string>(); const list: CrashReport[] = [];
  for (const e of scanSimCrashes()) {
    const r = e.report;
    if (!r || e.udid !== udid.toUpperCase() || ids.has(r.id)) continue;
    if (opts.appId && r.appId !== opts.appId && r.process !== opts.appId) continue;
    if (!Number.isNaN(since) && Date.parse(r.time ?? '') < since) continue;
    ids.add(r.id); list.push(r);
  }
  return list.sort((a, b) => Date.parse(b.time ?? '') - Date.parse(a.time ?? '')).slice(0, limit);
}

async function getSimCrash(udid: string, crashId: string): Promise<string> {
  await findSim(udid);
  const e = scanSimCrashes().find((x) => x.report?.id === crashId && x.udid === udid.toUpperCase());
  if (!e) throw new PhoneDockError('The crash report was not found on this simulator', 'not_found', 404, ['Choose an available crash report.'], `Crash ${crashId} not found. List reports with GET …/crashes`);
  const text = readFileSync(e.path, 'utf8');
  const r = parseIps(text);
  return r ? ipsRender(r) : text;
}

interface SimRecording {
  udid: string; outPath: string; tmp: string; file: string; child: ChildProcess; exited: Promise<number | null>;
  out: () => string; timer?: NodeJS.Timeout; finishing?: Promise<string>; done?: boolean;
}
const simRecordings = new Map<string, SimRecording>();

async function startSimRecording(udid: string, outPath: string, opts: { maxSeconds?: number } = {}): Promise<void> {
  await requireBooted(udid);
  const prev = simRecordings.get(udid);
  if (prev && !prev.done) throw new PhoneDockError('A recording is already running on this device', 'busy', 409, ['Stop it first']);
  simRecordings.delete(udid);
  const maxSeconds = Math.max(1, Math.min(Math.round(opts.maxSeconds ?? 300), 3600));
  mkdirSync(dirname(outPath), { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'pd-simrec-'));
  const file = join(tmp, 'rec.mp4');
  const child = spawn('xcrun', ['simctl', 'io', udid, 'recordVideo', '--codec=h264', '--force', file], { env: toolEnv(), cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; const grab = (d: Buffer) => { if (out.length < 8000) out += d.toString(); };
  child.stdout!.on('data', grab); child.stderr!.on('data', grab);
  const exited = new Promise<number | null>((res) => { child.on('close', (c) => res(c)); child.on('error', () => res(-1)); });
  // simctl prints "Recording started" once frames flow; without it nothing usable gets written.
  const deadline = Date.now() + 15_000;
  while (!/Recording started/i.test(out) && child.exitCode === null && Date.now() < deadline) await sleep(50);
  if (!/Recording started/i.test(out)) {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(tmp, { recursive: true, force: true });
    throw new PhoneDockError('Couldn’t start recording', 'record_failed', 500, undefined, `simctl recordVideo did not start: ${out.trim().slice(-500) || 'no output'}`);
  }
  const rec: SimRecording = { udid, outPath, tmp, file, child, exited, out: () => out };
  // Enforce maxSeconds ourselves (simctl has no time limit); the file is finalized even if nobody calls stop.
  rec.timer = setTimeout(() => { void finalizeSimRecording(rec).catch(() => undefined); }, maxSeconds * 1000);
  rec.timer.unref?.();
  simRecordings.set(udid, rec);
}

function finalizeSimRecording(rec: SimRecording): Promise<string> {
  if (rec.finishing) return rec.finishing;
  if (rec.timer) clearTimeout(rec.timer);
  rec.finishing = (async () => {
    try {
      if (rec.child.exitCode === null) {
        rec.child.kill('SIGINT');                           // SIGINT = finish writing the movie
        const r = await Promise.race([rec.exited, sleep(30_000).then(() => 'timeout' as const)]);
        if (r === 'timeout') { rec.child.kill('SIGKILL'); throw new PhoneDockError("The recording did not finish in time", 'record_failed', 500, undefined, 'simctl recordVideo did not finish within 30s'); }
      }
      if (!existsSync(rec.file) || statSync(rec.file).size === 0) {
        throw new PhoneDockError("The recording produced no data", 'record_failed', 500, undefined, `simctl recordVideo wrote nothing: ${rec.out().trim().slice(-500)}`);
      }
      await finalizeMp4(rec.file, rec.outPath);
      const info = await probeVideo(rec.outPath);
      if (info && !(info.duration && info.duration > 0)) throw new PhoneDockError("The recording is not playable", 'record_failed', 500, undefined, `Recording at ${rec.outPath} is not playable (ffprobe: ${JSON.stringify(info)})`);
      return rec.outPath;
    } finally {
      rec.done = true;
      rmSync(rec.tmp, { recursive: true, force: true });
    }
  })();
  return rec.finishing;
}

async function stopSimRecording(udid: string): Promise<string> {
  const rec = simRecordings.get(udid);
  if (!rec) throw new PhoneDockError('No recording is running on this device', 'not_recording', 404);
  try { return await finalizeSimRecording(rec); } finally { simRecordings.delete(udid); }
}

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;
const MCM_META = '.com.apple.mobile_container_manager.metadata.plist';   // container identity: never copied over

async function dataContainer(udid: string, appId: string): Promise<string> {
  if (!BUNDLE_ID.test(appId)) throw new PhoneDockError('The app identifier is invalid', 'bad_request', 400, undefined, `Invalid bundle id: ${appId}`);
  await requireBooted(udid);
  const r = await simctl(['get_app_container', udid, appId, 'data'], { allowFail: true, timeoutMs: 30_000 });
  const dir = r.stdout.trim();
  if (r.code !== 0 || !dir) {
    if (/No such file|not installed|code=2\b/i.test(r.stderr)) throw new PhoneDockError('The app is not installed on this simulator', 'not_found', 404, undefined, `${appId}: ${r.stderr.trim()}`);
    throw new PhoneDockError('Couldn’t find the app’s data', 'exec_failed', 500, undefined, `get_app_container failed: ${r.stderr.trim().slice(0, 400)}`);
  }
  if (!dir.startsWith(dataDir(udid) + sep) || !existsSync(dir)) throw new PhoneDockError('Couldn’t find the app’s data', 'exec_failed', 500, undefined, `Unexpected data container path ${dir}`);
  return dir;
}

/** cp -c (APFS clone, near-instant) with a plain-copy fallback for other volumes. */
async function cloneCopy(sources: string[], dest: string): Promise<void> {
  if (!sources.length) return;
  let r = await run('/bin/cp', ['-c', '-R', ...sources, dest], { allowFail: true, timeoutMs: 1_800_000 });
  if (r.code !== 0) r = await run('/bin/cp', ['-R', ...sources, dest], { allowFail: true, timeoutMs: 1_800_000 });
  if (r.code !== 0) throw new PhoneDockError('Couldn’t copy the app’s data', 'exec_failed', 500, undefined, `Copy failed: ${r.stderr.trim().slice(-500)}`);
}

async function exportSimAppData(udid: string, appId: string, outDir: string): Promise<void> {
  const container = await dataContainer(udid, appId);
  await backend.terminateApp!(udid, appId);
  mkdirSync(outDir, { recursive: true });
  const dest = join(outDir, 'data');
  rmSync(dest, { recursive: true, force: true });
  await cloneCopy([container], dest);                     // dest does not exist → becomes a copy of the container
  writeFileSync(join(outDir, 'phonedock-appdata.json'), JSON.stringify({
    format: 1, platform: 'ios', appId, device: udid, exportedAt: new Date().toISOString(), method: 'simctl-data-container',
    layout: { data: container },
    notes: ['App group containers (simctl get_app_container … groups) and the keychain are not included'],
  }, null, 2));
}

async function importSimAppData(udid: string, appId: string, fromDir: string): Promise<void> {
  if (!BUNDLE_ID.test(appId)) throw new PhoneDockError('The app identifier is invalid', 'bad_request', 400, undefined, `Invalid bundle id: ${appId}`);
  const src = join(fromDir, 'data');
  if (!existsSync(src) || !statSync(src).isDirectory()) throw new PhoneDockError('Couldn’t find the saved app data', 'not_found', 404, undefined, `${src} not found (expected the layout written by exportAppData)`);
  const container = await dataContainer(udid, appId);
  await backend.terminateApp!(udid, appId);
  for (const n of readdirSync(container)) if (n !== MCM_META) rmSync(join(container, n), { recursive: true, force: true });
  await cloneCopy(readdirSync(src).filter((n) => n !== MCM_META).map((n) => join(src, n)), container + sep);
}

export const backend: Backend = {
  id: ID,
  displayName: 'iOS Simulator',
  platform: 'ios',
  kind: 'virtual',
  capabilities: CAPS,

  async available() {
    if (availCache && Date.now() - availCache.at < 30_000) return availCache.v;
    let v: Availability;
    if (process.platform !== 'darwin') v = { ok: false, reason: 'iOS simulators require macOS' };
    else if (!developerDir()) v = { ok: false, reason: 'Xcode not found', hints: ['Install Xcode from the App Store, then run it once to install the iOS platform'] };
    else {
      const r = await run('xcrun', ['simctl', 'help'], { env: toolEnv(), allowFail: true, timeoutMs: 20_000 }).catch(() => undefined);
      if (!r || r.code !== 0) v = { ok: false, reason: 'xcrun simctl is not usable', hints: ['sudo xcodebuild -runFirstLaunch'] };
      else {
        const x = await run('xcodebuild', ['-version'], { env: toolEnv(), allowFail: true }).catch(() => undefined);
        const version = x?.stdout.split('\n')[0]?.trim();
        const hints: string[] = [];
        if (!(process.env.PHONEDOCK_AXE ?? which('axe'))) hints.push('Install AXe for input, UI tree and streaming: brew install cameroncooke/axe/axe');
        v = { ok: true, version, hints: hints.length ? hints : undefined, ...(hints.length ? { reason: 'AXe missing: input/uiTree/stream unavailable' } : {}) };
      }
    }
    availCache = { at: Date.now(), v };
    return v;
  },

  async listDevices() {
    void checkRotate();   // until it answers (once), simulators offer rotate
    const [devs, rts, types] = await Promise.all([rawDevices(), runtimes(), deviceTypes()]);
    const managed = state.read().devices ?? {};
    const out: Device[] = [];
    for (const { runtime, dev } of devs) {
      if (!isIosRuntime(runtime) || dev.isAvailable === false) continue;
      out.push(await toDevice(runtime, dev, rts, types, managed));
    }
    // forget managed entries whose simulator was deleted outside PhoneDock
    const live = new Set(devs.map((d) => d.dev.udid));
    if (Object.keys(managed).some((u) => !live.has(u))) state.update((s) => { for (const u of Object.keys(s.devices ?? {})) if (!live.has(u)) delete s.devices![u]; });
    return out;
  },

  async listImages() {
    const rts = await runtimes(true);
    const bad = await unusableRuntimes(rts);
    const ios = rts.filter((r) => isIosRuntime(r.identifier));
    const usable = await Promise.all(ios.map((r) => r.isAvailable === false || bad.has(r.identifier) ? false : runtimeUsable(r)));
    const images: OsImage[] = ios.map((r, i) => ({
      id: r.identifier, backend: ID, platform: 'ios',
      name: `${r.name}${r.buildversion ? ` (${r.buildversion})` : ''} · Simulator`,
      version: r.version, installed: r.isAvailable !== false,
      usable: usable[i],
      profiles: r.supportedDeviceTypes?.map((t) => t.identifier),
      notes: r.isAvailable === false ? 'Runtime unavailable (installed but not usable with this Xcode)'
        : bad.has(r.identifier) ? `Not usable on this Mac: ${bad.get(r.identifier)}. Download it again in Xcode › Settings › Components, or use another version.`
        : !usable[i] ? 'Installed, but this Mac can’t create devices with it (its disk image is missing or unmounted). Download it again in Xcode › Settings › Components, or use another version.' : undefined,
    }));
    images.push({
      id: 'download:iOS', backend: ID, platform: 'ios', name: 'Latest iOS simulator runtime for this Xcode (download)',
      installed: false, sizeMB: 8000,
      notes: 'Installs via `xcodebuild -downloadPlatform iOS`. Use "download:iOS:<buildVersion>" for a specific build.',
    });
    return images;
  },

  async installImage(imageId, onProgress) {
    const m = imageId.match(/^(?:download:)?(iOS)(?::(.+))?$/i);
    if (!m) {
      const existing = (await runtimes(true)).find((r) => r.identifier === imageId && r.isAvailable !== false);
      if (existing) { onProgress?.(`${existing.name} is already installed`); return; }
      throw new PhoneDockError('The requested simulator image was not found', 'not_found', 404, ['Choose an available simulator image.'], `Unknown image: ${imageId}. Use "download:iOS" (latest) or "download:iOS:<buildVersion>".`);
    }
    const args = ['-downloadPlatform', 'iOS', ...(m[2] ? ['-buildVersion', m[2]] : [])];
    onProgress?.(`xcodebuild ${args.join(' ')}`);
    await new Promise<void>((res, rej) => {
      const child = spawn('xcodebuild', args, { env: toolEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      let tail = '';
      const onData = (d: Buffer) => {
        const s = d.toString(); tail = (tail + s).slice(-4000);
        for (const line of s.split(/[\r\n]+/)) if (line.trim()) onProgress?.(line.trim());
      };
      child.stdout!.on('data', onData); child.stderr!.on('data', onData);
      child.on('error', (e) => rej(new PhoneDockError('Couldn’t download the simulator runtime', 'exec_failed', 500, undefined, `xcodebuild: ${e.message}`)));
      child.on('close', (code) => code === 0 ? res() : rej(new PhoneDockError('Couldn’t download the simulator runtime', 'install_failed', 500, undefined, `xcodebuild -downloadPlatform failed (${code}): ${tail.trim().slice(-800)}`)));
    });
    runtimeCache = undefined;
    onProgress?.('done');
  },

  async listProfiles() {
    return (await deviceTypes())
      .filter((t) => t.productFamily === 'iPhone' || t.productFamily === 'iPad')
      .map((t): HardwareProfile => ({ id: t.identifier, name: t.name }));
  },

  async create(spec, onProgress) {
    if (!spec.name) throw new PhoneDockError('A simulator name is required', 'bad_request', 400);
    const existing = (await rawDevices()).find((d) => d.dev.name === spec.name && isIosRuntime(d.runtime));
    if (existing) throw new PhoneDockError(`A simulator named "${spec.name}" already exists`, 'conflict', 409, undefined, `Simulator ID: ${existing.dev.udid}`);
    const rt = await resolveRuntime(spec.image);
    const dt = await resolveDeviceType(spec.profile, rt);
    const ignored = (['cpus', 'ramMB', 'storageMB', 'width', 'height', 'dpi', 'network'] as const).filter((k) => spec[k] !== undefined);
    onProgress?.(`Creating ${dt.name} with ${rt.name}${ignored.length ? ` (ignored: ${ignored.join(', ')} – not configurable on iOS simulators)` : ''}`);
    const r = await simctl(['create', spec.name, dt.identifier, rt.identifier], { timeoutMs: 120_000 }).catch((e: unknown) => {
      const err = createError(e, rt.name);
      if (err instanceof PhoneDockError && err.code === 'no_image') {
        state.update((s) => { (s.unusableRuntimes ??= {})[rt.identifier] = { build: rt.buildversion, reason: 'runtime is not available', at: new Date().toISOString() }; });
      }
      throw err;
    });
    if (state.read().unusableRuntimes?.[rt.identifier]) state.update((s) => { delete s.unusableRuntimes?.[rt.identifier]; });
    const udid = r.stdout.trim().split(/\s+/).pop()!;
    const saved: Partial<DeviceSpec> = { ...spec, backend: ID, image: rt.identifier, profile: dt.identifier };
    state.update((s) => { (s.devices ??= {})[udid] = { name: spec.name, createdAt: new Date().toISOString(), spec: saved }; });
    onProgress?.(`Created ${udid}`);
    const dev = await getDevice(udid);
    if (ignored.length) dev.meta = { ...dev.meta, ignoredSpec: ignored };
    return dev;
  },

  async boot(udid, opts) {
    await findSim(udid);
    await bootAndWait(udid, opts);
  },

  async shutdown(udid) {
    await findSim(udid);
    await shutdownQuiet(udid);
    screenCache.delete(udid); pendingTurn.delete(udid);
  },

  async delete(udid) {
    managedOrThrow(udid, 'Deleting');
    if (await isBooted(udid)) await shutdownQuiet(udid);
    await simctl(['delete', udid], { timeoutMs: 120_000 });
    state.update((s) => { delete s.devices?.[udid]; });
    rmSync(join(stateDir('ios-snapshots'), udid), { recursive: true, force: true });
    screenCache.delete(udid);
    try { naturals = screenStore.update((v) => { delete v[udid]; }); } catch { /* best effort */ }
  },

  async clone(udid, newName) {
    const { dev } = await findSim(udid);
    if ((await rawDevices()).some((d) => d.dev.name === newName)) throw new PhoneDockError(`A simulator named "${newName}" already exists`, 'conflict', 409);
    const wasRunning = dev.state === 'Booted';
    if (wasRunning) {
      // simctl clone requires the source to be shut down; only do that for devices we manage
      managedOrThrow(udid, 'Cloning a running simulator (requires shutting it down)');
      await shutdownQuiet(udid);
    }
    let newUdid: string;
    try {
      const r = await simctl(['clone', udid, newName], { timeoutMs: 600_000 });
      newUdid = r.stdout.trim().split(/\s+/).pop()!;
    } finally { if (wasRunning) await bootAndWait(udid).catch(() => undefined); }
    const src = state.read().devices?.[udid];
    state.update((s) => { (s.devices ??= {})[newUdid] = { name: newName, createdAt: new Date().toISOString(), spec: { ...(src?.spec ?? {}), name: newName }, clonedFrom: udid }; });
    return getDevice(newUdid);
  },

  async listSnapshots(udid) {
    const root = snapRoot(udid);
    const out: Snapshot[] = [];
    for (const name of readdirSync(root)) {
      if (!SNAP_NAME.test(name) || !existsSync(join(root, name, 'data'))) continue;
      let createdAt: string | undefined;
      try { createdAt = JSON.parse(readFileSync(join(root, name, 'snapshot.json'), 'utf8')).createdAt; } catch { createdAt = statSync(join(root, name)).mtime.toISOString(); }
      out.push({ name, createdAt });
    }
    return out.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  },

  async saveSnapshot(udid, name) {
    managedOrThrow(udid, 'Snapshots');
    const dir = snapDir(udid, name);
    const wasRunning = await isBooted(udid);
    if (wasRunning) await shutdownQuiet(udid);
    try {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      // APFS clonefile: instant + copy-on-write
      await run('cp', ['-c', '-R', dataDir(udid), join(dir, 'data')], { timeoutMs: 600_000 });
      writeFileSync(join(dir, 'snapshot.json'), JSON.stringify({ name, createdAt: new Date().toISOString(), udid, wasRunning }));
    } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
    finally { if (wasRunning) await bootAndWait(udid); }
  },

  async restoreSnapshot(udid, name) {
    managedOrThrow(udid, 'Snapshots');
    const dir = snapDir(udid, name);
    if (!existsSync(join(dir, 'data'))) throw new PhoneDockError(`No snapshot "${name}"`, 'not_found', 404);
    const wasRunning = await isBooted(udid);
    if (wasRunning) await shutdownQuiet(udid);
    const data = dataDir(udid); const old = `${data}.pd-old-${Date.now()}`;
    try {
      if (existsSync(data)) renameSync(data, old);
      try { await run('cp', ['-c', '-R', join(dir, 'data'), data], { timeoutMs: 600_000 }); }
      catch (e) { rmSync(data, { recursive: true, force: true }); if (existsSync(old)) renameSync(old, data); throw e; }
      rmSync(old, { recursive: true, force: true });
    } finally { if (wasRunning) await bootAndWait(udid); }
    screenCache.delete(udid);
  },

  async deleteSnapshot(udid, name) {
    const dir = snapDir(udid, name);
    if (!existsSync(dir)) throw new PhoneDockError(`No snapshot "${name}"`, 'not_found', 404);
    rmSync(dir, { recursive: true, force: true });
  },

  async openWindow(udid) { await findSim(udid); await openWindow(udid); },

  // ── observation ──
  async screenshot(udid) {
    const png = await screenshotPng(udid);
    const c = screenCache.get(udid); const sz = pngSize(png);
    if (!c || c.width !== sz.width || c.height !== sz.height) screenInfoFrom(udid, png).catch(() => undefined);
    else screenAt.set(udid, Date.now());
    return png;
  },

  // fresh when older than 5 s: an app can turn the screen by itself
  async screenInfo(udid) { await requireBooted(udid); return screenInfoOf(udid, Date.now() - (screenAt.get(udid) ?? 0) > 5000); },

  stream(udid, opts) { return startStream(udid, opts); },
  async rotate(udid, orientation) { await rotateSim(udid, orientation); },

  async uiTree(udid) {
    const roots = await describeUi(udid, { fillRows: true });
    // reuse cached geometry unless the root frame (points) no longer matches it (e.g. orientation change)
    let info = screenCache.get(udid);
    const f = roots.map(nodeFrame).find((x) => x && x.width > 0);
    if (!info || !info.scale || (f && Math.abs(f.width * info.scale - info.width) > 4)) {
      screenCache.delete(udid);
      info = await screenInfoFrom(udid, await screenshotPng(udid), roots);
    }
    return { source: 'accessibility', screen: info, root: mapTree(roots, info.scale ?? 3), capturedAt: new Date().toISOString() } satisfies UiTree;
  },

  // ── input ──
  async tap(udid, x, y) {
    const s = await scaleOf(udid);
    // A real down → 60ms hold → up. AXe's instant tap was observed to be silently dropped under heavy host
    // load (an agent's taps did nothing while a 150ms long-press worked); <500ms still reads as a tap to iOS.
    try { await axe(['touch', '-x', pt(x, s), '-y', pt(y, s), '--down', '--up', '--delay', '0.06', '--udid', udid]); } catch (e) { wrapAxeError(e, 'tap'); }
  },

  async longPress(udid, x, y, durationMs) {
    const s = await scaleOf(udid);
    const sec = (Math.max(100, durationMs || 800) / 1000).toFixed(2);
    try { await axe(['touch', '-x', pt(x, s), '-y', pt(y, s), '--down', '--up', '--delay', sec, '--udid', udid]); } catch (e) { wrapAxeError(e, 'longPress'); }
  },

  async swipe(udid, x1, y1, x2, y2, durationMs) {
    const s = await scaleOf(udid);
    const sec = (Math.max(50, durationMs || 300) / 1000).toFixed(2);
    try {
      await axe(['swipe', '--start-x', pt(x1, s), '--start-y', pt(y1, s), '--end-x', pt(x2, s), '--end-y', pt(y2, s), '--duration', sec, '--udid', udid]);
    } catch (e) { wrapAxeError(e, 'swipe'); }
  },

  async type(udid, text) { await typeText(udid, text); },

  async key(udid, key: KeyName) {
    const k = String(key).toLowerCase();
    try {
      if (BUTTONS[k]) { await axe(['button', BUTTONS[k], '--udid', udid]); return; }
      if (HID[k] !== undefined) { await axe(['key', String(HID[k]), '--udid', udid]); return; }
      // Cmd+A (left GUI 227 + "a" 4): select all in a text field; the simulator treats AXe as a hardware keyboard
      if (k === 'select_all') { await axe(['key-combo', '--modifiers', '227', '--key', '4', '--udid', udid]); return; }
      if (k === 'back') {
        // iOS has no hardware back: emulate the interactive-pop edge swipe.
        const info = await screenInfoOf(udid); const s = info.scale ?? 3;
        const w = info.width / s, h = info.height / s;
        await axe(['swipe', '--start-x', '2', '--start-y', String(Math.round(h / 2)), '--end-x', String(Math.round(w * 0.6)), '--end-y', String(Math.round(h / 2)), '--duration', '0.3', '--udid', udid]);
        return;
      }
      if (k === 'app_switch') {
        // Double-press the simulated Home button in one HID session → app switcher (Face ID devices too). AXe's
        // swipe up from the home indicator can't hold before lifting and is ignored by SpringBoard (iOS 26 sims).
        await axe(['batch', '--udid', udid, '--step', 'button home', '--step', 'sleep 0.12', '--step', 'button home']);
        return;
      }
      const raw = k.match(/^(?:hid:)?(\d{1,3})$/);
      if (raw && +raw[1] <= 255) { await axe(['key', raw[1], '--udid', udid]); return; }
    } catch (e) { wrapAxeError(e, `key ${k}`); }
    throw new PhoneDockError('The key is not supported on the iOS simulator', 'not_supported', 400, undefined,
      `Key: ${key}. Supported: home, lock/power, siri, back (edge swipe), app_switch, enter, delete, tab, escape, space, up/down/left/right, select_all (Cmd+A), or a raw HID usage like "hid:40". volume_up/volume_down/screenshot have no simulator HID equivalent.`);
  },

  // ── apps / system ──
  async installApp(udid, path) {
    if (!existsSync(path)) throw new PhoneDockError('Couldn’t find the file', 'not_found', 404, undefined, `No such file: ${path}`);
    let app = path; let tmp: string | undefined;
    try {
      const ext = extname(path).toLowerCase();
      if (ext === '.ipa' || ext === '.zip') {
        tmp = mkdtempSync(join(tmpdir(), 'pd-ipa-'));
        await run('ditto', ['-x', '-k', path, tmp], { timeoutMs: 300_000 });
        const found = findApp(tmp);
        if (!found) throw new PhoneDockError('The archive does not contain an app', 'bad_app', 400, undefined, 'No .app bundle found inside the archive');
        app = found;
      } else if (!(ext === '.app' && statSync(path).isDirectory())) {
        throw new PhoneDockError('The app file format is not supported', 'bad_app', 400, ['Choose a supported app file.'], 'Expected a .app directory, .ipa or .zip');
      }
      const plist = join(app, 'Info.plist');
      if (!existsSync(plist)) throw new PhoneDockError('The app is missing required information', 'bad_app', 400, undefined, `${basename(app)} has no Info.plist`);
      const info = await plistJson(plist);
      await assertSimulatorBuild(app, info);
      await requireBooted(udid);
      await simctl(['install', udid, app], { timeoutMs: 300_000 });
      return {
        id: String(info.CFBundleIdentifier),
        name: (info.CFBundleDisplayName ?? info.CFBundleName) as string | undefined,
        version: info.CFBundleShortVersionString as string | undefined,
        system: false,
      } satisfies AppInfo;
    } finally { if (tmp) rmSync(tmp, { recursive: true, force: true }); }
  },

  async uninstallApp(udid, appId) { await simctl(['uninstall', udid, appId], { timeoutMs: 120_000 }); },

  async listApps(udid: string, opts?: { system?: boolean }) {
    await requireBooted(udid);
    const r = await simctl(['listapps', udid]);
    const j = await run('plutil', ['-convert', 'json', '-o', '-', '-'], { input: r.stdout });
    const apps = JSON.parse(j.stdout) as Record<string, Record<string, unknown>>;
    return Object.entries(apps).map(([id, a]): AppInfo => ({
      id,
      name: (a.CFBundleDisplayName ?? a.CFBundleName ?? a.CFBundleExecutable) as string | undefined,
      version: a.CFBundleShortVersionString as string | undefined,
      system: a.ApplicationType === 'System',
    })).filter((a) => opts?.system || !a.system) // like Android: user apps only unless system apps are asked for
      .sort((a, b) => Number(a.system) - Number(b.system) || a.id.localeCompare(b.id));
  },

  async getAppearance(udid) {
    await requireBooted(udid);
    const out = (await simctl(['ui', udid, 'appearance'])).stdout.trim().toLowerCase();
    return out === 'dark' || out === 'light' ? out : 'unknown';
  },
  async setAppearance(udid, mode) {
    await requireBooted(udid);
    await simctl(['ui', udid, 'appearance', mode]);
  },

  // simctl pbcopy/pbpaste: plain UTF-8 text, exact (trailing newlines, emoji); the text only ever travels on stdin/stdout.
  // An empty pasteboard and one without text both read as "".
  async clipboardGet(udid) {
    await requireBooted(udid);
    const out = (await simctl(['pbpaste', udid], { timeoutMs: 20_000, failureMessage: 'Couldn’t read the simulator’s clipboard' })).stdout;
    return out === '' ? null : out;
  },
  async clipboardSet(udid, text) {
    await requireBooted(udid);
    await simctl(['pbcopy', udid], { input: text, timeoutMs: 20_000, failureMessage: 'Couldn’t set the simulator’s clipboard' });
  },

  async launchApp(udid, appId) {
    // Under heavy host load `simctl launch` can block long after the app is up (seen: SIGKILL at 60s while
    // the app was already foreground). On failure, check launchd for the app before reporting an error.
    try { await simctl(['launch', udid, appId], { timeoutMs: 120_000 }); }
    catch (e) {
      const r = await run('xcrun', ['simctl', 'spawn', udid, 'launchctl', 'list'], { env: toolEnv(), allowFail: true, timeoutMs: 30_000 });
      if (r.stdout.includes(`UIKitApplication:${appId}[`)) return;
      throw e;
    }
  },

  async terminateApp(udid, appId) {
    const r = await simctl(['terminate', udid, appId], { allowFail: true });
    if (r.code !== 0 && !/found nothing to terminate|not running/i.test(r.stderr)) throw new PhoneDockError('Couldn’t stop the app', 'exec_failed', 500, undefined, `terminate failed: ${r.stderr.trim()}`);
  },

  async openUrl(udid, url) { await simctl(['openurl', udid, url]); },

  async shell(udid, command) {
    const argv = splitArgs(command);
    if (!argv.length) throw new PhoneDockError('Empty command', 'bad_request', 400);
    const r = await simctl(['spawn', udid, ...argv], { allowFail: true, timeoutMs: 120_000 });
    // a program that isn't in the simulated system: simctl only says NSPOSIXErrorDomain code=2 (blind run 1: sw_vers)
    const missing = r.code !== 0 && /NSPOSIXErrorDomain, code=2\b/.test(r.stderr) && !argv[0].includes('/');
    const hint = missing ? `\nHint: there is no "${argv[0]}" in the iOS simulator. It has no Unix shell (no sh, bash, ls, cat, sw_vers); `
      + 'it has launchctl, log, defaults, notifyutil, df and a few debugging tools. Its iOS version is in list_devices (os=…); '
      + 'files of an app are reachable with pull_file / push_file.' : '';
    return { stdout: r.stdout, stderr: r.stderr + hint, code: r.code } satisfies ExecResult;
  },

  async pushFile(udid, localPath, remotePath) {
    if (!existsSync(localPath)) throw new PhoneDockError('Couldn’t find the file', 'not_found', 404, undefined, `No such file: ${localPath}`);
    if (/^(photos|media):/i.test(remotePath)) { await simctl(['addmedia', udid, localPath], { timeoutMs: 120_000 }); return; }
    const dest = await resolveRemote(udid, remotePath);
    const target = remotePath.endsWith('/') ? join(dest, basename(localPath)) : dest;
    mkdirSync(resolve(target, '..'), { recursive: true });
    cpSync(localPath, target, { recursive: true });
  },

  async pullFile(udid, remotePath, localPath) {
    const src = await resolveRemote(udid, remotePath);
    if (!existsSync(src)) throw new PhoneDockError("Couldn’t find the file on the device", 'not_found', 404, undefined, `No such file on device: ${remotePath}`);
    cpSync(src, localPath, { recursive: true });
  },

  async logs(udid, opts = {}) {
    const lines = Math.max(1, Math.min(20_000, opts.lines ?? 300));
    const r = await simctl(['spawn', udid, 'log', 'show', '--last', '2m', '--style', 'compact'], { timeoutMs: 120_000, maxBuffer: 512 * 1024 * 1024 });
    let all = r.stdout.split('\n').filter((l) => l.trim());
    if (opts.filter) { const f = opts.filter.toLowerCase(); all = all.filter((l) => l.toLowerCase().includes(f)); }
    return all.slice(-lines).join('\n');
  },

  async setLocation(udid, lat, lon) { await simctl(['location', udid, 'set', `${lat},${lon}`]); },

  async pushNotification(udid, appId, payload) {
    const dir = mkdtempSync(join(tmpdir(), 'pd-push-'));
    try {
      const f = join(dir, 'payload.json');
      writeFileSync(f, JSON.stringify(payload.aps ? payload : { aps: payload }));
      await simctl(['push', udid, appId, f]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },

  // ── v0.2 ──
  async doubleTap(udid, x, y) {
    const s = await scaleOf(udid);
    const step = `tap -x ${pt(x, s)} -y ${pt(y, s)}`;
    // One AXe HID session for both taps (two `axe tap` processes are ~150ms+ apart and may not pair up).
    try { await axe(['batch', '--udid', udid, '--step', step, '--step', step]); } catch (e) { wrapAxeError(e, 'doubleTap'); }
  },
  async foregroundApp(udid) { return foregroundAppOf(udid); },
  async listCrashes(udid, opts) { return listSimCrashes(udid, opts); },
  async getCrash(udid, id) { return getSimCrash(udid, id); },
  async startRecording(udid, outPath, opts) { await startSimRecording(udid, outPath, opts); },
  async stopRecording(udid) { return stopSimRecording(udid); },
  async exportAppData(udid, appId, outDir) { await exportSimAppData(udid, appId, outDir); },
  async importAppData(udid, appId, fromDir) { await importSimAppData(udid, appId, fromDir); },

  // ── performance traces (xctrace; see ios-trace.ts) ──
  async startTrace(udid, dir, o) {
    await requireBooted(udid);
    let pid = await simAppPid(udid, o.appId); let launched = false;
    if (!pid) {
      const installed = await simctl(['get_app_container', udid, o.appId], { allowFail: true, timeoutMs: 30_000 });
      if (installed.code !== 0) throw new PhoneDockError('The app is not installed on this simulator', 'app_not_installed', 404, [`Install ${o.appId} first, or check the bundle id with list_apps.`], `simctl get_app_container ${o.appId}: ${installed.stderr.trim().slice(0, 300)}`);
      if (!o.launch) throw new PhoneDockError('The app is not running', 'app_not_running', 409, [`Open ${o.appId} first (launch it), or pass launch: true.`], `No UIKitApplication:${o.appId} job in the simulator's launchctl list`);
      await backend.launchApp!(udid, o.appId); launched = true;
      for (let i = 0; i < 40 && !pid; i++) { await sleep(500); pid = await simAppPid(udid, o.appId); }
      if (!pid) throw new PhoneDockError('The app did not start', 'app_not_running', 409, [`Open ${o.appId} by hand and try again.`], `No pid for ${o.appId} 20 s after launching it`);
    }
    return startXctrace(udid, dir, { device: udid, template: o.template, pid, appId: o.appId, timeLimitSec: o.timeLimitSec, physical: false, launched });
  },
  async stopTrace(udid) { return stopXctrace(udid); },
  async abortTrace(udid) { await abortXctrace(udid); },

  async info(udid) {
    const [{ runtime, dev }, rts, types] = await Promise.all([findSim(udid), runtimes(), deviceTypes()]);
    return {
      device: dev,
      runtime: rts.find((r) => r.identifier === runtime) ?? { identifier: runtime },
      deviceType: types.find((t) => t.identifier === dev.deviceTypeIdentifier),
      managed: state.read().devices?.[udid] ?? null,
      screen: screenCache.get(udid) ?? null,
      snapshots: existsSync(join(stateDir('ios-snapshots'), udid)) ? readdirSync(join(stateDir('ios-snapshots'), udid)) : [],
      notes: ['key back = left-edge swipe (iOS has no hardware back)', 'rotate: xcrun devicectl device orientation (apps that keep portrait, like the iPhone home screen and Settings, do not turn)',
        'pinch / hideKeyboard are not supported (AXe has no multi-touch; no reliable keyboard dismissal)'],
    };
  },
};
