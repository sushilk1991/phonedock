// Saved proxy store (stateDir/proxies.json, mode 0600), local forwarder pool, and live Android attachment lifecycle.
// Credentials are never returned by APIs, never logged, and scrubbed from errors.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
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
  /** Devices detached while stopped/asleep whose Android http_proxy must be cleared on next boot/wake. */
  pendingClear: string[];
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
  remoteSpec?: string;
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
  /** Enforces device filter visibility and device lease ownership before mutating/detaching an attached device. */
  assertCanMutateDevice?: (deviceId: string, owner: string) => void;
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

/** Create an immutable endpoint snapshot so concurrent PATCH mutations never leak credentials across providers. */
function snapshotEndpoint(p: ProxyEndpoint): Readonly<ProxyEndpoint> {
  return Object.freeze({
    scheme: p.scheme,
    host: p.host,
    port: p.port,
    ...(p.username !== undefined ? { username: p.username } : {}),
    ...(p.password !== undefined ? { password: p.password } : {}),
  });
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
  private readonly assertCanMutateDevice: (deviceId: string, owner: string) => void;

  private data: ProxyStoreFile = { v: 1, proxies: [], attachments: {}, pendingClear: [] };
  private mtimeMs = -1;
  private readonly forwarders = new Map<string, ForwarderEntry>();
  private readonly startingForwarders = new Map<string, Promise<ForwarderEntry>>();
  private readonly applied = new Map<string, AppliedState>();
  private readonly reconciling = new Set<string>();

  constructor(opts: ProxyManagerOptions = {}) {
    this.storeFile = opts.storeFile ?? (() => join(stateDir(), 'proxies.json'));
    this.runAdb = opts.runAdb ?? ((serial, args, o) => adb(serial, args, o));
    this.startForwarder = opts.startForwarder ?? startProxyForwarder;
    this.testFn = opts.testFn ?? testProxy;
    this.emitEvent = opts.emitEvent ?? (() => {});
    this.logAction = opts.logAction ?? (() => {});
    this.invalidateDevices = opts.invalidateDevices ?? (() => {});
    this.getDevices = opts.getDevices ?? (async () => []);
    this.assertCanMutateDevice = opts.assertCanMutateDevice ?? (() => {});
  }

  private fileMtime(): number {
    try { return statSync(this.storeFile()).mtimeMs; } catch { return -1; }
  }

  private readStoreFromDisk(): ProxyStoreFile {
    try {
      const parsed = JSON.parse(readFileSync(this.storeFile(), 'utf8')) as Partial<ProxyStoreFile>;
      const proxies = Array.isArray(parsed.proxies) ? parsed.proxies : [];
      const attachments = parsed.attachments && typeof parsed.attachments === 'object' && !Array.isArray(parsed.attachments)
        ? { ...parsed.attachments }
        : {};
      const pendingClear = Array.isArray(parsed.pendingClear) ? parsed.pendingClear.filter((x): x is string => typeof x === 'string') : [];
      return { v: 1, proxies, attachments, pendingClear };
    } catch {
      return { v: 1, proxies: [], attachments: {}, pendingClear: [] };
    }
  }

  private loadIfChanged(): void {
    const m = this.fileMtime();
    if (m === this.mtimeMs) return;
    this.mtimeMs = m;
    this.data = m < 0 ? { v: 1, proxies: [], attachments: {}, pendingClear: [] } : this.readStoreFromDisk();
  }

  /** Reload fresh state from disk right before a synchronous mutation, then save atomically (avoids stale RMW overwrite across daemons). */
  private mutateStore<T>(fn: (store: ProxyStoreFile) => T): T {
    this.data = this.readStoreFromDisk();
    const res = fn(this.data);
    this.save();
    return res;
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
      const safeId = redactProxySecrets(id);
      throw new PhoneDockError(`Proxy "${safeId}" was not found`, 'not_found', 404, ['List saved proxies first.']);
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
    const endpoint = snapshotEndpoint(parseProxyUrl(rawUrl));
    return this.testFn(endpoint, opts);
  }

  /** Test a saved proxy and persist its lastTest summary only if its endpoint did not change while testing. */
  async testSaved(id: string, opts?: TestProxyOptions): Promise<{ proxy: ProxyView; result: ProxyTestResult }> {
    const before = this.findStored(id);
    const snap = snapshotEndpoint(before);
    const beforeKey = configKeyOf(snap);
    const result = await this.testFn(snap, opts);
    const updated = this.mutateStore((store) => {
      const current = store.proxies.find((x) => x.id === id);
      if (!current) return undefined;
      if (configKeyOf(current) === beforeKey) {
        current.lastTest = result;
        current.updatedAt = new Date().toISOString();
      }
      return toProxyView(current);
    });
    const view = updated ?? toProxyView(before);
    if (updated) {
      this.emitEvent('proxies', { action: 'tested', proxy: view });
      this.invalidateDevices();
    }
    return { proxy: view, result };
  }

  async add(input: { name: unknown; url: unknown; test?: boolean; lastTest?: ProxyTestResult }, testOpts?: TestProxyOptions): Promise<ProxyView> {
    const name = normalizeProxyName(input.name);
    const endpoint = snapshotEndpoint(parseProxyUrl(input.url));
    let lastTest = input.lastTest;
    if (input.test) {
      lastTest = await this.testFn(endpoint, testOpts);
    }
    const view = this.mutateStore((store) => {
      const now = new Date().toISOString();
      const stored: SavedProxyStored = {
        id: `px_${randomBytes(4).toString('hex')}`,
        name,
        ...endpoint,
        createdAt: now,
        updatedAt: now,
        ...(lastTest ? { lastTest } : {}),
      };
      store.proxies.push(stored);
      return toProxyView(stored);
    });
    this.emitEvent('proxies', { action: 'added', proxy: view });
    return view;
  }

  async update(id: string, patch: { name?: unknown; url?: unknown }, owner = 'daemon'): Promise<ProxyView> {
    if (patch.name === undefined && patch.url === undefined) {
      throw new PhoneDockError('Provide name and/or url to update', 'bad_request', 400);
    }
    const newName = patch.name !== undefined ? normalizeProxyName(patch.name) : undefined;
    const newEp = patch.url !== undefined ? snapshotEndpoint(parseProxyUrl(patch.url)) : undefined;

    this.loadIfChanged();
    const existing = this.findStored(id);
    const endpointChanging = newEp !== undefined && configKeyOf(newEp) !== configKeyOf(existing);
    const affected = Object.entries(this.data.attachments).filter(([, pid]) => pid === id).map(([did]) => did);
    if (endpointChanging) {
      for (const did of affected) this.assertCanMutateDevice(did, owner);
    }

    const updatedSnap = this.mutateStore((store) => {
      const stored = store.proxies.find((x) => x.id === id);
      if (!stored) throw new PhoneDockError(`Proxy "${redactProxySecrets(id)}" was not found`, 'not_found', 404);
      if (newName !== undefined) stored.name = newName;
      if (newEp !== undefined) {
        stored.scheme = newEp.scheme;
        stored.host = newEp.host;
        stored.port = newEp.port;
        if (newEp.username !== undefined) stored.username = newEp.username; else delete stored.username;
        if (newEp.password !== undefined) stored.password = newEp.password; else delete stored.password;
        delete stored.lastTest;
      }
      stored.updatedAt = new Date().toISOString();
      return { stored: { ...stored }, view: toProxyView(stored) };
    });

    // If endpoint changed and a forwarder is active, rotate it and re-apply to every running attached device.
    if (endpointChanging && this.forwarders.has(id)) {
      const oldEntry = this.forwarders.get(id)!;
      this.forwarders.delete(id);
      const devices = await this.getDevices().catch(() => [] as Device[]);
      for (const did of affected) {
        const d = devices.find((x) => x.id === did);
        const prevRt = this.applied.get(did);
        if (d && d.state === 'running') {
          try {
            await this.applyToRunningDevice(d, updatedSnap.stored, prevRt?.remoteSpec);
          } catch (e) {
            const msg = redactProxySecrets((e as Error)?.message ?? String(e), [updatedSnap.stored.password]);
            this.applied.set(did, { proxyId: id, port: 0, serial: serialOf(d) ?? '', error: msg });
          }
        } else {
          this.applied.delete(did);
        }
      }
      await oldEntry.fw.close().catch(() => undefined);
    }

    this.emitEvent('proxies', { action: 'updated', proxy: updatedSnap.view });
    this.invalidateDevices();
    return updatedSnap.view;
  }

  async remove(id: string, owner = 'daemon'): Promise<{ ok: true; detachedDevices: string[] }> {
    this.findStored(id);
    const attached = Object.entries(this.data.attachments).filter(([, pid]) => pid === id).map(([did]) => did);
    // Enforce visibility filter and device leases BEFORE detaching or deleting anything.
    for (const did of attached) this.assertCanMutateDevice(did, owner);

    const devices = attached.length ? await this.getDevices().catch(() => [] as Device[]) : [];
    for (const did of attached) {
      const d = devices.find((x) => x.id === did);
      if (d) {
        await this.detach(d, owner);
      } else {
        this.mutateStore((store) => {
          delete store.attachments[did];
          if (!store.pendingClear.includes(did)) store.pendingClear.push(did);
        });
        this.applied.delete(did);
        await this.releaseForwarderDevice(id, did);
      }
    }

    this.mutateStore((store) => {
      store.proxies = store.proxies.filter((x) => x.id !== id);
    });
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
      applied: rt?.proxyId === proxyId && !rt.error && rt.port > 0,
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
    const applied = Boolean(stored && d.state === 'running' && rt && rt.proxyId === stored.id && !rt.error && rt.port > 0);
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
    const stored = { ...this.findStored(proxyId) };
    const prevProxyId = this.data.attachments[d.id];
    const prevApplied = this.applied.get(d.id);

    this.mutateStore((store) => {
      store.attachments[d.id] = stored.id;
      store.pendingClear = store.pendingClear.filter((x) => x !== d.id);
    });

    if (prevProxyId && prevProxyId !== stored.id) {
      await this.releaseForwarderDevice(prevProxyId, d.id);
    }

    if (d.state === 'running') {
      try {
        await this.applyToRunningDevice(d, stored, prevApplied && prevApplied.proxyId !== stored.id ? prevApplied.remoteSpec : undefined);
      } catch (e) {
        const msg = redactProxySecrets((e as Error)?.message ?? String(e), [stored.password]);
        this.applied.set(d.id, { proxyId: stored.id, port: 0, serial: serialOf(d) ?? '', error: msg });
        throw e;
      }
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

    // Never clobber an external/manual proxy when PhoneDock has no attachment on this device.
    if (!prevProxyId && !prevApplied && !this.data.pendingClear.includes(d.id)) {
      return this.getDeviceState(d);
    }

    const serial = serialOf(d) ?? prevApplied?.serial;
    if (d.state === 'running' && serial) {
      const cleared = await this.runAdb(serial, ['shell', 'settings', 'put', 'global', 'http_proxy', ':0'], { allowFail: true, timeoutMs: 15_000 });
      if (cleared.code !== 0) {
        throw new PhoneDockError(
          'Couldn’t clear the HTTP proxy setting on the Android device',
          'proxy_detach_failed',
          502,
          ['Check that the device is online in adb and retry.'],
          (cleared.stderr || cleared.stdout).trim(),
        );
      }
      if (prevApplied?.remoteSpec) {
        await this.runAdb(serial, ['reverse', '--remove', prevApplied.remoteSpec], { allowFail: true, timeoutMs: 10_000 });
      }
      this.mutateStore((store) => {
        delete store.attachments[d.id];
        store.pendingClear = store.pendingClear.filter((x) => x !== d.id);
      });
    } else {
      // Stopped or sleeping: remember to clear Android's persistent global http_proxy when it next boots/wakes.
      this.mutateStore((store) => {
        delete store.attachments[d.id];
        if (!store.pendingClear.includes(d.id)) store.pendingClear.push(d.id);
      });
    }

    this.applied.delete(d.id);
    if (prevProxyId) {
      await this.releaseForwarderDevice(prevProxyId, d.id);
      this.logAction(d.id, owner, { action: 'proxy.detach', proxyId: prevProxyId });
    }
    this.invalidateDevices();
    return this.getDeviceState(d);
  }

  /** Re-apply persisted proxy (or clear a deferred detach) on a running device after boot, restart, restore, or wake. */
  async reapplyDevice(d: Pick<Device, 'id' | 'backend' | 'state' | 'meta'>): Promise<void> {
    this.loadIfChanged();
    if (!isProxySupportedBackend(d.backend) || d.state !== 'running') return;
    const serial = serialOf(d);
    if (!serial) return;

    if (this.data.pendingClear.includes(d.id)) {
      const cleared = await this.runAdb(serial, ['shell', 'settings', 'put', 'global', 'http_proxy', ':0'], { allowFail: true, timeoutMs: 15_000 });
      if (cleared.code === 0) {
        this.mutateStore((store) => { store.pendingClear = store.pendingClear.filter((x) => x !== d.id); });
      }
      this.applied.delete(d.id);
      this.invalidateDevices();
      return;
    }

    const proxyId = this.data.attachments[d.id];
    if (!proxyId) return;
    const stored = this.data.proxies.find((x) => x.id === proxyId);
    if (!stored) return;
    try {
      await this.applyToRunningDevice(d, { ...stored });
    } catch (e) {
      const msg = redactProxySecrets((e as Error)?.message ?? String(e), [stored.password]);
      this.applied.set(d.id, { proxyId: stored.id, port: 0, serial, error: msg });
    }
    this.invalidateDevices();
  }

  /** Reconcile any newly running/reconnected Android devices discovered in inventory updates. */
  async reconcileAll(devices: readonly Device[]): Promise<void> {
    this.loadIfChanged();
    for (const d of devices) {
      if (!isProxySupportedBackend(d.backend)) continue;
      if (d.state !== 'running') {
        if (this.applied.has(d.id)) await this.onDeviceStopped(d.id);
        continue;
      }
      const serial = serialOf(d);
      if (!serial || this.reconciling.has(d.id)) continue;
      const needsClear = this.data.pendingClear.includes(d.id);
      const wantId = this.data.attachments[d.id];
      const rt = this.applied.get(d.id);
      const alreadyApplied = Boolean(wantId && rt && rt.proxyId === wantId && rt.serial === serial && rt.port > 0 && !rt.error);
      if (!needsClear && (!wantId || alreadyApplied)) continue;

      this.reconciling.add(d.id);
      try {
        await this.reapplyDevice(d);
      } finally {
        this.reconciling.delete(d.id);
      }
    }
  }

  /** Clean up persisted attachment and forwarder refcount AFTER a device is deleted. */
  async onDeviceDeleted(deviceId: string): Promise<void> {
    this.loadIfChanged();
    const proxyId = this.data.attachments[deviceId];
    const hadPending = this.data.pendingClear.includes(deviceId);
    if (proxyId || hadPending) {
      this.mutateStore((store) => {
        delete store.attachments[deviceId];
        store.pendingClear = store.pendingClear.filter((x) => x !== deviceId);
      });
    }
    this.applied.delete(deviceId);
    if (proxyId) await this.releaseForwarderDevice(proxyId, deviceId);
  }

  /** Clean up forwarder refcount AFTER a device stops (keeps persisted attachment for next boot). */
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
    this.startingForwarders.clear();
    this.applied.clear();
    await Promise.all(entries.map((e) => e.fw.close().catch(() => undefined)));
  }

  private async ensureForwarder(stored: SavedProxyStored, deviceId: string): Promise<number> {
    const snap = snapshotEndpoint(stored);
    const key = configKeyOf(snap);
    const existing = this.forwarders.get(stored.id);
    if (existing && existing.configKey === key) {
      existing.devices.add(deviceId);
      return existing.fw.port;
    }

    // Coalesce concurrent first attachments to one single-flight forwarder startup.
    let pending = this.startingForwarders.get(stored.id);
    if (!pending) {
      pending = (async () => {
        const fw = await this.startForwarder(snap);
        const entry: ForwarderEntry = { proxyId: stored.id, configKey: key, fw, devices: new Set() };
        const prev = this.forwarders.get(stored.id);
        this.forwarders.set(stored.id, entry);
        if (prev && prev !== entry) await prev.fw.close().catch(() => undefined);
        return entry;
      })();
      this.startingForwarders.set(stored.id, pending);
      pending.finally(() => {
        if (this.startingForwarders.get(stored.id) === pending) this.startingForwarders.delete(stored.id);
      });
    }
    const entry = await pending;
    if (entry.configKey !== key) {
      // Config rotated while waiting; retry against the new config.
      return this.ensureForwarder(stored, deviceId);
    }
    entry.devices.add(deviceId);
    return entry.fw.port;
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
    oldRemoteSpecToRemove?: string,
  ): Promise<void> {
    const serial = serialOf(d);
    if (!serial) {
      throw new PhoneDockError('Android device is running but its adb serial is unavailable', 'proxy_apply_failed', 503);
    }
    const port = await this.ensureForwarder(stored, d.id);
    const loopbackSpec = `tcp:127.0.0.1:${port}`;
    const legacySpec = `tcp:${port}`;

    // Prefer explicit loopback remote spec (prevents Android 17 adbd from binding INADDR_ANY); fall back on older adbd.
    let remoteSpec = loopbackSpec;
    let rev = await this.runAdb(serial, ['reverse', loopbackSpec, legacySpec], { allowFail: true, timeoutMs: 15_000 });
    if (rev.code !== 0) {
      remoteSpec = legacySpec;
      rev = await this.runAdb(serial, ['reverse', legacySpec, legacySpec], { allowFail: true, timeoutMs: 15_000 });
    }
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
      await this.runAdb(serial, ['reverse', '--remove', remoteSpec], { allowFail: true, timeoutMs: 10_000 });
      await this.releaseForwarderDevice(stored.id, d.id);
      throw new PhoneDockError(
        'Couldn’t apply the HTTP proxy setting on the Android device',
        'proxy_apply_failed',
        502,
        ['Some vendor Android builds restrict global settings writes over adb.'],
        redactProxySecrets((set.stderr || set.stdout).trim(), [stored.password]),
      );
    }

    if (oldRemoteSpecToRemove && oldRemoteSpecToRemove !== remoteSpec) {
      await this.runAdb(serial, ['reverse', '--remove', oldRemoteSpecToRemove], { allowFail: true, timeoutMs: 10_000 });
    }
    this.applied.set(d.id, { proxyId: stored.id, port, remoteSpec, serial });
  }
}

// ── Daemon singleton wiring ─────────────────────────────────────────────────
let singleton: ProxyManager | undefined;

export function initProxies(deps: {
  emitEvent: (event: string, data: unknown) => void;
  logAction: (deviceId: string, owner: string, action: unknown) => void;
  invalidateDevices: () => void;
  getDevices: () => Promise<Device[]>;
  assertCanMutateDevice?: (deviceId: string, owner: string) => void;
}): ProxyManager {
  singleton = new ProxyManager(deps);
  return singleton;
}

export function proxyManager(): ProxyManager {
  if (!singleton) singleton = new ProxyManager();
  return singleton;
}
