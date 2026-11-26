// Saved proxy store (stateDir/proxies.json, mode 0600), local forwarder pool, and live Android attachment lifecycle.
// Credentials are never returned by APIs, never logged, and scrubbed from errors.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { adb } from '../backends/android-common.ts';
import { stateDir } from '../core/paths.ts';
import {
  normalizeProxyName, parseProxyUrl, redactProxySecrets, redactProxyUrl, toProxyView,
  type DeviceProxyState, type ProxyEndpoint, type ProxyTestResult, type ProxyView, type SavedProxyStored,
} from '../core/proxy.ts';
import { PhoneDockError, type Device, type ExecResult } from '../core/types.ts';
import { startProxyForwarder, type ProxyForwarder } from './proxy-forwarder.ts';
import { testProxy, type TestProxyOptions } from './proxy-tunnel.ts';

interface ProxyStoreFile {
  v: 1;
  proxies: SavedProxyStored[];
  /** Persisted deviceId -> proxyId attachments. */
  attachments: Record<string, string>;
}

interface ForwarderEntry {
  proxyId: string;
  configKey: string;
  fw: ProxyForwarder;
  devices: Set<string>;
}

interface AppliedState {
  proxyId: string;
  port: number;
  serial: string;
  error?: string;
}

export type AdbRunner = (serial: string, args: string[], opts?: { allowFail?: boolean; timeoutMs?: number }) => Promise<ExecResult>;

export interface ProxyManagerOptions {
  storeFile?: () => string;
  runAdb?: AdbRunner;
  startForwarder?: (proxy: ProxyEndpoint) => Promise<ProxyForwarder>;
  testFn?: (proxy: ProxyEndpoint, opts?: TestProxyOptions) => Promise<ProxyTestResult>;
  emitEvent?: (event: string, data: unknown) => void;
  logAction?: (deviceId: string, owner: string, action: unknown) => void;
  invalidateDevices?: () => void;
  getDevices?: () => Promise<Device[]>;
}

export const ANDROID_PROXY_NOTE = 'Applies live to Android apps that honor the system HTTP proxy; UDP/QUIC traffic is not proxied (Chrome falls back to TCP).';

export function isProxySupportedBackend(backend: string): boolean {
  return backend === 'android-emulator' || backend === 'android-device';
}

export function unsupportedProxyReason(backend: string): { message: string; hints: string[] } {
  if (backend === 'ios-simulator') {
    return {
      message: 'iOS simulators share this Mac’s network stack and do not support per-device proxies',
      hints: ['Set a proxy in macOS System Settings › Network, or use an Android emulator or Android phone for per-device proxies.'],
    };
  }
  if (backend === 'ios-device') {
    return {
      message: 'Real iPhones keep their HTTP proxy in Settings › Wi-Fi on the device; PhoneDock cannot set it remotely',
      hints: ['Configure the HTTP proxy under Settings › Wi-Fi › (i) › Configure Proxy on the iPhone itself.'],
    };
  }
  return {
    message: `Per-device proxies are not supported on ${backend}`,
    hints: ['Attach proxies to Android emulators (android-emulator) or Android phones (android-device).'],
  };
}

function configKeyOf(p: ProxyEndpoint): string {
  return JSON.stringify([p.scheme, p.host, p.port, p.username ?? null, p.password ?? null]);
}

function serialOf(d: Pick<Device, 'meta'>): string | undefined {
  const s = d.meta?.serial;
  return typeof s === 'string' && s.trim() ? s.trim() : undefined;
}

export class ProxyManager {
  private readonly storeFile: () => string;
  private readonly runAdb: AdbRunner;
  private readonly startForwarder: (proxy: ProxyEndpoint) => Promise<ProxyForwarder>;
  private readonly testFn: (proxy: ProxyEndpoint, opts?: TestProxyOptions) => Promise<ProxyTestResult>;
  private readonly emitEvent: (event: string, data: unknown) => void;
  private readonly logAction: (deviceId: string, owner: string, action: unknown) => void;
  private readonly invalidateDevices: () => void;
  private readonly getDevices: () => Promise<Device[]>;

  private data: ProxyStoreFile = { v: 1, proxies: [], attachments: {} };
  private mtimeMs = -1;
  private readonly forwarders = new Map<string, ForwarderEntry>();
  private readonly applied = new Map<string, AppliedState>();

  constructor(opts: ProxyManagerOptions = {}) {
    this.storeFile = opts.storeFile ?? (() => join(stateDir(), 'proxies.json'));
    this.runAdb = opts.runAdb ?? ((serial, args, o) => adb(serial, args, o));
    this.startForwarder = opts.startForwarder ?? startProxyForwarder;
    this.testFn = opts.testFn ?? testProxy;
    this.emitEvent = opts.emitEvent ?? (() => {});
    this.logAction = opts.logAction ?? (() => {});
    this.invalidateDevices = opts.invalidateDevices ?? (() => {});
    this.getDevices = opts.getDevices ?? (async () => []);
  }

  private fileMtime(): number {
    try { return statSync(this.storeFile()).mtimeMs; } catch { return -1; }
  }

  private loadIfChanged(): void {
    const m = this.fileMtime();
    if (m === this.mtimeMs) return;
    this.mtimeMs = m;
    if (m < 0) {
      this.data = { v: 1, proxies: [], attachments: {} };
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.storeFile(), 'utf8')) as Partial<ProxyStoreFile>;
      const proxies = Array.isArray(parsed.proxies) ? parsed.proxies : [];
      const attachments = parsed.attachments && typeof parsed.attachments === 'object' && !Array.isArray(parsed.attachments)
        ? { ...parsed.attachments }
        : {};
      this.data = { v: 1, proxies, attachments };
    } catch {
      this.data = { v: 1, proxies: [], attachments: {} };
    }
  }

  private save(): void {
    const file = this.storeFile();
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch { /* best effort */ }
    renameSync(tmp, file);
    try { chmodSync(file, 0o600); } catch { /* best effort */ }
    this.mtimeMs = this.fileMtime();
  }

  private findStored(id: string): SavedProxyStored {
    this.loadIfChanged();
    const p = this.data.proxies.find((x) => x.id === id);
    if (!p) {
      throw new PhoneDockError(`Proxy "${id}" was not found`, 'not_found', 404, ['List saved proxies first.']);
    }
    return p;
  }

  list(): ProxyView[] {
    this.loadIfChanged();
    return this.data.proxies.map(toProxyView);
  }

  get(id: string): ProxyView {
    return toProxyView(this.findStored(id));
  }

  /** Test an unsaved proxy URL on the spot without saving it. */
  async testUrl(rawUrl: unknown, opts?: TestProxyOptions): Promise<ProxyTestResult> {
    const endpoint = parseProxyUrl(rawUrl);
    return this.testFn(endpoint, opts);
  }

  /** Test a saved proxy and persist its lastTest summary. */
  async testSaved(id: string, opts?: TestProxyOptions): Promise<{ proxy: ProxyView; result: ProxyTestResult }> {
    const stored = this.findStored(id);
    const result = await this.testFn(stored, opts);
    stored.lastTest = result;
    stored.updatedAt = new Date().toISOString();
    this.save();
    const view = toProxyView(stored);
    this.emitEvent('proxies', { action: 'tested', proxy: view });
    this.invalidateDevices();
    return { proxy: view, result };
  }

  async add(input: { name: unknown; url: unknown; test?: boolean; lastTest?: ProxyTestResult }, testOpts?: TestProxyOptions): Promise<ProxyView> {
    this.loadIfChanged();
    const name = normalizeProxyName(input.name);
    const endpoint = parseProxyUrl(input.url);
    const now = new Date().toISOString();
    let lastTest = input.lastTest;
    if (input.test) {
      lastTest = await this.testFn(endpoint, testOpts);
    }
    const stored: SavedProxyStored = {
      id: `px_${randomBytes(4).toString('hex')}`,
      name,
      ...endpoint,
      createdAt: now,
      updatedAt: now,
      ...(lastTest ? { lastTest } : {}),
    };
    this.data.proxies.push(stored);
    this.save();
    const view = toProxyView(stored);
    this.emitEvent('proxies', { action: 'added', proxy: view });
    return view;
  }

  async update(id: string, patch: { name?: unknown; url?: unknown }): Promise<ProxyView> {
    const stored = this.findStored(id);
    if (patch.name === undefined && patch.url === undefined) {
      throw new PhoneDockError('Provide name and/or url to update', 'bad_request', 400);
    }
    const prevKey = configKeyOf(stored);
    if (patch.name !== undefined) stored.name = normalizeProxyName(patch.name);
    if (patch.url !== undefined) {
      const ep = parseProxyUrl(patch.url);
      stored.scheme = ep.scheme;
      stored.host = ep.host;
      stored.port = ep.port;
      if (ep.username !== undefined) stored.username = ep.username; else delete stored.username;
      if (ep.password !== undefined) stored.password = ep.password; else delete stored.password;
      delete stored.lastTest;
    }
    stored.updatedAt = new Date().toISOString();
    this.save();

    // If endpoint changed and a forwarder is active, rotate it and re-apply to attached running devices.
    if (configKeyOf(stored) !== prevKey && this.forwarders.has(id)) {
      const oldEntry = this.forwarders.get(id)!;
      this.forwarders.delete(id);
      const devices = await this.getDevices().catch(() => [] as Device[]);
      const affected = Object.entries(this.data.attachments).filter(([, pid]) => pid === id).map(([did]) => did);
      for (const did of affected) {
        const d = devices.find((x) => x.id === did);
        if (d && d.state === 'running') {
          await this.applyToRunningDevice(d, stored, oldEntry.fw.port).catch(() => undefined);
        }
      }
      await oldEntry.fw.close().catch(() => undefined);
    }

    const view = toProxyView(stored);
    this.emitEvent('proxies', { action: 'updated', proxy: view });
    this.invalidateDevices();
    return view;
  }

  async remove(id: string, owner = 'daemon'): Promise<{ ok: true; detachedDevices: string[] }> {
    this.findStored(id);
    const attached = Object.entries(this.data.attachments).filter(([, pid]) => pid === id).map(([did]) => did);
    const devices = attached.length ? await this.getDevices().catch(() => [] as Device[]) : [];
    for (const did of attached) {
      const d = devices.find((x) => x.id === did);
      if (d) {
        await this.detach(d, owner).catch(() => undefined);
      } else {
        delete this.data.attachments[did];
        this.applied.delete(did);
        await this.releaseForwarderDevice(id, did);
      }
    }
    this.data.proxies = this.data.proxies.filter((x) => x.id !== id);
    this.save();
    const entry = this.forwarders.get(id);
    if (entry) {
      this.forwarders.delete(id);
      await entry.fw.close().catch(() => undefined);
    }
    this.emitEvent('proxies', { action: 'removed', id });
    this.invalidateDevices();
    return { ok: true, detachedDevices: attached };
  }

  /** Summary for Device.meta.proxy (never includes password). */
  deviceMeta(deviceId: string): Record<string, unknown> | undefined {
    this.loadIfChanged();
    const proxyId = this.data.attachments[deviceId];
    if (!proxyId) return undefined;
    const stored = this.data.proxies.find((x) => x.id === proxyId);
    if (!stored) return undefined;
    const rt = this.applied.get(deviceId);
    return {
      id: stored.id,
      name: stored.name,
      url: redactProxyUrl(stored),
      applied: rt?.proxyId === proxyId && !rt.error,
      ...(rt?.port ? { localPort: rt.port } : {}),
      ...(stored.lastTest?.ok ? { exitIp: stored.lastTest.ip, exitCountry: stored.lastTest.country } : {}),
      ...(rt?.error ? { error: rt.error } : {}),
    };
  }

  getDeviceState(d: Pick<Device, 'id' | 'backend' | 'state'>): DeviceProxyState {
    this.loadIfChanged();
    if (!isProxySupportedBackend(d.backend)) {
      const { message } = unsupportedProxyReason(d.backend);
      return { deviceId: d.id, supported: false, reason: message, proxyId: null, proxy: null, applied: false };
    }
    const proxyId = this.data.attachments[d.id] ?? null;
    const stored = proxyId ? this.data.proxies.find((x) => x.id === proxyId) ?? null : null;
    const rt = this.applied.get(d.id);
    const applied = Boolean(stored && d.state === 'running' && rt && rt.proxyId === stored.id && !rt.error);
    return {
      deviceId: d.id,
      supported: true,
      proxyId: stored ? stored.id : null,
      proxy: stored ? toProxyView(stored) : null,
      applied,
      ...(applied && rt ? { localPort: rt.port } : {}),
      ...(rt?.error ? { error: rt.error } : {}),
      ...(stored && d.state !== 'running' ? { note: 'Saved; will apply automatically when the device boots.' } : {}),
      ...(applied ? { note: ANDROID_PROXY_NOTE } : {}),
    };
  }

  async attach(d: Pick<Device, 'id' | 'backend' | 'state' | 'meta'>, proxyId: string, owner = 'daemon'): Promise<DeviceProxyState> {
    if (!isProxySupportedBackend(d.backend)) {
      const { message, hints } = unsupportedProxyReason(d.backend);
      throw new PhoneDockError(message, 'not_supported', 501, hints);
    }
    const stored = this.findStored(proxyId);
    const prevProxyId = this.data.attachments[d.id];
    const prevApplied = this.applied.get(d.id);

    this.data.attachments[d.id] = stored.id;
    this.save();

    if (prevProxyId && prevProxyId !== stored.id) {
      await this.releaseForwarderDevice(prevProxyId, d.id);
    }

    if (d.state === 'running') {
      await this.applyToRunningDevice(d, stored, prevApplied && prevApplied.proxyId !== stored.id ? prevApplied.port : undefined);
    } else {
      this.applied.delete(d.id);
    }

    this.logAction(d.id, owner, { action: 'proxy.attach', proxyId: stored.id, name: stored.name, url: redactProxyUrl(stored) });
    this.invalidateDevices();
    return this.getDeviceState(d);
  }

  async detach(d: Pick<Device, 'id' | 'backend' | 'state' | 'meta'>, owner = 'daemon'): Promise<DeviceProxyState> {
    if (!isProxySupportedBackend(d.backend)) {
      const { message, hints } = unsupportedProxyReason(d.backend);
      throw new PhoneDockError(message, 'not_supported', 501, hints);
    }
    this.loadIfChanged();
    const prevProxyId = this.data.attachments[d.id];
    const prevApplied = this.applied.get(d.id);
    delete this.data.attachments[d.id];
    this.applied.delete(d.id);
    this.save();

    const serial = serialOf(d) ?? prevApplied?.serial;
    if (d.state === 'running' && serial) {
      await this.runAdb(serial, ['shell', 'settings', 'put', 'global', 'http_proxy', ':0'], { allowFail: true, timeoutMs: 15_000 });
      if (prevApplied?.port) {
        await this.runAdb(serial, ['reverse', '--remove', `tcp:${prevApplied.port}`], { allowFail: true, timeoutMs: 10_000 });
      }
    }

    if (prevProxyId) {
      await this.releaseForwarderDevice(prevProxyId, d.id);
      this.logAction(d.id, owner, { action: 'proxy.detach', proxyId: prevProxyId });
    }
    this.invalidateDevices();
    return this.getDeviceState(d);
  }

  /** Re-apply persisted proxy to one device after boot, restart, or wake from idle sleep. */
  async reapplyDevice(d: Pick<Device, 'id' | 'backend' | 'state' | 'meta'>): Promise<void> {
    this.loadIfChanged();
    if (!isProxySupportedBackend(d.backend) || d.state !== 'running') return;
    const proxyId = this.data.attachments[d.id];
    if (!proxyId) return;
    const stored = this.data.proxies.find((x) => x.id === proxyId);
    if (!stored) return;
    try {
      await this.applyToRunningDevice(d, stored);
    } catch (e) {
      const msg = redactProxySecrets((e as Error)?.message ?? String(e), [stored.password]);
      this.applied.set(d.id, { proxyId: stored.id, port: 0, serial: serialOf(d) ?? '', error: msg });
    }
    this.invalidateDevices();
  }

  /** Re-apply persisted proxies across all currently running Android devices (daemon startup). */
  async reconcileAll(devices: readonly Device[]): Promise<void> {
    this.loadIfChanged();
    for (const d of devices) {
      if (this.data.attachments[d.id] && d.state === 'running') {
        await this.reapplyDevice(d);
      }
    }
  }

  /** Clean up persisted attachment and forwarder refcount when a device is deleted. */
  async onDeviceDeleted(deviceId: string): Promise<void> {
    this.loadIfChanged();
    const proxyId = this.data.attachments[deviceId];
    if (!proxyId) return;
    delete this.data.attachments[deviceId];
    this.applied.delete(deviceId);
    this.save();
    await this.releaseForwarderDevice(proxyId, deviceId);
  }

  /** Clean up forwarder refcount when a device shuts down (keeps persisted attachment for next boot). */
  async onDeviceStopped(deviceId: string): Promise<void> {
    const rt = this.applied.get(deviceId);
    this.applied.delete(deviceId);
    if (rt?.proxyId) {
      await this.releaseForwarderDevice(rt.proxyId, deviceId);
    }
  }

  /** Stop all local forwarders on daemon exit. */
  async closeAll(): Promise<void> {
    const entries = [...this.forwarders.values()];
    this.forwarders.clear();
    this.applied.clear();
    await Promise.all(entries.map((e) => e.fw.close().catch(() => undefined)));
  }

  private async ensureForwarder(stored: SavedProxyStored, deviceId: string): Promise<number> {
    const key = configKeyOf(stored);
    const existing = this.forwarders.get(stored.id);
    if (existing && existing.configKey === key) {
      existing.devices.add(deviceId);
      return existing.fw.port;
    }
    const fw = await this.startForwarder(stored);
    const entry: ForwarderEntry = { proxyId: stored.id, configKey: key, fw, devices: new Set([deviceId]) };
    this.forwarders.set(stored.id, entry);
    if (existing) await existing.fw.close().catch(() => undefined);
    return fw.port;
  }

  private async releaseForwarderDevice(proxyId: string, deviceId: string): Promise<void> {
    const entry = this.forwarders.get(proxyId);
    if (!entry) return;
    entry.devices.delete(deviceId);
    if (entry.devices.size === 0) {
      this.forwarders.delete(proxyId);
      await entry.fw.close().catch(() => undefined);
    }
  }

  private async applyToRunningDevice(
    d: Pick<Device, 'id' | 'backend' | 'state' | 'meta'>,
    stored: SavedProxyStored,
    oldPortToRemove?: number,
  ): Promise<void> {
    const serial = serialOf(d);
    if (!serial) {
      throw new PhoneDockError('Android device is running but its adb serial is unavailable', 'proxy_apply_failed', 503);
    }
    const port = await this.ensureForwarder(stored, d.id);
    if (oldPortToRemove && oldPortToRemove !== port) {
      await this.runAdb(serial, ['reverse', '--remove', `tcp:${oldPortToRemove}`], { allowFail: true, timeoutMs: 10_000 });
    }
    const rev = await this.runAdb(serial, ['reverse', `tcp:${port}`, `tcp:${port}`], { allowFail: true, timeoutMs: 15_000 });
    if (rev.code !== 0) {
      await this.releaseForwarderDevice(stored.id, d.id);
      throw new PhoneDockError(
        'Couldn’t forward the local proxy to the Android device',
        'proxy_apply_failed',
        502,
        ['Check that the device is online in adb and retry.'],
        redactProxySecrets((rev.stderr || rev.stdout).trim(), [stored.password]),
      );
    }
    const set = await this.runAdb(serial, ['shell', 'settings', 'put', 'global', 'http_proxy', `127.0.0.1:${port}`], { allowFail: true, timeoutMs: 15_000 });
    if (set.code !== 0) {
      await this.runAdb(serial, ['reverse', '--remove', `tcp:${port}`], { allowFail: true, timeoutMs: 10_000 });
      await this.releaseForwarderDevice(stored.id, d.id);
      throw new PhoneDockError(
        'Couldn’t apply the HTTP proxy setting on the Android device',
        'proxy_apply_failed',
        502,
        ['Some vendor Android builds restrict global settings writes over adb.'],
        redactProxySecrets((set.stderr || set.stdout).trim(), [stored.password]),
      );
    }
    this.applied.set(d.id, { proxyId: stored.id, port, serial });
  }
}

// ── Daemon singleton wiring ─────────────────────────────────────────────────
let singleton: ProxyManager | undefined;

export function initProxies(deps: {
  emitEvent: (event: string, data: unknown) => void;
  logAction: (deviceId: string, owner: string, action: unknown) => void;
  invalidateDevices: () => void;
  getDevices: () => Promise<Device[]>;
}): ProxyManager {
  singleton = new ProxyManager(deps);
  return singleton;
}

export function proxyManager(): ProxyManager {
  if (!singleton) singleton = new ProxyManager();
  return singleton;
}
