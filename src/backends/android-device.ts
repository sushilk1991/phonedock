// Physical Android devices over adb (USB or wireless debugging). nativeId = adb serial.
import { spawn } from 'node:child_process';
import { toolEnv, which } from '../core/paths.ts';
import { PhoneDockError, type Availability, type Backend, type Device, type DeviceState } from '../core/types.ts';
import * as A from './android-common.ts';
import * as T from './android-trace.ts';
import { sleep, waitFor } from '../core/exec.ts';
import {
  chooseConnect, choosePairing, discoverAndroid, hostOf, manyPhonesError, matchConnectService, noConnectError, noPairingError,
  realDiscoverDeps, runWithDiagnosis, tcpProbe, type AndroidPhone, type DiscoverDeps, type DiagnoseDeps,
} from '../core/android-wifi.ts';


export interface WifiOpts { serial?: string; restartAdb?: boolean }

async function discoverPhones(deps?: Partial<DiscoverDeps>): Promise<AndroidPhone[]> {
  return discoverAndroid({ ...realDiscoverDeps(), adbDevices: async () => (await A.adbDevices()).map((d) => ({ serial: d.serial, state: d.state })), ...deps });
}

/** Restart the adb server this process talks to (ANDROID_ADB_SERVER_PORT, default 5037) so it is started from here. */
export async function restartAdbServer(): Promise<void> {
  await A.adbGlobal(['kill-server'], { allowFail: true, timeoutMs: 15_000 });
  await A.adbGlobal(['start-server'], { allowFail: true, timeoutMs: 30_000 });
  await sleep(500);
}

const diagnoseDeps = (): DiagnoseDeps => ({ probe: (h, p) => tcpProbe(h, p, 3000), restartAdb: restartAdbServer });

async function adbConnect(address: string, opts: WifiOpts): Promise<string> {
  const port = Number(/:(\d+)$/.exec(address)?.[1] ?? 5555);
  const r = await runWithDiagnosis(async () => {
    const x = await A.adbGlobal(['connect', address], { allowFail: true, timeoutMs: 20_000 });
    const out = (x.stdout + x.stderr).trim();
    return { ok: /connected to/i.test(out), out };
  }, { host: hostOf(address), port }, opts, diagnoseDeps());
  if (!r.ok) throw new PhoneDockError('Couldn’t connect to the Android phone', 'connect_failed', 502, ['Enable wireless debugging on the phone', 'Pair the phone before connecting'], `adb connect failed: ${r.out}\nEnable Wireless debugging on the phone and use the IP:port it shows\nAndroid 11+: pair first (phonedock pair <code>)`);
  return r.out;
}

async function adbPair(address: string, code: string, opts: WifiOpts): Promise<string> {
  const r = await runWithDiagnosis(async () => {
    const x = await A.adbGlobal(['pair', address, code], { allowFail: true, timeoutMs: 30_000 });
    const out = (x.stdout + x.stderr).trim();
    return { ok: /Successfully paired/i.test(out), out };
  }, { host: hostOf(address), port: Number(address.split(':')[1]) }, opts, diagnoseDeps());
  if (!r.ok) throw new PhoneDockError('Couldn’t pair the Android phone', 'pair_failed', 502, ['Check the six-digit code on the phone', 'The code changes each time the pairing screen opens'], `adb pair failed: ${r.out}`);
  return r.out;
}

/** The adb serial under which this phone is online (ip:port, or the mDNS name adb auto-connects with). */
async function onlineSerial(p: AndroidPhone): Promise<string | undefined> {
  const d = (await A.adbDevices()).find((x) => x.state === 'device' && (x.serial === `${p.ip}:${p.connectPort}` || x.serial.startsWith(`adb-${p.serial}-`) || x.serial === p.serial));
  return d?.serial;
}

async function connectPhone(p: AndroidPhone, opts: WifiOpts): Promise<{ message: string; serial: string }> {
  if (!p.ip || !p.connectPort) throw noConnectError(p.serial);
  const address = `${p.ip}:${p.connectPort}`;
  const message = await adbConnect(address, opts);
  const serial = await waitFor(() => onlineSerial(p), 20_000, 750, `${p.model ?? p.serial} to come online`);
  return { message, serial };
}

const ID = 'android-device';
const isEmulator = (serial: string) => /^emulator-\d+$/.test(serial);

// One phone can be on several adb transports at once: USB, Wireless debugging (an mDNS name or ip:port) and the
// older `adb tcpip` (ip:5555). PhoneDock lists it once, under its hardware serial, and talks to it over the best live
// transport, so unplugging the cable keeps the same device (and lease) going over Wi-Fi.
type TransportInfo = { hw: string; release?: string; sdk?: string; brand?: string; deviceName?: string };
const transportInfo = new Map<string, TransportInfo>();
/** `adb-<serial>-<suffix>._adb-tls-connect._tcp` → serial */
export const mdnsSerial = (s: string): string | undefined => /^adb-([^-]+)-[^.]+\._adb-tls-connect\._tcp/.exec(s)?.[1];
const isNetwork = (s: string) => s.includes(':') || s.includes('_adb-tls-connect');
/** 0 = USB, 1 = Wireless debugging, 2 = adb tcpip (port 5555). Lower is preferred. */
export const transportRank = (s: string): number => (!isNetwork(s) ? 0 : /:5555$/.test(s) ? 2 : 1);

async function infoFor(d: A.AdbDeviceLine): Promise<TransportInfo | undefined> {
  const hit = transportInfo.get(d.serial); if (hit) return hit;
  if (d.state !== 'device') return mdnsSerial(d.serial) ? { hw: mdnsSerial(d.serial)! } : undefined;
  const r = await A.adb(d.serial, ['shell', 'getprop ro.serialno; getprop ro.build.version.release; getprop ro.build.version.sdk; getprop ro.product.brand; settings get global device_name'], { allowFail: true, timeoutMs: 8_000 });
  const [hw, release, sdk, brand, deviceName] = r.stdout.split('\n').map((x) => x.trim());
  if (r.code !== 0) return undefined;
  const v: TransportInfo = { hw: hw || mdnsSerial(d.serial) || d.serial, release: release || undefined, sdk: sdk || undefined, brand: brand || undefined, deviceName: deviceName && deviceName !== 'null' ? deviceName : undefined };
  transportInfo.set(d.serial, v);
  return v;
}

/** The name people know the phone by: its own device name if someone set one, else "brand model" (vivo V2246). */
export function displayName(model: string | undefined, info: { brand?: string; deviceName?: string } | undefined): string | undefined {
  if (info?.deviceName && info.deviceName !== model) return info.deviceName;
  if (!model) return undefined;
  const raw = info?.brand;
  if (!raw || model.toLowerCase().startsWith(raw.toLowerCase())) return model;
  const brand = BRANDS[raw.toLowerCase()] ?? raw.charAt(0).toUpperCase() + raw.slice(1);
  return `${brand} ${model}`;
}
/** How brands write their own names (ro.product.brand is usually lower case). */
const BRANDS: Record<string, string> = {
  google: 'Google', samsung: 'Samsung', oneplus: 'OnePlus', xiaomi: 'Xiaomi', redmi: 'Redmi', poco: 'POCO', motorola: 'Motorola',
  oppo: 'OPPO', realme: 'realme', vivo: 'vivo', iqoo: 'iQOO', nothing: 'Nothing', sony: 'Sony', honor: 'HONOR', huawei: 'HUAWEI',
  nokia: 'Nokia', asus: 'ASUS', lenovo: 'Lenovo', fairphone: 'Fairphone', tecno: 'TECNO', infinix: 'Infinix',
};

/** The hardware serial a transport belongs to (reads the phone once per transport). */
async function hardwareSerial(transport: string): Promise<string> {
  const d = (await A.adbDevices()).find((x) => x.serial === transport);
  return (d && (await infoFor(d).catch(() => undefined))?.hw) ?? mdnsSerial(transport) ?? transport;
}

async function requireOnline(serial: string): Promise<string> {
  const devs = await A.adbDevices();
  const exact = devs.find((x) => x.serial === serial);
  if (!(exact && exact.state === 'device')) {
    // `serial` is a phone's hardware serial: use its best live transport.
    const live = devs.filter((x) => !isEmulator(x.serial) && x.state === 'device');
    const match = (x: A.AdbDeviceLine) => transportInfo.get(x.serial)?.hw === serial || mdnsSerial(x.serial) === serial;
    let cands = live.filter(match);
    if (!cands.length) { await Promise.all(live.map((x) => infoFor(x).catch(() => undefined))); cands = live.filter(match); }
    if (cands.length) return cands.sort((a, b) => transportRank(a.serial) - transportRank(b.serial))[0].serial;
  }
  const d = exact ?? devs.find((x) => mdnsSerial(x.serial) === serial || transportInfo.get(x.serial)?.hw === serial);
  if (!d) throw new PhoneDockError('The Android device is not connected', 'not_found', 404, ['Connect the device and try again.'], `Device ${serial} is not connected. Connect over USB or use POST /v1/connect {address}.`);
  if (d.state === 'unauthorized') throw new PhoneDockError('The Android device is unauthorized', 'unauthorized', 409, ['Accept the USB debugging prompt on the phone.'], `Device ${serial} is unauthorized.`);
  if (d.state !== 'device') throw new PhoneDockError('The Android device is offline', 'offline', 409, ['Reconnect the cable or re-enable wireless debugging.'], `Device ${serial} state: ${d.state}`);
  return d.serial;
}

export type WifiResult = { message: string; serial: string; paired?: string };
export const backend: Backend & {
  connect(address?: string, opts?: WifiOpts): Promise<WifiResult>;
  pair(address: string, code: string, opts?: WifiOpts): Promise<string>;
  pairWithCode(code: string, opts?: WifiOpts): Promise<WifiResult>;
  discoverPhones(): Promise<AndroidPhone[]>;
  disconnect(id: string): Promise<boolean>;
} = {
  id: ID,
  displayName: 'Android phones and tablets',
  platform: 'android',
  kind: 'physical',
  capabilities: [...A.ANDROID_CAPS],

  async available(): Promise<Availability> {
    try {
      A.adbPath();
      const r = await A.adbGlobal(['version'], { allowFail: true });
      return { ok: true, version: /Android Debug Bridge version ([\d.]+)/.exec(r.stdout)?.[1] };
    } catch (e) { return { ok: false, reason: (e as Error).message, hints: (e as PhoneDockError).hints }; }
  },

  async listDevices(): Promise<Device[]> {
    let devs: A.AdbDeviceLine[] = [];
    try { devs = await A.adbDevices(); } catch { return []; }
    const phones = devs.filter((d) => !isEmulator(d.serial));
    for (const k of transportInfo.keys()) if (!phones.some((d) => d.serial === k)) transportInfo.delete(k);
    const infos = await Promise.all(phones.map((d) => infoFor(d).catch(() => undefined)));
    // Group transports by phone; the best one (online first, then USB > Wireless debugging > tcpip) speaks for it.
    const groups = new Map<string, { d: A.AdbDeviceLine; info?: TransportInfo }[]>();
    phones.forEach((d, i) => { const key = infos[i]?.hw ?? d.serial; groups.set(key, [...(groups.get(key) ?? []), { d, info: infos[i] }]); });
    return [...groups.entries()].map(([key, members]) => {
      members.sort((a, b) => Number(b.d.state === 'device') - Number(a.d.state === 'device') || transportRank(a.d.serial) - transportRank(b.d.serial));
      const { d } = members[0];
      const info = members.find((m) => m.info?.release)?.info;
      const state: DeviceState = d.state === 'device' ? 'running' : d.state === 'unauthorized' ? 'unauthorized' : d.state === 'offline' ? 'offline' : 'unknown';
      const model = (members.find((m) => m.d.props.model)?.d.props.model)?.replace(/_/g, ' ');
      const name = displayName(model, info ?? members.find((m) => m.info)?.info);
      return {
        id: `${ID}:${key}`, backend: ID, nativeId: key, name: name ?? key,
        platform: 'android', kind: 'physical', state, managed: false, model, connection: isNetwork(d.serial) ? 'wifi' : 'usb',
        osVersion: info?.release ? `Android ${info.release}${info.sdk ? ` (API ${info.sdk})` : ''}` : undefined,
        screen: state === 'running' ? A.knownScreen(d.serial) : undefined,
        capabilities: [...backend.capabilities],
        error: state === 'unauthorized' ? 'Accept the USB debugging prompt on the phone' : undefined,
        meta: { serial: d.serial, transports: members.map((m) => m.d.serial), ...d.props },
      } satisfies Device;
    });
  },

  async discoverPhones() { return discoverPhones(); },
  /** Drop every Wi-Fi transport of this phone (a USB cable stays connected). */
  async disconnect(id: string) {
    const mine = (await A.adbDevices()).filter((x) => isNetwork(x.serial) && (x.serial === id || transportInfo.get(x.serial)?.hw === id || mdnsSerial(x.serial) === id));
    for (const x of mine) { await A.adbGlobal(['disconnect', x.serial], { allowFail: true }); transportInfo.delete(x.serial); }
    return mine.length > 0;
  },
  async connect(address?: string, opts: WifiOpts = {}) {
    if (!address) {
      const phones = await discoverPhones();
      const c = chooseConnect(phones, opts.serial);
      if (c.kind === 'none') throw noConnectError(opts.serial);
      if (c.kind === 'many') throw manyPhonesError('connect', c.phones);
      if (c.phone.connected && !opts.serial) return { message: `${c.phone.serial} is already connected`, serial: await hardwareSerial(await onlineSerial(c.phone) ?? c.phone.serial) };
      const r = await connectPhone(c.phone, opts);
      return { ...r, serial: await hardwareSerial(r.serial) };
    }
    if (!/^[\w.-]+:\d+$/.test(address) && !/^[\w.-]+$/.test(address)) throw new PhoneDockError('The device address is invalid', 'bad_request', 400, undefined, 'Provide a host or host:port address.');
    const out = await adbConnect(address, opts);
    const online = await waitFor(async () => (await A.adbDevices()).find((x) => x.serial === address && x.state === 'device')?.serial, 10_000, 500, `${address} to come online`).catch(() => address);
    return { message: out, serial: await hardwareSerial(online) };
  },
  async pair(address: string, code: string, opts: WifiOpts = {}) {
    if (!/^[\w.-]+:\d+$/.test(address)) throw new PhoneDockError('The device address is invalid', 'bad_request', 400, undefined, 'Provide an address as host:port.');
    if (!/^\d{6}$/.test(code)) throw new PhoneDockError('The pairing code must be six digits', 'bad_request', 400);
    return adbPair(address, code, opts);
  },
  /** Pair with only the code: find the phone showing its pairing screen, pair, then connect and wait until it is online. */
  async pairWithCode(code: string, opts: WifiOpts = {}) {
    if (!/^\d{6}$/.test(code)) throw new PhoneDockError('The pairing code must be six digits', 'bad_request', 400);
    const phones = await discoverPhones();
    const c = choosePairing(phones, opts.serial);
    if (c.kind === 'none') throw noPairingError(opts.serial);
    if (c.kind === 'many') throw manyPhonesError('pair', c.phones);
    const p = c.phone;
    if (!p.ip) throw new PhoneDockError('Couldn’t find the phone’s address', 'no_address', 502, ['Phone and Mac must be on the same Wi-Fi'], `${p.serial} (${p.host}) did not resolve to an IPv4 address.`);
    const pairOut = await adbPair(`${p.ip}:${p.pairingPort}`, code, opts);
    // The connect service shows up a moment after pairing.
    const target = await waitFor(async () => matchConnectService(await discoverPhones(), p), 15_000, 1000, 'the phone to offer a wireless connection').catch(() => undefined);
    if (!target) throw new PhoneDockError('Paired, but the phone isn’t offering a connection yet', 'connect_pending', 504,
      ['Check that Wireless debugging is still on, then run: phonedock connect'], `Paired ${p.serial}: ${pairOut}`);
    const r = await connectPhone(target, opts);
    return { message: `${pairOut}\n${r.message}`, serial: await hardwareSerial(r.serial), paired: p.serial };
  },

  async openWindow(id) {
    const serial = await requireOnline(id);
    const scrcpy = which('scrcpy');
    if (!scrcpy) throw new PhoneDockError('The tool needed to open the device window is missing', 'scrcpy_missing', 501, ['Install scrcpy and try again.'], 'Install scrcpy with brew install scrcpy.');
    spawn(scrcpy, ['-s', serial], { detached: true, stdio: 'ignore', env: { ...toolEnv(), ADB: A.adbPath() } }).unref();
  },
  async screenshot(s) { return A.screenshot(await requireOnline(s)); },
  async screenInfo(s) { return A.screenInfo(await requireOnline(s)); },
  stream(s, opts) { return A.adbFrameStream(s, opts); },
  async uiTree(s) { return A.uiTree(await requireOnline(s)); },
  async tap(s, x, y) { await A.tap(await requireOnline(s), x, y); },
  async longPress(s, x, y, ms) { await A.longPress(await requireOnline(s), x, y, ms); },
  async swipe(s, x1, y1, x2, y2, ms) { await A.swipe(await requireOnline(s), x1, y1, x2, y2, ms); },
  async type(s, t) { await A.typeText(await requireOnline(s), t); },
  async key(s, k) { await A.key(await requireOnline(s), k); },
  async installApp(s, p) { return A.installApp(await requireOnline(s), p); },
  async uninstallApp(s, id) { await A.uninstallApp(await requireOnline(s), id); },
  async listApps(s: string, opts?: { system?: boolean }) { return A.listApps(await requireOnline(s), !!opts?.system); },
  async launchApp(s, id) { await A.launchApp(await requireOnline(s), id); },
  async terminateApp(s, id) { await A.terminateApp(await requireOnline(s), id); },
  async openUrl(s, u) { await A.openUrl(await requireOnline(s), u); },
  async shell(s, c) { return A.shell(await requireOnline(s), c); },
  async pushFile(s, l, r) { await A.pushFile(await requireOnline(s), l, r); },
  async pullFile(s, r, l) { await A.pullFile(await requireOnline(s), r, l); },
  async logs(s, o) { return A.logs(await requireOnline(s), o); },
  async rotate(s, o) { await A.rotate(await requireOnline(s), o); },
  async info(s) { return A.info(await requireOnline(s)); },
  // ── v0.2 (pinch: not offered – `input` has no multi-pointer injection and `sendevent` needs root) ──
  async doubleTap(s, x, y) { await A.doubleTap(await requireOnline(s), x, y); },
  async drag(s, x1, y1, x2, y2, ms, hold) { await A.drag(await requireOnline(s), x1, y1, x2, y2, ms, hold); },
  async hideKeyboard(s) { await A.hideKeyboard(await requireOnline(s)); },
  async foregroundApp(s) { return A.foregroundApp(await requireOnline(s)); },
  async listCrashes(s, o) { return A.listCrashes(await requireOnline(s), o); },
  async getCrash(s, id) { return A.getCrash(await requireOnline(s), id); },
  async startRecording(s, out, o) { await A.startRecording(await requireOnline(s), out, o); },
  async stopRecording(s) { return A.stopRecording(await requireOnline(s)); },
  async exportAppData(s, pkg, dir) { await A.exportAppData(await requireOnline(s), pkg, dir); },
  async importAppData(s, pkg, dir) { await A.importAppData(await requireOnline(s), pkg, dir); },
  async startTrace(s, dir, o) { return T.startPerfetto(await requireOnline(s), dir, o); },
  async stopTrace(s) { return T.stopPerfetto(await requireOnline(s)); },
  async abortTrace(s) { await T.abortPerfetto(s); },
};
