// Physical iPhone/iPad backend (EXPERIMENTAL).
// - Inventory, apps, info, screenshots, recording, crash logs, app data, location and openURL via
//   `xcrun devicectl` (CoreDevice; Xcode 26+/27 for capture/orientation/simulate) – no WebDriverAgent needed.
// - Screenshot order: devicectl `capture screenshot` (verified over Wi-Fi on iOS 27: ~0.9 s, full-res PNG),
//   then WebDriverAgent /screenshot, then `pymobiledevice3 developer dvt screenshot --native` (Apple's remoted tunnel).
// - Input + UI tree via WebDriverAgent (appium/WebDriverAgent) at PHONEDOCK_WDA_URL or
//   stateDir/ios-device.json → { "<id>": { name?, address?, wdaUrl, udid? } }. WDA works in points.
// - Wi-Fi: devicectl lists network-paired devices (transportType "localNetwork"); iPhones reachable only via a
//   WDA URL (http://<iphone-ip>:8100) are "manual" entries (nativeId = udid if known, else wda-<host>-<port>).
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { run, runBuffer, type RunOptions } from '../core/exec.ts';
import { developerDir, stateDir, toolEnv, which } from '../core/paths.ts';
import {
  PhoneDockError,
  type AppInfo, type Availability, type Backend, type Capability, type CrashReport, type Device, type DeviceState, type KeyName,
  type ScreenInfo, type UiElement, type UiTree,
} from '../core/types.ts';
import { JsonState, ScreenshotRecorder, finalizeMp4, ipsKind, ipsRender, ipsSummary, ipsTime, parseIps, pngSize } from './ios-common.ts';
import { hidCombo, hidDoubleTap, hidKey, hidLongPress, hidSwipe, hidTap, hidType, hidTypable, isNativeInputCapable, type Geometry } from './ios-hid.ts';
import { isNativeCapable, nativeSession, nativeUiTree } from './ios-native.ts';
import { abortXctrace, startXctrace, stopXctrace } from './ios-trace.ts';

const ID = 'ios-device';
// devicectl-only features (no WDA): screenshot, record, crashes, appData, location, openUrl. No 'rotate': devicectl's
// orientation command is documented as simulated orientation and does nothing on a real iPhone.
const DC_CAPS: Capability[] = ['screenshot', 'ocr', 'install', 'apps', 'launch', 'openUrl', 'record', 'crashes', 'appData', 'location', 'trace'];
const CAPS: Capability[] = [...DC_CAPS, 'uiTree', 'tap', 'longPress', 'swipe', 'type', 'key'];
const BASE_CAPS: Capability[] = DC_CAPS;
const WDA_ONLY_CAPS: Capability[] = ['screenshot', 'uiTree', 'ocr', 'tap', 'longPress', 'swipe', 'type', 'key', 'launch', 'openUrl'];
// iOS 27+ without WDA: real touch/keyboard/buttons via the CoreDevice HID sidecar (ios-hid.ts) and the accessibility
// tree via remoteAXService (ios-native.ts, read-only); the daemon falls back to OCR when the tree is unavailable.
const NATIVE_CAPS: Capability[] = [...DC_CAPS, 'tap', 'longPress', 'swipe', 'type', 'key', 'doubleTap'];
function nativeCaps(osv?: string): Capability[] { return isNativeCapable(osv) ? [...NATIVE_CAPS, 'uiTree'] : NATIVE_CAPS; }
const osByUdid = new Map<string, string>();
/** Use the native HID path when no WDA is configured and the phone runs iOS 27+. */
function nativeInput(udid: string): boolean {
  if (wdaUrl(udid)) return false;
  let dc: string; try { dc = dcId(udid); } catch { return false; }
  return isNativeInputCapable(osByUdid.get(dc));
}
async function ensureNative(udid: string): Promise<boolean> {
  if (wdaUrl(udid)) return false;
  let dc: string; try { dc = dcId(udid); } catch { return false; }
  if (!osByUdid.has(dc)) {
    const d = await findDev(dc).catch(() => undefined);
    const v = (d as any)?.deviceProperties?.osVersionNumber;
    if (v) osByUdid.set(dc, String(v));
  }
  const ok = nativeInput(udid);
  if (ok) axWarm(dc);
  return ok;
}
/** The first accessibility tree after connecting takes 10-25 s (the phone attaches to the app); later ones ~1 s.
 *  Start the subscription in the background as soon as an agent starts driving the phone (input or launch). */
const axWarmAt = new Map<string, number>();
function axWarm(dc: string): void {
  if (!isNativeCapable(osByUdid.get(dc)) || Date.now() - (axWarmAt.get(dc) ?? 0) < 60_000) return;
  axWarmAt.set(dc, Date.now());
  nativeSession(dc).request('ui', { warm: true }).catch(() => { axWarmAt.delete(dc); });
}
const geoCache = new Map<string, { at: number; w: number; h: number }>();
function nativeGeo(udid: string): Geometry {
  return async () => {
    const dc = dcId(udid);
    const c = geoCache.get(dc);
    if (c && Date.now() - c.at < 600_000) return { width: c.w, height: c.h };
    const v = await displayInfo(dc);
    if (!v.width || !v.height) throw new PhoneDockError('Could not read the iPhone screen size', 'device_error', 502);
    geoCache.set(dc, { at: Date.now(), w: v.width, h: v.height });
    return { width: v.width, height: v.height };
  };
}

export interface DevCfg { name?: string; address?: string; wdaUrl?: string; udid?: string; savedAt?: string }
const cfgState = new JsonState<Record<string, DevCfg>>('ios-device.json');

/** Config entry for a nativeId: keyed directly, or an entry whose udid matches. */
function cfgFor(nativeId: string): DevCfg | undefined {
  const all = cfgState.read();
  return all[nativeId] ?? Object.values(all).find((c) => c.udid === nativeId);
}

/** nativeId for a WDA URL when the udid is unknown: wda-<host>-<port>. */
export function wdaNativeId(url: string): string {
  const u = new URL(url);
  return `wda-${u.hostname.replace(/^\[|\]$/g, '')}-${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
}

/** "192.168.1.20" | "192.168.1.20:8100" | "http://…:8100" → normalized WDA base URL. */
export function normalizeWdaUrl(input: string): string {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = /:\d+$/.test(s) && !s.includes('::') ? `http://${s}` : `http://${s.includes(':') && !s.startsWith('[') ? `[${s}]` : s}:8100`;
  const u = new URL(s);
  return `${u.protocol}//${u.host}`.replace(/\/+$/, '');
}

// ── devicectl ──────────────────────────────────────────────────────────────

async function devicectl<T = any>(args: string[], opts: RunOptions = {}): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'pd-devicectl-'));
  const out = join(dir, 'out.json');
  try {
    const r = await run('xcrun', ['devicectl', ...args, '--json-output', out, '--quiet'], { env: toolEnv(), allowFail: true, timeoutMs: 120_000, ...opts });
    let j: any;
    try { j = JSON.parse(readFileSync(out, 'utf8')); } catch { /* no json */ }
    if (r.code !== 0 || j?.info?.outcome === 'failed') {
      const msg = j?.error?.userInfo?.NSLocalizedDescription?.string ?? j?.error?.description ?? (r.stderr.trim() || `exit ${r.code}`);
      throw devicectlError(args, String(msg), j?.error);
    }
    return j?.result as T;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Map a devicectl failure to a PhoneDockError with a useful status + hints. */
function devicectlError(args: string[], msg: string, err?: any): PhoneDockError {
  const what = `devicectl ${args.filter((a) => !a.startsWith('-')).slice(0, 3).join(' ')}`;
  const text = `${what} failed: ${msg.slice(0, 800)}`;
  if (/not supported by this device|is not supported|unsupported/i.test(msg) || err?.userInfo?.CapabilityFeatureIdentifier) {
    return new PhoneDockError('This device does not support the action', 'not_supported', 501, undefined, `${text}\nCheck xcrun devicectl device info details`);
  }
  if (/locked|passcode/i.test(msg)) return new PhoneDockError('The iPhone is locked', 'device_locked', 409, ['Unlock the iPhone and try again'], text);
  if (/developer mode/i.test(msg)) return new PhoneDockError('Developer Mode is off', 'developer_mode_off', 409, ['Enable Developer Mode in Settings'], text);
  if (/disk image|DDI|ddi/i.test(msg)) return new PhoneDockError('The developer disk image is unavailable', 'ddi_missing', 409, ['Open Xcode’s Devices and Simulators with the phone connected'], `${text}\nMount the developer disk image: xcrun devicectl device info ddiServices --auto-mount-ddis --device <udid>`);
  if (/not found|no such file|does not exist/i.test(msg)) return new PhoneDockError('Couldn’t find the requested item', 'not_found', 404, undefined, text);
  return new PhoneDockError('Couldn’t complete the iPhone action', 'device_error', 502, ['Unlock the device, trust this Mac and enable Developer Mode'], text);
}

interface DcDevice {
  identifier: string;
  properties?: any; hardwareProperties?: any; deviceProperties?: any; connectionProperties?: any;
}

const hw = (d: DcDevice) => d.properties?.hardware ?? d.hardwareProperties ?? {};
const conn = (d: DcDevice) => d.properties?.connection ?? d.connectionProperties ?? {};
const sw = (d: DcDevice) => d.properties?.software ?? {};
const st = (d: DcDevice) => d.properties?.state ?? d.deviceProperties ?? {};

let listCache: { at: number; list: DcDevice[] } | undefined;
async function physicalDevices(force = false): Promise<DcDevice[]> {
  if (!force && listCache && Date.now() - listCache.at < 3000) return listCache.list;
  const r = await devicectl<{ devices?: DcDevice[] }>(['list', 'devices'], { timeoutMs: 60_000 });
  const list = (r?.devices ?? []).filter((d) => {
    const h = hw(d);
    return h.reality !== 'simulated' && /^(iOS|iPadOS)$/i.test(h.platform ?? '') ;
  });
  listCache = { at: Date.now(), list };
  return list;
}

async function findDev(udid: string): Promise<DcDevice> {
  const d = (await physicalDevices()).find((x) => hw(x).udid === udid || x.identifier === udid);
  if (!d) throw new PhoneDockError('Could not find the connected iPhone', 'not_found', 404, ['Connect and unlock the iPhone.'], `No connected iOS device ${udid}; connect by USB or pair for Wi-Fi`);
  return d;
}

/** Paired + reachable = running. tunnelState / properties.connection.state "disconnected" only means no tunnel is
 *  open right now (devicectl opens one on demand), so it is still usable; only "unavailable" is offline. */
function mapState(d: DcDevice): DeviceState {
  const c = conn(d), legacy = d.connectionProperties ?? {};
  const pairing = c.pairingState ?? legacy.pairingState;
  if (pairing && pairing !== 'paired') return 'unauthorized';
  const tunnel = legacy.tunnelState ?? c.tunnelState ?? c.state;
  if (tunnel === 'unavailable') return 'offline';
  return 'running';
}

/** developerModeStatus is a string ("enabled") in the legacy keys and {"enabled":{…}} in properties.state. */
function devModeOf(d: DcDevice): boolean | undefined {
  const v = d.deviceProperties?.developerModeStatus ?? st(d).developerModeStatus;
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v === 'enabled';
  if (typeof v === 'object') return 'enabled' in v ? true : 'disabled' in v ? false : undefined;
  return undefined;
}

function transportOf(d: DcDevice): string | undefined { return conn(d).transportType ?? d.connectionProperties?.transportType; }

// ── WebDriverAgent ─────────────────────────────────────────────────────────

function wdaUrl(udid: string): string | undefined {
  const u = cfgFor(udid)?.wdaUrl ?? process.env.PHONEDOCK_WDA_URL;
  return u?.replace(/\/+$/, '');
}

/** devicectl id for a nativeId (manual WDA-only entries have none unless a udid was given). */
function dcId(nativeId: string): string {
  if (!nativeId.startsWith('wda-')) return nativeId;
  const u = cfgFor(nativeId)?.udid;
  if (!u) throw new PhoneDockError('This action requires a paired iPhone', 'not_supported', 501,
    ['Pair the iPhone with this Mac.'], `${nativeId} is connected via WebDriverAgent only; pair by USB in Xcode/Finder, then reconnect with phonedock connect --ios <ip> --udid <udid>`);
  return u;
}

export interface WdaStatus { ok: boolean; status?: any; error?: string }
const statusCache = new Map<string, { at: number; v: WdaStatus }>();
/** GET /status (short timeout, cached 5 s). */
export async function wdaStatus(base: string, timeoutMs = 2500, fresh = false): Promise<WdaStatus> {
  const c = statusCache.get(base);
  if (!fresh && c && Date.now() - c.at < 5000) return c.v;
  let v: WdaStatus;
  try {
    const res = await fetch(base + '/status', { signal: AbortSignal.timeout(timeoutMs) });
    const j: any = await res.json().catch(() => ({}));
    v = res.ok ? { ok: true, status: j.value ?? j } : { ok: false, error: `HTTP ${res.status}` };
  } catch (e) { v = { ok: false, error: (e as Error).message }; }
  statusCache.set(base, { at: Date.now(), v });
  return v;
}

function wdaDetail(udid: string): string {
  return [
    'iPhones on iOS 27 or later need no WebDriverAgent (touch, keyboard and the UI tree go over USB or Wi-Fi via CoreDevice); this path is for older iOS.',
    'Build + run WebDriverAgent on the device: git clone https://github.com/appium/WebDriverAgent && cd WebDriverAgent && ' +
      `xcodebuild -project WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner -destination id=${udid} -allowProvisioningUpdates test`,
    'Forward its port: iproxy 8100 8100  (or: pymobiledevice3 usbmux forward 8100 8100)',
    'Then set PHONEDOCK_WDA_URL=http://127.0.0.1:8100, or add {"<udid>": {"wdaUrl": "http://127.0.0.1:8100"}} to ios-device.json in the PhoneDock state dir',
  ].join('\n');
}

const sessions = new Map<string, string>();

async function wdaFetch(base: string, method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<any> {
  let res: Response;
  try {
    res = await fetch(base + path, {
      method, headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new PhoneDockError('Couldn’t reach the iPhone service', 'wda_unreachable', 502, ['Check that WebDriverAgent is running'], `WebDriverAgent at ${base} is not reachable: ${(e as Error).message}\nIs WebDriverAgentRunner running and the port forwarded (iproxy 8100 8100)?`);
  }
  const text = await res.text();
  let j: any; try { j = JSON.parse(text); } catch { j = { value: text }; }
  if (!res.ok || (j?.value && typeof j.value === 'object' && j.value.error)) {
    const err = j?.value?.message ?? j?.value?.error ?? text.slice(0, 300);
    const e = new PhoneDockError('Couldn’t complete the iPhone action', 'wda_error', res.status === 404 ? 404 : 502, undefined, `WebDriverAgent ${method} ${path}: ${err}`);
    (e as any).wdaSessionGone = /invalid session|session.*(not|does not) exist/i.test(String(err)) || (res.status === 404 && path.startsWith('/session/') && /session/i.test(String(err)));
    throw e;
  }
  return j;
}

async function wda(udid: string): Promise<{ base: string; session: () => Promise<string> }> {
  const base = wdaUrl(udid);
  if (!base) throw new PhoneDockError('Could not control or inspect the iPhone', 'not_supported', 501, ['Set up WebDriverAgent on the iPhone.'], wdaDetail(udid));
  return {
    base,
    session: async () => {
      const s = sessions.get(base);
      if (s) return s;
      const j = await wdaFetch(base, 'POST', '/session', { capabilities: { alwaysMatch: {}, firstMatch: [{}] } });
      const id = j.sessionId ?? j.value?.sessionId;
      if (!id) throw new PhoneDockError('Could not start an iPhone session', 'wda_error', 502, undefined, 'WebDriverAgent did not return a session id');
      sessions.set(base, id);
      return id;
    },
  };
}

/** Call a session-scoped WDA endpoint, re-creating the session once if it expired. */
async function wdaSession(udid: string, method: string, sub: string, body?: unknown): Promise<any> {
  const w = await wda(udid);
  for (let attempt = 0; ; attempt++) {
    const sid = await w.session();
    try { return await wdaFetch(w.base, method, `/session/${sid}${sub}`, body); }
    catch (e) { if (attempt === 0 && (e as any).wdaSessionGone) { sessions.delete(w.base); continue; } throw e; }
  }
}

const scaleCache = new Map<string, number>();
async function wdaScale(udid: string): Promise<number> {
  const c = scaleCache.get(udid); if (c) return c;
  const j = await wdaSession(udid, 'GET', '/wda/screen');
  const s = Number(j.value?.scale) || 3;
  scaleCache.set(udid, s);
  return s;
}

const p = (v: number, s: number) => Math.round((v / s) * 10) / 10;

interface WdaNode { type?: string; label?: string | null; name?: string | null; value?: string | null; rect?: { x: number; y: number; width: number; height: number }; isEnabled?: boolean | string; isVisible?: boolean | string; children?: WdaNode[] }

function mapWdaTree(root: WdaNode, scale: number): UiElement[] {
  let n = 0;
  const conv = (node: WdaNode): UiElement[] => {
    const kids = (node.children ?? []).flatMap(conv);
    const r = node.rect;
    if (!r || r.width <= 0 || r.height <= 0) return kids;
    const type = (node.type ?? 'Element').replace(/^XCUIElementType/, '');
    const el: UiElement = { ref: `e${++n}`, type, bounds: { x: Math.round(r.x * scale), y: Math.round(r.y * scale), width: Math.round(r.width * scale), height: Math.round(r.height * scale) } };
    if (node.label) { el.label = node.label; el.text = node.label; }
    if (node.value != null && node.value !== '') { el.value = String(node.value); el.text ??= el.value; }
    if (node.name && node.name !== node.label) el.id = node.name;
    if (node.isEnabled !== undefined) el.enabled = node.isEnabled === true || node.isEnabled === '1' || node.isEnabled === 'true';
    if (/Button|Cell|TextField|SecureTextField|Switch|Link|Key|Tab|Slider|Icon|SearchField|MenuItem/.test(type)) el.clickable = true;
    if (/ScrollView|Table|CollectionView|WebView/.test(type)) el.scrollable = true;
    if (kids.length) el.children = kids;
    return [el];
  };
  const tree = conv(root);
  let k = 0; const renum = (els: UiElement[]) => { for (const e of els) { e.ref = `e${++k}`; if (e.children) renum(e.children); } }; renum(tree);
  return tree;
}

// ── screenshots ────────────────────────────────────────────────────────────

/** Primary path: `devicectl device capture screenshot` (CoreDevice; works over USB and Wi-Fi, no WDA/tunneld).
 *  Verified on an iPhone 16 Pro Max / iOS 27.0 over Wi-Fi: ~0.8 s warm, ~3 s cold, 1320x2868 PNG. */
async function devicectlScreenshot(udid: string): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'pd-iosdev-shot-'));
  try {
    const f = join(dir, 's.png');
    await devicectl(['device', 'capture', 'screenshot', '--device', udid, '--destination', f], { timeoutMs: 45_000 });
    const png = readFileSync(f);
    pngSize(png); // throws if not a PNG
    return png;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Last resort: pymobiledevice3 via Apple's own remoted tunnel (`--native`, macOS, no root). */
async function pmdScreenshot(udid: string): Promise<Buffer> {
  const pmd = which('pymobiledevice3');
  if (!pmd) throw new PhoneDockError("Couldn’t take a screenshot of the iPhone", 'screenshot_failed', 502, ["Unlock the iPhone and try again."], ['No screenshot path left for this iPhone (devicectl failed, no WebDriverAgent, no pymobiledevice3)', ...['Unlock the iPhone; check `xcrun devicectl device capture screenshot --device <udid> --destination /tmp/x.png` works', 'Or configure WebDriverAgent (PHONEDOCK_WDA_URL)']].filter(Boolean).join('\n'));
  const dir = mkdtempSync(join(tmpdir(), 'pd-iosdev-shot-'));
  const f = join(dir, 's.png');
  try {
    const r = await run(pmd, ['developer', 'dvt', 'screenshot', '--native', '--udid', udid, f], { env: toolEnv(), allowFail: true, timeoutMs: 60_000 });
    if (r.code !== 0 || !existsSync(f)) {
      throw new PhoneDockError("Couldn’t take a screenshot of the iPhone", 'screenshot_failed', 502, ["Unlock the iPhone and enable Developer Mode."], [`pymobiledevice3 screenshot failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ').slice(0, 600)}`, ...[
        'Unlock the iPhone and make sure Developer Mode is on and the developer disk image is mounted (xcrun devicectl device info ddiServices --device <udid>)',
        'Or configure WebDriverAgent (PHONEDOCK_WDA_URL) – its /screenshot works too',
      ]].filter(Boolean).join('\n'));
    }
    return readFileSync(f);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** devicectl → WDA → pymobiledevice3 --native. Errors from every attempted path are combined. */
async function screenshotAny(nativeId: string): Promise<Buffer> {
  const errors: string[] = [];
  let udid: string | undefined;
  try { udid = dcId(nativeId); } catch { /* WDA-only entry */ }
  if (udid) {
    try { return await devicectlScreenshot(udid); } catch (e) { errors.push((e as PhoneDockError).detail ?? (e as Error).message); }
  }
  const base = wdaUrl(nativeId);
  if (base) {
    try {
      const j = await wdaFetch(base, 'GET', '/screenshot', undefined, 30_000);
      return Buffer.from(String(j.value), 'base64');
    } catch (e) { errors.push((e as PhoneDockError).detail ?? (e as Error).message); }
  }
  if (udid) {
    try { return await pmdScreenshot(udid); } catch (e) { errors.push((e as PhoneDockError).detail ?? (e as Error).message); }
  }
  throw new PhoneDockError("Couldn’t take a screenshot of the iPhone", 'screenshot_failed', 502, ["Unlock the iPhone and try again."], [`Screenshot failed: ${errors.join(' | ')}`, ...[
    'Unlock the iPhone (screenshots fail while it is locked on some iOS versions)',
    'Check: xcrun devicectl device capture screenshot --device <udid> --destination /tmp/x.png',
  ]].filter(Boolean).join('\n'));
}

// ── readiness (paired / locked / Developer Mode / DDI) ────────────────────

export interface Readiness {
  paired: boolean; transport?: string; tunnel?: string;
  locked: boolean | null; developerMode: boolean | null; ddi: boolean | null;
  checkedAt?: string; hints: string[];
}
const lockCache = new Map<string, { at: number; locked: boolean | null; pending?: Promise<void> }>();

/** `devicectl device info lockState` → passcodeRequired (true = locked right now). Verified read-only on iOS 27. */
async function probeLock(udid: string): Promise<boolean | null> {
  const r = await devicectl<{ passcodeRequired?: boolean; unlockedSinceBoot?: boolean }>(['device', 'info', 'lockState', '--device', udid], { timeoutMs: 20_000 });
  return typeof r?.passcodeRequired === 'boolean' ? r.passcodeRequired : null;
}

function readinessOf(d: DcDevice, locked: boolean | null, checkedAt?: number): Readiness {
  const c = conn(d), legacy = d.connectionProperties ?? {};
  const pairing = c.pairingState ?? legacy.pairingState;
  const tunnel = legacy.tunnelState ?? c.tunnelState ?? c.state;
  const devMode = devModeOf(d) ?? null;
  const ddiRaw = d.deviceProperties?.ddiServicesAvailable ?? st(d).ddiServicesAvailable;
  const ddi = typeof ddiRaw === 'boolean' ? ddiRaw : null;
  const udid = hw(d).udid ?? d.identifier;
  const hints: string[] = [];
  if (pairing && pairing !== 'paired') hints.push('Pair the iPhone: connect it by USB once and tap "Trust" (Wi-Fi pairing: Xcode › Devices and Simulators)');
  if (tunnel === 'unavailable') hints.push('The iPhone is not reachable: plug it in, or put it on the same Wi-Fi as this Mac and unlock it');
  if (devMode === false) hints.push('Enable Developer Mode: Settings › Privacy & Security › Developer Mode, then restart the iPhone');
  if (locked === true) hints.push('Unlock the iPhone (capture/launch need it unlocked)');
  if (ddi === false) hints.push(`Mount the developer disk image: xcrun devicectl device info ddiServices --auto-mount-ddis --device ${udid} (or open Xcode › Devices and Simulators once)`);
  return { paired: !pairing || pairing === 'paired', transport: transportOf(d), tunnel, locked, developerMode: devMode, ddi, checkedAt: checkedAt ? new Date(checkedAt).toISOString() : undefined, hints };
}

/** Non-blocking: cached lock state, refreshed in the background (listDevices must stay fast). */
function cachedReadiness(d: DcDevice): Readiness {
  const udid = hw(d).udid ?? d.identifier;
  const c = lockCache.get(udid);
  if (mapState(d) === 'running' && (!c || (Date.now() - c.at > 30_000 && !c.pending))) {
    const entry = c ?? { at: 0, locked: null };
    entry.pending = probeLock(udid).then((v) => { entry.locked = v; }, () => { /* keep last */ }).finally(() => { entry.at = Date.now(); entry.pending = undefined; });
    lockCache.set(udid, entry);
  }
  return readinessOf(d, c?.locked ?? null, c?.at || undefined);
}

/** Cache an async call per key for ttlMs; concurrent callers share one in-flight call; failures aren't cached. */
const callCache = new Map<string, { at: number; v?: unknown; p?: Promise<unknown> }>();
function cachedCall<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const c = callCache.get(key);
  if (c?.p) return c.p as Promise<T>;
  if (c && Date.now() - c.at < ttlMs) return Promise.resolve(c.v as T);
  const p = fn().then((v) => { callCache.set(key, { at: Date.now(), v }); return v; }, (e) => { if (c) callCache.set(key, c); else callCache.delete(key); throw e; });
  callCache.set(key, { at: c?.at ?? 0, v: c?.v, p });
  return p;
}

/** The short, human-facing device summary (name, model, OS + build, screen, connection) shown by `phonedock info`. */
function infoSummary(d: DcDevice, details: any, displays: (ScreenInfo & { orientation?: string }) | undefined, readiness: Readiness | undefined) {
  const h = hw(d), dp = d.deviceProperties ?? {}, det = details?.deviceProperties ?? {}, dh = details?.hardwareProperties ?? {};
  const t = transportOf(d);
  return {
    name: dp.name ?? det.name ?? d.identifier,
    model: h.marketingName ?? dh.marketingName ?? h.productType ?? dh.productType,
    productType: h.productType ?? dh.productType,
    os: [h.platform ?? 'iOS', dp.osVersionNumber ?? det.osVersionNumber].filter(Boolean).join(' '),
    build: dp.osBuildUpdate ?? det.osBuildUpdate,
    screen: displays && !(displays as any).error && displays.width ? { width: displays.width, height: displays.height, scale: displays.scale, orientation: displays.orientation } : undefined,
    connection: t === 'localNetwork' || t === 'network' ? 'wifi' : t ? 'usb' : undefined,
    locked: readiness?.locked ?? null,
    developerMode: readiness?.developerMode ?? null,
  };
}

// ── display geometry (devicectl device info displays; verified read-only on iOS 27) ──

const displayCache = new Map<string, { at: number; v: ScreenInfo & { orientation?: string } }>();
async function displayInfo(udid: string): Promise<ScreenInfo & { orientation?: string }> {
  const c = displayCache.get(udid);
  if (c && Date.now() - c.at < 5000) return c.v;
  const r = await devicectl<{ displays?: any[]; orientation?: any }>(['device', 'info', 'displays', '--device', udid], { timeoutMs: 30_000 });
  const disp = (r?.displays ?? []).find((x) => x.primary) ?? r?.displays?.[0];
  if (!disp) throw new PhoneDockError('Could not read the iPhone display', 'device_error', 502, undefined, 'devicectl reported no displays');
  const b = disp.bounds ?? [[0, 0], disp.nativeSize ?? [0, 0]];
  const v = { width: Number(b[1][0]), height: Number(b[1][1]), scale: Number(disp.pointScale) || undefined, orientation: disp.currentOrientation ?? r?.orientation?.currentDeviceOrientation };
  displayCache.set(udid, { at: Date.now(), v });
  return v;
}

// ── crash logs (systemCrashLogs domain; list verified read-only on iOS 27) ──

interface DcFile { name: string; relativePath?: string; metadata?: { lastModDate?: string; size?: number; extendedAttributes?: Record<string, string> }; resources?: { isDirectory?: boolean } }
const crashCacheDir = (udid: string) => stateDir('ios-device', 'crashes', udid.replace(/[^A-Za-z0-9-]/g, '_'));
const crashParsed = new Map<string, { appId?: string; summary: string; time?: string; process?: string }>();

function safeRel(rel: string): string {
  if (!rel || rel.startsWith('/') || rel.split('/').some((p) => p === '..' || p === '')) throw new PhoneDockError('The crash report identifier is invalid', 'bad_request', 400, undefined, `Bad crash id path "${rel}"`);
  return rel;
}

/** Copy one crash log off the device into the per-device cache (crash logs are immutable once written). */
async function fetchCrash(udid: string, rel: string): Promise<string> {
  const local = join(crashCacheDir(udid), safeRel(rel).replace(/\//g, '__'));
  if (existsSync(local) && statSync(local).size > 0) return local;
  const tmp = `${local}.part`;
  rmSync(tmp, { force: true });
  await devicectl(['device', 'copy', 'from', '--device', udid, '--domain-type', 'systemCrashLogs', '--source', rel, '--destination', tmp], { timeoutMs: 120_000 });
  renameSync(tmp, local);
  return local;
}

function crashMeta(udid: string, f: DcFile): CrashReport | undefined {
  const rel = f.relativePath ?? f.name;
  const bug = f.metadata?.extendedAttributes?.bug_type;
  const kind = ipsKind(bug);
  if (kind === 'other') return undefined;                      // analytics, SFA, stackshots …
  const logType = f.metadata?.extendedAttributes?.LogType ?? '';
  const base = basename(rel);
  const proc = /^\d+_(.+)$/.exec(logType)?.[1] ?? /^(.*?)-\d{4}-\d\d-\d\d-\d{6}/.exec(base)?.[1] ?? base;
  const cached = crashParsed.get(`${udid}:${rel}`);
  return {
    id: `syscrash:${rel}`, kind, process: cached?.process ?? proc, appId: cached?.appId,
    time: cached?.time ?? f.metadata?.lastModDate,
    summary: cached?.summary ?? `${kind === 'jetsam' ? 'jetsam event' : 'crash'} in ${proc} (details: getCrash)`,
  };
}

async function enrichCrash(udid: string, rel: string): Promise<void> {
  const key = `${udid}:${rel}`;
  if (crashParsed.has(key)) return;
  const r = parseIps(readFileSync(await fetchCrash(udid, rel), 'utf8'));
  if (!r) { crashParsed.set(key, { summary: 'unparseable report' }); return; }
  crashParsed.set(key, {
    appId: r.header.bundleID ?? r.body.bundleInfo?.CFBundleIdentifier, process: r.body.procName ?? r.header.app_name,
    time: ipsTime(r.body.captureTime) ?? ipsTime(r.header.timestamp), summary: ipsSummary(r),
  });
}

/** Newest first by the report's own time (file mtimes and in-report capture times differ, so list order alone is unreliable). */
function byTimeDesc(list: CrashReport[]): CrashReport[] {
  const t = (c: CrashReport) => { const n = Date.parse(c.time ?? ''); return Number.isFinite(n) ? n : 0; };
  return [...list].sort((a, b) => t(b) - t(a));
}

/** Run `fn` over items with at most `n` in flight. */
async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const t = items[i++]; await fn(t).catch(() => undefined); } }));
}

// ── recording ──────────────────────────────────────────────────────────────

interface DevRecording { outPath: string; tmp: string; dest?: string; child?: ChildProcess; exited?: Promise<number | null>; shots?: ScreenshotRecorder }
const recordings = new Map<string, DevRecording>();
const noScreenRecord = new Set<string>();   // devices whose CoreDevice lacks the "Screen Recording" capability

const BUNDLE_RE = /^[A-Za-z0-9][A-Za-z0-9.\-]*$/;
function checkBundle(id: string) { if (!BUNDLE_RE.test(id)) throw new PhoneDockError('The app identifier is invalid', 'bad_request', 400, undefined, `Invalid bundle id "${id}"`); }

// ── Wi-Fi discovery ────────────────────────────────────────────────────────

export interface Discovered { name: string; host?: string; mac?: string; udid?: string; source: 'bonjour' | 'devicectl'; service?: string; deviceId?: string; transport?: string }

/** Browse a Bonjour service type for ~ms, then SIGINT dns-sd (which flushes its piped stdout). */
function browse(type: string, ms = 3000): Promise<string[]> {
  return new Promise((resolve) => {
    let out = '';
    let child: ChildProcess;
    try { child = spawn('/usr/bin/dns-sd', ['-B', type, 'local.'], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { resolve([]); return; }
    child.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
    const done = () => {
      const names = new Set<string>();
      for (const line of out.split('\n')) {
        const m = /^\s*\d+:\d+:\d+\.\d+\s+Add\s+\d+\s+\d+\s+\S+\s+\S+\s+(.+?)\s*$/.exec(line);
        if (m) names.add(m[1]);
      }
      resolve([...names]);
    };
    child.on('error', () => resolve([]));
    child.on('close', done);
    setTimeout(() => { child.kill('SIGINT'); setTimeout(() => child.kill('SIGKILL'), 500); }, ms);
  });
}

async function discover(): Promise<Discovered[]> {
  const [mobdev, rp, dc] = await Promise.all([
    browse('_apple-mobdev2._tcp'), browse('_remotepairing._tcp'),
    physicalDevices(true).catch(() => [] as DcDevice[]),
  ]);
  const out: Discovered[] = [];
  for (const d of dc) {
    const c = conn(d), h = hw(d);
    if (!(c.transportType === 'localNetwork' || c.transportType === 'network')) continue;
    const udid = h.udid ?? d.identifier;
    out.push({ name: st(d).name ?? h.marketingName ?? udid, udid, source: 'devicectl', deviceId: `${ID}:${udid}`, transport: c.transportType,
      host: (c.potentialHostnames ?? [])[0] ?? c.localHostnames?.[0] });
  }
  // _apple-mobdev2 instance names are "<wifi-mac>@<ipv6-link-local>" (Wi-Fi sync); _remotepairing is iOS 17+ RemoteXPC.
  for (const n of mobdev) {
    const [mac, rest] = n.split('@');
    const host = rest?.replace(/-supportsRP.*$/, '') || undefined;
    out.push({ name: n, host, mac, source: 'bonjour', service: '_apple-mobdev2._tcp' });
  }
  for (const n of rp) out.push({ name: n, source: 'bonjour', service: '_remotepairing._tcp' });
  return out;
}

// ── WebDriverAgent setup (clone + xcodebuild test) ─────────────────────────

const wdaRunners = new Map<string, ChildProcess>();
const WDA_REPO = 'https://github.com/appium/WebDriverAgent.git';

async function wdaSetup(udid: string, opts: { team?: string; destination?: string; name?: string }, onProgress: (l: string) => void): Promise<{ udid: string; wdaUrl: string; pid?: number }> {
  if (!/^[A-Za-z0-9-]+$/.test(udid)) throw new PhoneDockError('The device identifier is invalid', 'bad_request', 400);
  if (opts.team && !/^[A-Z0-9]{10}$/.test(opts.team)) throw new PhoneDockError('The Apple Developer Team ID must have 10 characters', 'bad_request', 400);
  const root = stateDir('wda');
  const proj = join(root, 'WebDriverAgent');
  if (!existsSync(join(proj, 'WebDriverAgent.xcodeproj'))) {
    onProgress(`cloning ${WDA_REPO} → ${proj}`);
    rmSync(proj, { recursive: true, force: true });
    await runBuffer('git', ['clone', '--depth', '1', WDA_REPO, proj], { env: toolEnv(), timeoutMs: 600_000 });
  } else onProgress(`using existing clone ${proj}`);
  wdaRunners.get(udid)?.kill('SIGINT');
  const args = ['-project', 'WebDriverAgent.xcodeproj', '-scheme', 'WebDriverAgentRunner',
    '-destination', opts.destination ?? `id=${udid}`, '-derivedDataPath', join(root, 'DerivedData')];
  if (opts.team) args.push(`DEVELOPMENT_TEAM=${opts.team}`, 'CODE_SIGN_STYLE=Automatic', '-allowProvisioningUpdates');
  args.push('test');
  onProgress(`xcodebuild ${args.join(' ')}`);
  const child = spawn('xcodebuild', args, { cwd: proj, env: toolEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  wdaRunners.set(udid, child);
  return new Promise((resolve, reject) => {
    let buf = ''; let settled = false; let compiled = 0; const tail: string[] = [];
    const onData = (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        tail.push(line); if (tail.length > 20) tail.shift();
        const t = line.trim();
        if (/^(\*\* |Test Suite|Testing |Signing Identity|Provisioning Profile|=== BUILD|xcodebuild: error|.*: error: )/.test(t) || /ServerURLHere|BUILD (SUCCEEDED|FAILED)|TEST (FAILED|EXECUTE)/.test(t)) onProgress(t.slice(0, 400));
        else if (/^(CompileC|SwiftCompile) /.test(t) && ++compiled % 25 === 0) onProgress(`compiling… (${compiled} files)`);
        const m = /ServerURLHere->(\S+?)<-ServerURLHere/.exec(line);
        if (m && !settled) {
          settled = true;
          const url = m[1].replace(/\/+$/, '');
          cfgState.update((all) => { all[udid] = { ...all[udid], udid, wdaUrl: url, address: new URL(url).hostname, ...(opts.name ? { name: opts.name } : {}), savedAt: new Date().toISOString() }; });
          onProgress(`WebDriverAgent is running at ${url} (saved for ${udid}; xcodebuild pid ${child.pid} keeps it alive)`);
          resolve({ udid, wdaUrl: url, pid: child.pid });
        }
      }
    };
    child.stdout!.on('data', onData); child.stderr!.on('data', onData);
    child.on('error', (e) => { if (!settled) { settled = true; reject(new PhoneDockError('Couldn’t start the iPhone service', 'exec_failed', 500, undefined, `xcodebuild: ${e.message}`)); } });
    child.on('close', (code) => {
      if (wdaRunners.get(udid) === child) wdaRunners.delete(udid);
      if (!settled) {
        settled = true;
        reject(new PhoneDockError("Couldn’t start the iPhone service", 'wda_setup_failed', 502, ["Pair and unlock the iPhone, and enable Developer Mode."], [`WebDriverAgent build/run failed (xcodebuild exit ${code}): ${tail.slice(-6).join(' | ').slice(0, 1200)}`, ...[
          'Physical device: pass --team <TEAMID> (Xcode › Settings › Accounts) and trust the developer cert on the iPhone (Settings › General › VPN & Device Management)',
          'The device must be paired (once by USB), unlocked, with Developer Mode on',
        ]].filter(Boolean).join('\n')));
      }
    });
  });
}

/** Stop a WDA runner started by wdaSetup (if any). */
export function stopWdaRunner(udid: string): boolean { const c = wdaRunners.get(udid); if (!c) return false; c.kill('SIGINT'); wdaRunners.delete(udid); return true; }

// ── the backend ────────────────────────────────────────────────────────────

const KEY_BUTTONS: Record<string, string> = { home: 'home', volume_up: 'volumeUp', volume_down: 'volumeDown' };
const KEY_CHARS: Record<string, string> = { enter: '\n', tab: '\t', delete: '\b', space: ' ' };

function appDataHint(e: PhoneDockError, appId: string): PhoneDockError {
  if (e.code === 'not_supported' || e.code === 'not_found' || /container|permission|not allowed|denied/i.test(e.detail ?? e.message)) {
    return new PhoneDockError(e.message, e.code === 'device_error' ? 'forbidden' : e.code, e.status === 502 ? 403 : e.status,
      ['Use an app installed for development.', ...(e.hints ?? []).slice(0, 1)],
      [e.detail ?? e.message, `The app data container is only reachable for development-signed apps (installed from Xcode / with get-task-allow); ${appId} may be an App Store app`].join('\n'));
  }
  return e;
}

export const backend: Backend & {
  discover(): Promise<Discovered[]>;
  connectWda(input: string, opts?: { name?: string; udid?: string }): Promise<{ nativeId: string; wdaUrl: string; status: any }>;
  disconnect(nativeId: string): Promise<boolean>;
  wdaSetup(udid: string, opts: { team?: string; destination?: string; name?: string }, onProgress?: (l: string) => void): Promise<{ udid: string; wdaUrl: string; pid?: number }>;
} = {
  id: ID,
  displayName: 'iPhone and iPad (beta)',
  stage: 'beta',
  platform: 'ios',
  kind: 'physical',
  capabilities: CAPS,

  async available(): Promise<Availability> {
    if (process.platform !== 'darwin') return { ok: false, reason: 'Physical iOS devices require macOS' };
    if (!developerDir()) return { ok: false, reason: 'Xcode not found (devicectl ships with Xcode 15+)' };
    const r = await run('xcrun', ['devicectl', '--version'], { env: toolEnv(), allowFail: true, timeoutMs: 30_000 }).catch(() => undefined);
    if (!r || r.code !== 0) return { ok: false, reason: 'xcrun devicectl not available', hints: ['Install Xcode 15 or newer'] };
    const hints: string[] = ['iPhones on iOS 27 or later work over USB or Wi-Fi with nothing installed on the phone (touch, keyboard, UI tree, screenshots, apps). Older iOS: screenshots, recording, crash logs, app data, location and install/launch via devicectl; input and the UI tree need WebDriverAgent (set PHONEDOCK_WDA_URL; see docs/IPHONE-WIFI.md)'];
    return { ok: true, version: `devicectl ${r.stdout.trim()}`, hints };
  },

  async listDevices(): Promise<Device[]> {
    const devs = await physicalDevices(true).catch(() => [] as DcDevice[]);
    const cfg = cfgState.read();
    const out: Device[] = [];
    const seen = new Set<string>();
    for (const d of devs) {
      const h = hw(d), c = conn(d), s = sw(d), ds = st(d);
      const udid: string = h.udid ?? d.identifier;
      seen.add(udid); seen.add(d.identifier);
      const cf = cfgFor(udid);
      const url = (cf?.wdaUrl ?? process.env.PHONEDOCK_WDA_URL)?.replace(/\/+$/, '');
      const ws = url ? await wdaStatus(url) : undefined;
      const readiness = cachedReadiness(d);
      const osv = s.osVersionNumber?.stringValue ?? d.deviceProperties?.osVersionNumber;
      if (osv) osByUdid.set(udid, String(osv));
      out.push({
        id: `${ID}:${udid}`, backend: ID, nativeId: udid,
        name: cf?.name ?? ds.name ?? h.marketingName ?? udid,
        platform: 'ios', kind: 'physical', state: mapState(d), managed: false,
        osVersion: s.osVersionNumber?.stringValue ?? d.deviceProperties?.osVersionNumber,
        model: h.marketingName ?? h.productType,
        connection: transportOf(d) === 'localNetwork' || transportOf(d) === 'network' ? 'wifi' : 'usb',
        capabilities: url ? CAPS : isNativeInputCapable(s.osVersionNumber?.stringValue ?? d.deviceProperties?.osVersionNumber) ? nativeCaps(s.osVersionNumber?.stringValue ?? d.deviceProperties?.osVersionNumber) : BASE_CAPS,
        error: readiness.hints.length && mapState(d) !== 'running' ? readiness.hints[0] : undefined,
        meta: {
          coreDeviceId: d.identifier, productType: h.productType, transport: transportOf(d), pairingState: c.pairingState ?? d.connectionProperties?.pairingState,
          tunnelState: readiness.tunnel, developerMode: readiness.developerMode, wdaUrl: url ?? null, wdaReady: ws?.ok ?? null,
          readiness, experimental: true,
        },
      });
    }
    // manual (WDA-only) connections not already covered by a devicectl device
    await Promise.all(Object.entries(cfg).map(async ([key, cf]) => {
      if (!cf.wdaUrl || seen.has(key) || (cf.udid && seen.has(cf.udid))) return;
      const nativeId = cf.udid ?? key;
      const ws = await wdaStatus(cf.wdaUrl.replace(/\/+$/, ''));
      const v = ws.status ?? {};
      out.push({
        id: `${ID}:${nativeId}`, backend: ID, nativeId,
        name: cf.name ?? v.device ?? `iPhone (${new URL(cf.wdaUrl).hostname})`,
        platform: 'ios', kind: 'physical', state: ws.ok ? 'running' : 'offline', managed: false,
        osVersion: v.os?.version, model: v.device,
        connection: 'wifi',
        capabilities: cf.udid ? CAPS : WDA_ONLY_CAPS,
        error: ws.ok ? undefined : `WebDriverAgent not reachable at ${cf.wdaUrl}: ${ws.error}`,
        meta: { wdaUrl: cf.wdaUrl, wdaReady: ws.ok, address: cf.address, udid: cf.udid ?? null, manual: true, wdaIp: v.ios?.ip, experimental: true },
      });
    }));
    return out;
  },

  /** Bonjour + devicectl scan for iPhones on the network (nothing is connected). */
  async discover(): Promise<Discovered[]> { return discover(); },

  /** Verify WDA at `input` (IP/host or URL), persist it, return the nativeId. */
  async connectWda(input: string, opts: { name?: string; udid?: string } = {}): Promise<{ nativeId: string; wdaUrl: string; status: any }> {
    const url = normalizeWdaUrl(input);
    const ws = await wdaStatus(url, 8000, true);
    if (!ws.ok) throw new PhoneDockError("Couldn’t reach the iPhone service", 'wda_unreachable', 502, ["Check that WebDriverAgent is running.","Make sure the phone and Mac are on the same Wi-Fi."], [`WebDriverAgent is not reachable at ${url}: ${ws.error}`, ...[
      'Is WebDriverAgentRunner running on the iPhone (phonedock ios wda-setup --udid <udid>)?',
      'Phone and Mac must be on the same Wi-Fi; the phone must be unlocked the first time',
      'WDA must be re-launched after every iPhone reboot',
    ]].filter(Boolean).join('\n'));
    const nativeId = opts.udid ?? wdaNativeId(url);
    const address = /^https?:/i.test(input.trim()) ? new URL(url).hostname : input.trim();
    cfgState.update((all) => {
      for (const [k, v] of Object.entries(all)) if (k !== nativeId && v.wdaUrl?.replace(/\/+$/, '') === url) delete all[k];
      all[nativeId] = { ...all[nativeId], wdaUrl: url, address, ...(opts.name ? { name: opts.name } : {}), ...(opts.udid ? { udid: opts.udid } : {}), savedAt: new Date().toISOString() };
    });
    sessions.delete(url); scaleCache.delete(nativeId);
    return { nativeId, wdaUrl: url, status: ws.status };
  },

  /** Forget a saved WDA connection (manual entry, or the wdaUrl of a devicectl device). */
  async disconnect(nativeId: string): Promise<boolean> {
    let hit = false;
    cfgState.update((all) => {
      for (const [k, v] of Object.entries(all)) if (k === nativeId || v.udid === nativeId) { if (v.wdaUrl) sessions.delete(v.wdaUrl.replace(/\/+$/, '')); delete all[k]; hit = true; }
    });
    scaleCache.delete(nativeId);
    return hit;
  },

  /** Clone + build + run WebDriverAgent on a device; resolves once WDA prints its URL (saved for the device). */
  async wdaSetup(udid: string, opts: { team?: string; destination?: string; name?: string } , onProgress: (l: string) => void = () => {}): Promise<{ udid: string; wdaUrl: string; pid?: number }> {
    return wdaSetup(udid, opts, onProgress);
  },

  async screenshot(udid) { return screenshotAny(udid); },

  async screenInfo(udid): Promise<ScreenInfo> {
    // devicectl knows the framebuffer size + point scale without taking a screenshot (verified read-only on iOS 27).
    let dc: string | undefined; try { dc = dcId(udid); } catch { /* WDA-only */ }
    if (dc) {
      try { const v = await displayInfo(dc); if (v.width && v.height) return { width: v.width, height: v.height, scale: v.scale }; } catch { /* fall back */ }
    }
    const png = await this.screenshot(udid);
    const { width, height } = pngSize(png);
    let scale: number | undefined;
    if (wdaUrl(udid)) scale = await wdaScale(udid).catch(() => undefined);
    return { width, height, scale };
  },

  async uiTree(udid): Promise<UiTree> {
    // iOS 27+ without WDA: the phone's own accessibility dump (labels, types, frames in screenshot pixels; read-only).
    if (await ensureNative(udid)) {
      const dc = dcId(udid);
      if (isNativeCapable(osByUdid.get(dc))) return nativeUiTree(dc);
    }
    const w = await wda(udid);
    const [src, scale, png] = await Promise.all([
      wdaFetch(w.base, 'GET', '/source?format=json', undefined, 60_000),
      wdaScale(udid),
      this.screenshot(udid),
    ]);
    const { width, height } = pngSize(png);
    return { source: 'accessibility', screen: { width, height, scale }, root: mapWdaTree(src.value as WdaNode, scale), capturedAt: new Date().toISOString() };
  },

  async tap(udid, x, y) {
    if (await ensureNative(udid)) { await hidTap(dcId(udid), nativeGeo(udid), x, y); return; }
    const s = await wdaScale(udid); await wdaSession(udid, 'POST', '/wda/tap', { x: p(x, s), y: p(y, s) });
  },

  async doubleTap(udid, x, y) {
    if (await ensureNative(udid)) { await hidDoubleTap(dcId(udid), nativeGeo(udid), x, y); return; }
    await this.tap(udid, x, y); await new Promise((r) => setTimeout(r, 80)); await this.tap(udid, x, y);
  },

  async longPress(udid, x, y, durationMs) {
    if (await ensureNative(udid)) { await hidLongPress(dcId(udid), nativeGeo(udid), x, y, durationMs || 800); return; }
    const s = await wdaScale(udid);
    await wdaSession(udid, 'POST', '/wda/touchAndHold', { x: p(x, s), y: p(y, s), duration: Math.max(0.1, (durationMs || 800) / 1000) });
  },

  async swipe(udid, x1, y1, x2, y2, durationMs) {
    if (await ensureNative(udid)) { await hidSwipe(dcId(udid), nativeGeo(udid), x1, y1, x2, y2, durationMs || 300); return; }
    const s = await wdaScale(udid);
    await wdaSession(udid, 'POST', '/wda/dragfromtoforduration', {
      fromX: p(x1, s), fromY: p(y1, s), toX: p(x2, s), toY: p(y2, s), duration: Math.max(0.05, (durationMs || 300) / 1000),
    });
  },

  async type(udid, text) {
    if (await ensureNative(udid)) {
      if (hidTypable(text)) { await hidType(dcId(udid), text); return; }
      // Emoji / accents / non-Latin: put the text on the device pasteboard, then Cmd+V. (iOS may show its
      // "Allow Paste" prompt the first time an app reads a pasteboard written by another source.)
      const dir = mkdtempSync(join(tmpdir(), 'pd-paste-'));
      try {
        const f = join(dir, 'text.txt'); writeFileSync(f, text, 'utf8');
        await devicectl(['device', 'pasteboard', 'copy', '--device', dcId(udid), '--type', 'public.utf8-plain-text', '--file', f]);
      } finally { rmSync(dir, { recursive: true, force: true }); }
      await hidCombo(dcId(udid), ['cmd'], 'v');
      return;
    }
    await wdaSession(udid, 'POST', '/wda/keys', { value: [...text] });
  },

  async key(udid, key: KeyName) {
    const k = String(key).toLowerCase();
    if (await ensureNative(udid)) {
      if (await hidKey(dcId(udid), k)) return;
      if (k === 'back') { // iOS has no back key: swipe in from the left edge
        const g = await nativeGeo(udid)();
        await hidSwipe(dcId(udid), nativeGeo(udid), 2, g.height / 2, g.width * 0.6, g.height / 2, 300);
        return;
      }
      throw new PhoneDockError('This key is not supported on the iPhone', 'not_supported', 400, undefined,
        `Key "${key}" is unsupported. Supported: home, lock, volume_up, volume_down, mute, siri, enter, delete, tab, escape, space, arrows, back (edge swipe)`);
    }
    const w = await wda(udid);
    // pressButton(home) really presses it (/wda/homescreen is a no-op when SpringBoard owns the overlay, e.g. Spotlight)
    if (k === 'home') { try { await wdaSession(udid, 'POST', '/wda/pressButton', { name: 'home' }); } catch { await wdaFetch(w.base, 'POST', '/wda/homescreen'); } return; }
    if (k === 'lock' || k === 'power') { await wdaSession(udid, 'POST', '/wda/lock'); return; }
    if (KEY_BUTTONS[k]) { await wdaSession(udid, 'POST', '/wda/pressButton', { name: KEY_BUTTONS[k] }); return; }
    if (KEY_CHARS[k]) { await wdaSession(udid, 'POST', '/wda/keys', { value: [KEY_CHARS[k]] }); return; }
    if (k === 'siri') { await wdaSession(udid, 'POST', '/wda/siri/activate', { text: '' }); return; }
    if (k === 'back') {
      const scale = await wdaScale(udid);
      const sz = await wdaSession(udid, 'GET', '/window/size').catch(() => undefined);
      const wpt = Number(sz?.value?.width) || 390, hpt = Number(sz?.value?.height) || 844;
      await this.swipe(udid, 2 * scale, (hpt / 2) * scale, wpt * 0.6 * scale, (hpt / 2) * scale, 300);
      return;
    }
    throw new PhoneDockError('This key is not supported on the iPhone', 'not_supported', 400, undefined,
      `Key "${key}" is unsupported. Supported: home, lock, volume_up, volume_down, enter, tab, delete, space, back (edge swipe), siri`);
  },

  async installApp(nid, path) {
    const udid = dcId(nid);
    await findDev(udid);
    const r = await devicectl<{ installedApplications?: { bundleID?: string; installationURL?: string }[] }>(['device', 'install', 'app', '--device', udid, path], { timeoutMs: 600_000 });
    const app = r?.installedApplications?.[0];
    return app?.bundleID ? { id: app.bundleID, system: false } : undefined;
  },

  async uninstallApp(nid, appId) { await devicectl(['device', 'uninstall', 'app', '--device', dcId(nid), appId]); },

  async listApps(nid) {
    const udid = dcId(nid);
    const r = await devicectl<{ apps?: any[] }>(['device', 'info', 'apps', '--device', udid, '--include-all-apps']).catch(async () =>
      devicectl<{ apps?: any[] }>(['device', 'info', 'apps', '--device', udid]));
    return (r?.apps ?? []).map((a): AppInfo => ({
      id: a.bundleIdentifier, name: a.name, version: a.version,
      system: a.appClip ? false : (a.removable === false || /^com\.apple\./.test(a.bundleIdentifier ?? '') && !a.builtByDeveloper),
    }));
  },

  async launchApp(udid, appId) {
    if (wdaUrl(udid)) { await wdaSession(udid, 'POST', '/wda/apps/launch', { bundleId: appId }); return; }
    // No --terminate-existing: bring the app to the front with its state intact (an open draft must survive).
    await devicectl(['device', 'process', 'launch', '--device', dcId(udid), appId]);
    void ensureNative(udid).catch(() => false); // warms the UI tree for the agent's next `ui`
  },

  async terminateApp(udid, appId) {
    if (wdaUrl(udid)) { await wdaSession(udid, 'POST', '/wda/apps/terminate', { bundleId: appId }); return; }
    // devicectl terminates by pid: find the app's bundle URL, then its running process
    udid = dcId(udid);
    // --include-all-apps: without it, system apps (Calculator, Settings…) come back as an empty list.
    const apps = await devicectl<{ apps?: any[] }>(['device', 'info', 'apps', '--device', udid, '--bundle-id', appId, '--include-all-apps'])
      .catch(() => devicectl<{ apps?: any[] }>(['device', 'info', 'apps', '--device', udid, '--bundle-id', appId]));
    const url: string | undefined = apps?.apps?.[0]?.url;
    if (!url) throw new PhoneDockError('The app is not installed', 'not_found', 404, undefined, `App ${appId} is not installed`);
    const procs = await devicectl<{ runningProcesses?: { executable?: string; processIdentifier: number }[] }>(['device', 'info', 'processes', '--device', udid]);
    const hit = procs?.runningProcesses?.find((pr) => pr.executable?.startsWith(url));
    if (!hit) return;
    await devicectl(['device', 'process', 'terminate', '--device', udid, '--pid', String(hit.processIdentifier)]);
  },

  // Verified on an iOS 27 iPhone: `devicectl device process openURL` opens the phone's default browser (which may not
  // be Safari). Then WDA /url, then the old Safari --payload-url launch.
  async openUrl(udid, url) {
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url)) throw new PhoneDockError('The URL is invalid', 'bad_request', 400, undefined, `Not a URL: ${url}`);
    let dc: string | undefined; try { dc = dcId(udid); } catch { /* WDA-only */ }
    if (dc) {
      try { await devicectl(['device', 'process', 'openURL', '--device', dc, url]); return; }
      catch (e) { if (!wdaUrl(udid) && (e as PhoneDockError).code !== 'not_supported') throw e; }
    }
    if (wdaUrl(udid)) { await wdaSession(udid, 'POST', '/url', { url }); return; }
    await devicectl(['device', 'process', 'launch', '--device', dcId(udid), '--payload-url', url, 'com.apple.mobilesafari']);
  },

  // `devicectl device orientation set` is documented as "simulated device physical orientation" and on a real iPhone
  // it reports "New Device Orientation: portrait" whatever you ask (hardware test, iOS 27.0). It can never work, so
  // we don't send it, and 'rotate' is not a capability of this backend.
  async rotate(_nid, orientation) {
    throw new PhoneDockError(`This iPhone stayed in portrait: real iPhones only rotate when you turn them, unless Portrait Orientation Lock is on (asked for ${orientation})`, 'not_supported', 501,
      ['Turn the phone itself (and turn off Portrait Orientation Lock in Control Center).'],
      'devicectl device orientation set only sets a simulated orientation ("for devices that support it") and reports portrait on a real iPhone, so PhoneDock does not send it');
  },

  // UNTESTED on hardware: `devicectl device simulate location coordinate` (persists until cleared).
  async setLocation(nid, lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new PhoneDockError('The location coordinates are out of range', 'bad_request', 400);
    await devicectl(['device', 'simulate', 'location', 'coordinate', '--device', dcId(nid), `--latitude=${lat}`, `--longitude=${lon}`]);
  },

  /** WDA only: devicectl's process list has no "frontmost" flag, and the accessibility sidecar reports the tree of the
   *  frontmost app without naming its bundle id. */
  async foregroundApp(nid) {
    const base = wdaUrl(nid);
    if (!base) throw new PhoneDockError('The foreground app can’t be identified on a real iPhone without WebDriverAgent', 'not_supported', 501,
      ['Read the screen instead: `phonedock ui <id>` shows the frontmost app’s elements, or take a screenshot.', 'Only if you need the bundle id: set up WebDriverAgent (docs/IPHONE-WIFI.md).'],
      'devicectl lists running processes but does not say which one is in front, and the iOS 27 accessibility channel gives no bundle id; only WebDriverAgent can name the foreground app');
    const j = await wdaFetch(base, 'GET', '/wda/activeAppInfo', undefined, 15_000);
    const v = j?.value ?? {};
    if (!v.bundleId || v.bundleId === 'com.apple.springboard') return null;
    return { id: String(v.bundleId), name: v.name || undefined } satisfies AppInfo;
  },

  // ── crash logs: list verified read-only on iOS 27 (802 files, bug_type in xattrs); copy-from verified ──
  async listCrashes(nid, opts = {}) {
    const udid = dcId(nid);
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    const since = opts.since ? Date.parse(opts.since) : undefined;
    if (opts.since && !Number.isFinite(since)) throw new PhoneDockError('The start time must be a valid ISO time', 'bad_request', 400);
    const r = await devicectl<{ files?: DcFile[] }>(['device', 'info', 'files', '--device', udid, '--domain-type', 'systemCrashLogs'], { timeoutMs: 60_000 });
    let files = (r?.files ?? []).filter((f) => !f.resources?.isDirectory && /\.ips$/.test(f.name));
    if (since !== undefined) files = files.filter((f) => !f.metadata?.lastModDate || Date.parse(f.metadata.lastModDate) >= since - 1000);
    files.sort((a, b) => (b.metadata?.lastModDate ?? '').localeCompare(a.metadata?.lastModDate ?? ''));
    let metas = files.map((f) => ({ f, m: crashMeta(udid, f) })).filter((x): x is { f: DcFile; m: CrashReport } => !!x.m);
    if (opts.appId) {
      // bundle ids live inside the report: download (cached) newest-first until we have enough matches (cap 60)
      const out: CrashReport[] = [];
      for (let i = 0; i < metas.length && out.length < limit && i < 60; i += 6) {
        const batch = metas.slice(i, i + 6);
        await pool(batch, 6, async ({ f }) => enrichCrash(udid, f.relativePath ?? f.name));
        for (const { f } of batch) { const m = crashMeta(udid, f); if (m && (m.appId === opts.appId || m.process === opts.appId)) out.push(m); }
      }
      return byTimeDesc(out).slice(0, limit);
    }
    metas = metas.slice(0, limit);
    // fill in real summaries for the newest few (≈0.5 s per report, 4 in flight)
    await pool(metas.slice(0, 12), 4, async ({ f }) => enrichCrash(udid, f.relativePath ?? f.name));
    return byTimeDesc(metas.map(({ f }) => crashMeta(udid, f)!).filter(Boolean));
  },

  async getCrash(nid, crashId) {
    const udid = dcId(nid);
    const m = /^syscrash:(.+)$/.exec(crashId);
    if (!m) throw new PhoneDockError('Could not find the crash report', 'not_found', 404, ['Choose a report from the crash list.'], `Unknown crash id "${crashId}"; use an id from listCrashes`);
    const local = await fetchCrash(udid, m[1]);
    const text = readFileSync(local, 'utf8');
    const r = parseIps(text);
    return r ? ipsRender(r) : text;
  },

  // ── recording: devicectl capture screen-record, else a screenshot-loop recorder ──
  // devicectl screen-record is UNTESTED on hardware: the paired iPhone 16 Pro Max / iOS 27.0 reports
  // "The capability 'Screen Recording' is not supported by this device", so it falls back to screenshots (~1 fps).
  async startRecording(nid, outPath, opts = {}) {
    if (recordings.has(nid)) throw new PhoneDockError('A recording is already running on this device', 'busy', 409, ['Stop it first']);
    const maxSeconds = Math.max(1, Math.min(Math.round(opts.maxSeconds ?? 300), 3600));
    mkdirSync(dirname(outPath), { recursive: true });
    let udid: string | undefined; try { udid = dcId(nid); } catch { /* WDA-only */ }
    const tmp = mkdtempSync(join(tmpdir(), 'pd-iosdev-rec-'));
    if (udid && !noScreenRecord.has(udid)) {
      const dest = join(tmp, 'rec.mp4'); const jsonOut = join(tmp, 'out.json');
      const child = spawn('xcrun', ['devicectl', 'device', 'capture', 'screen-record', '--device', udid, '--destination', dest, '--codec', 'h264',
        '--duration', String(maxSeconds), '--json-output', jsonOut, '--quiet'], { env: toolEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = ''; child.stderr!.on('data', (d: Buffer) => { if (stderr.length < 8000) stderr += d.toString(); });
      const exited = new Promise<number | null>((res) => { child.on('close', (code) => res(code)); child.on('error', () => res(-1)); });
      const early = await Promise.race([exited, new Promise<'running'>((res) => setTimeout(() => res('running'), 4000))]);
      if (early === 'running') { recordings.set(nid, { outPath, tmp, dest, child, exited }); return; }
      let msg = stderr.trim();
      try { const j = JSON.parse(readFileSync(jsonOut, 'utf8')); msg = j?.error?.userInfo?.NSLocalizedDescription?.string ?? msg; } catch { /* no json */ }
      if (!/not supported/i.test(msg)) { rmSync(tmp, { recursive: true, force: true }); throw devicectlError(['device', 'capture', 'screen-record'], msg || `exit ${early}`); }
      noScreenRecord.add(udid);
    }
    recordings.set(nid, { outPath, tmp, shots: new ScreenshotRecorder(() => screenshotAny(nid), maxSeconds, 100) });
  },

  async stopRecording(nid) {
    const rec = recordings.get(nid);
    if (!rec) throw new PhoneDockError('No recording is running on this device', 'not_recording', 404);
    try {
      if (rec.shots) { await rec.shots.finish(rec.outPath); return rec.outPath; }
      if (rec.child && rec.child.exitCode === null) rec.child.kill('SIGINT');
      const code = await Promise.race([rec.exited!, new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), 60_000))]);
      if (code === 'timeout') { rec.child?.kill('SIGKILL'); throw new PhoneDockError("The recording did not finish in time", 'record_failed', 504, undefined, 'devicectl screen-record did not finish within 60 s'); }
      if (!rec.dest || !existsSync(rec.dest) || statSync(rec.dest).size === 0) throw new PhoneDockError("The recording produced no file", 'record_failed', 502, undefined, `devicectl screen-record produced no file (exit ${code})`);
      await finalizeMp4(rec.dest, rec.outPath);
      return rec.outPath;
    } finally {
      recordings.delete(nid);
      rmSync(rec.tmp, { recursive: true, force: true });
    }
  },

  // ── app data (appDataContainer domain: developer-signed / get-task-allow apps only) ── UNTESTED on hardware.
  async exportAppData(nid, appId, outDir) {
    checkBundle(appId);
    const udid = dcId(nid);
    await this.terminateApp!(nid, appId).catch(() => undefined);
    mkdirSync(outDir, { recursive: true });
    const dest = join(outDir, 'data');
    rmSync(dest, { recursive: true, force: true });
    const base = ['device', 'copy', 'from', '--device', udid, '--domain-type', 'appDataContainer', '--domain-identifier', appId, '--destination', dest];
    try { await devicectl([...base, '--source', '.'], { timeoutMs: 1_800_000 }); }
    catch (e) {
      if ((e as PhoneDockError).code === 'not_found' || /source/i.test((e as PhoneDockError).detail ?? (e as Error).message)) await devicectl([...base, '--source', '/'], { timeoutMs: 1_800_000 });
      else throw appDataHint(e as PhoneDockError, appId);
    }
    writeFileSync(join(outDir, 'phonedock-appdata.json'), JSON.stringify({ format: 1, platform: 'ios', backend: ID, appId, device: udid, exportedAt: new Date().toISOString(), layout: { data: 'app data container (Documents, Library, tmp)' } }, null, 2));
  },

  async importAppData(nid, appId, fromDir) {
    checkBundle(appId);
    const udid = dcId(nid);
    const src = join(fromDir, 'data');
    if (!existsSync(src) || !statSync(src).isDirectory()) throw new PhoneDockError("Couldn’t find the saved app data", 'not_found', 404, undefined, `${src} not found (expected the layout written by exportAppData)`);
    await this.terminateApp!(nid, appId).catch(() => undefined);
    for (const e of readdirSync(src)) {
      if (e === '.com.apple.mobile_container_manager.metadata.plist' || e === '.DS_Store') continue;
      try {
        await devicectl(['device', 'copy', 'to', '--device', udid, '--domain-type', 'appDataContainer', '--domain-identifier', appId,
          '--source', join(src, e), '--destination', e, '--remove-existing-content', 'true'], { timeoutMs: 1_800_000 });
      } catch (err) { throw appDataHint(err as PhoneDockError, appId); }
    }
  },

  // ── performance traces (xctrace --device <udid>; see ios-trace.ts). Instruments can only attach to
  //    development-signed apps (get-task-allow), and needs Developer Mode on.
  async startTrace(nid, dir, o) {
    checkBundle(o.appId);
    const udid = dcId(nid);
    const d = await findDev(udid);
    if (devModeOf(d) === false) throw new PhoneDockError('Developer Mode is off on the iPhone', 'developer_mode_off', 409, ['Turn on Settings › Privacy & Security › Developer Mode on the iPhone, restart it, then try again.'], `${d.deviceProperties?.name ?? udid}: developerModeStatus disabled`);
    const apps = await devicectl<{ apps?: any[] }>(['device', 'info', 'apps', '--device', udid, '--bundle-id', o.appId, '--include-all-apps'])
      .catch(() => devicectl<{ apps?: any[] }>(['device', 'info', 'apps', '--device', udid, '--bundle-id', o.appId]));
    const app = apps?.apps?.[0];
    if (!app?.url) throw new PhoneDockError('The app is not installed on the iPhone', 'app_not_installed', 404, [`Install a development build of ${o.appId} first.`], `devicectl device info apps --bundle-id ${o.appId}: no app`);
    if (app.builtByDeveloper === false) {
      throw new PhoneDockError('Instruments can’t attach to this app on the iPhone', 'app_not_debuggable', 409,
        [`Install a development-signed build of ${o.appId} (Xcode Run, or a Debug build signed with your team): App Store, TestFlight and Ad Hoc builds can’t be traced.`],
        `${o.appId} is not built by a developer (devicectl builtByDeveloper=false)`);
    }
    const findPid = async () => {
      const procs = await devicectl<{ runningProcesses?: { executable?: string; processIdentifier: number }[] }>(['device', 'info', 'processes', '--device', udid]);
      return procs?.runningProcesses?.find((pr) => pr.executable?.startsWith(app.url))?.processIdentifier;
    };
    let pid = await findPid(); let launched = false;
    if (!pid) {
      if (!o.launch) throw new PhoneDockError('The app is not running', 'app_not_running', 409, [`Open ${o.appId} first (launch it), or pass launch: true.`], `No running process for ${app.url}`);
      await this.launchApp!(nid, o.appId); launched = true;
      for (let i = 0; i < 10 && !pid; i++) { await new Promise((r) => setTimeout(r, 1500)); pid = await findPid(); }
      if (!pid) throw new PhoneDockError('The app did not start', 'app_not_running', 409, [`Open ${o.appId} on the iPhone and try again.`], `No running process for ${app.url} after launching it`);
    }
    return startXctrace(nid, dir, { device: hw(d).udid ?? udid, template: o.template, pid, processName: app.name, appId: o.appId, timeLimitSec: o.timeLimitSec, physical: true, launched });
  },
  async stopTrace(nid) { return stopXctrace(nid); },
  async abortTrace(nid) { await abortXctrace(nid); },

  /** Fast: findDev (3 s list cache), lockState and displays run in parallel with the slow `info details`, which is
   *  cached for 10 min per device (its tunnel setup over Wi-Fi was most of the old 78 s) and capped at 25 s. */
  async info(nid) {
    const base = wdaUrl(nid);
    let udid: string | undefined;
    try { udid = dcId(nid); } catch { /* WDA-only */ }
    const [wdaInfo, d, details, locked, displays] = await Promise.all([
      base ? wdaStatus(base, 5000, true) : undefined,
      udid ? findDev(udid).catch((e: Error) => (base ? { error: e.message } : Promise.reject(e))) : undefined,
      udid ? cachedCall(`details:${udid}`, 600_000, () => devicectl(['device', 'info', 'details', '--device', udid!], { timeoutMs: 25_000 })).catch((e: Error) => ({ error: e.message })) : undefined,
      udid ? cachedCall(`lock:${udid}`, 15_000, () => probeLock(udid!)).catch(() => null) : null,
      udid ? displayInfo(udid).catch((e: Error) => ({ error: e.message })) : undefined,
    ]);
    const live = !!udid && !!d && !(d as any).error;
    if (live) lockCache.set(udid!, { at: Date.now(), locked });
    const readiness = live ? readinessOf(d as DcDevice, locked, Date.now()) : undefined;
    const summary = live ? infoSummary(d as DcDevice, details as any, displays as any, readiness) : undefined;
    return { summary, device: d, details, readiness, displays, wdaUrl: base ?? null, wda: wdaInfo, config: cfgFor(nid) ?? null, experimental: true };
  },
};
