// iOS 27+ native control for real iPhones: no WebDriverAgent, no Xcode build, no root, USB or Wi-Fi.
// One long-lived `tools/pd-ios-native.py` sidecar per device (JSON lines over stdio) holds Apple's CoreDevice tunnel
// (borrowed from remoted via remotepairingd; userspace tunnels as fallback) and the iOS 27 remote-accessibility
// session. This module covers observation and app control: status, screenshot, UI tree, apps, launch/terminate,
// URLs, rotation, clipboard, appearance and Wi-Fi pairing. Touch/keyboard input lives in ios-hid.ts
// (pd-ios-hid.py); the sidecar's own input commands stay reachable through `request()` but are UNTESTED on hardware.
// Verified read-only on an iPhone 16 Pro Max (iPhone17,2), iOS 27.0, Wi-Fi paired, 2026-11-03: connect ~1.6 s,
// status ~0.2 s, screenshot 0.35-0.8 s (PNG size dependent), apps ~0.2 s, uiTree ~1.1-1.7 s fresh.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { which } from '../core/paths.ts';
import { PhoneDockError, type AppInfo, type UiElement, type UiTree } from '../core/types.ts';

const IDLE_MS = Number(process.env.PHONEDOCK_IOS_NATIVE_IDLE_MS ?? 10 * 60_000);
const READY_TIMEOUT_MS = 20_000;
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES = 3;

export type NativeTransport = 'auto' | 'usb' | 'wifi' | 'native';

/** Sidecar error codes → HTTP-ish status for PhoneDockError. */
const STATUS: Record<string, number> = {
  bad_request: 400, unknown_command: 400, not_supported: 501, no_device: 404, not_found: 404, not_paired: 409,
  developer_mode_off: 409, ui_automation_off: 409, ios_too_old: 409, ddi_missing: 409, stream_busy: 409,
  stream_failed: 502, busy: 409, locked: 423, local_network_denied: 403, device_timeout: 504, pair_timeout: 408,
  pair_failed: 502, connection_lost: 502, usbmuxd_unavailable: 503, sidecar_crashed: 502, sidecar_unavailable: 503,
  cancelled: 503, internal: 500,
};

/** Per-command timeouts (ms); the sidecar applies its own device timeouts inside these. */
function timeoutFor(cmd: string, args: Record<string, unknown>): number {
  switch (cmd) {
    case 'connect': case 'mount_ddi': return 300_000;   // first DDI mount downloads + signs
    case 'pair_wifi': return (Number(args.timeoutSec ?? 180) + 20) * 1000;
    case 'type': return 15_000 + 80 * String(args.text ?? '').length;
    case 'ui': return (Number(args.timeoutSec ?? 6) + 20) * 1000;
    case 'apps': case 'launch': case 'terminate': case 'open_url': return 60_000;
    case 'long_press': case 'swipe': case 'pinch': return 15_000 + Number(args.ms ?? 0);
    case 'ping': return 5_000;
    default: return 30_000;
  }
}
const READ_ONLY = new Set(['ping', 'status', 'devices', 'screenshot', 'apps', 'ui', 'clipboard_get']);

// ── discovery ──────────────────────────────────────────────────────────────

let pyCache: string | null | undefined;
/** The python of the installed pymobiledevice3 (uv/pipx venv), from its launcher's shebang.
 *  `PHONEDOCK_PYMD3_PYTHON` overrides. Handles the `#!/bin/sh` + `'''exec' <python>` trampoline of long paths. */
export function nativePython(): string | undefined {
  if (process.env.PHONEDOCK_PYMD3_PYTHON) return process.env.PHONEDOCK_PYMD3_PYTHON;
  if (pyCache !== undefined) return pyCache ?? undefined;
  pyCache = null;
  const cands: string[] = [];
  const bin = which('pymobiledevice3');
  if (bin) {
    try {
      const head = readFileSync(bin, 'utf8').slice(0, 600).split('\n');
      const m = /^#!\s*(\S+)/.exec(head[0] ?? '');
      if (m && !/\/(ba|z)?sh$/.test(m[1])) cands.push(m[1]);
      const tramp = /^'''exec'\s+'?([^'\s]+)'?/.exec(head[1] ?? '');
      if (tramp) cands.push(tramp[1]);
    } catch { /* unreadable launcher */ }
  }
  const home = process.env.HOME ?? '';
  cands.push(join(home, '.local/share/uv/tools/pymobiledevice3/bin/python'), join(home, '.local/pipx/venvs/pymobiledevice3/bin/python'));
  pyCache = cands.find((c) => existsSync(c)) ?? null;
  return pyCache ?? undefined;
}

export function nativeSidecarScript(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const cands = [
    process.env.PHONEDOCK_IOS_NATIVE_SIDECAR,
    resolve(here, '..', '..', 'tools', 'pd-ios-native.py'),
    resolve(here, '..', 'tools', 'pd-ios-native.py'), // app bundle: Resources/{daemon,tools}
    resolve(process.cwd(), 'tools', 'pd-ios-native.py'),
  ];
  return cands.find((c) => c && existsSync(c));
}

function major(v?: string): number { return Number.parseInt(String(v ?? '').split('.')[0], 10) || 0; }
/** iOS 27+ can be driven without WDA (needs the sidecar and pymobiledevice3 ≥ 11.49 on this Mac). */
export function isNativeCapable(iosVersion?: string): boolean {
  return major(iosVersion) >= 27 && !!nativeSidecarScript() && !!nativePython();
}

// ── sidecar process ────────────────────────────────────────────────────────

interface Pending {
  cmd: string;
  child: ChildProcess;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  onEvent?: (ev: Record<string, any>) => void;
}

export interface RequestOptions {
  timeoutMs?: number;
  onEvent?: (ev: Record<string, any>) => void;   // progress / pair_code / reconnecting events for this request
}

function toError(err: any, cmd: string): PhoneDockError {
  const code = typeof err?.code === 'string' ? err.code : 'internal';
  return new PhoneDockError('The iPhone action failed', code, STATUS[code] ?? 502, undefined,
    JSON.stringify({ command: cmd, message: err?.message, hints: err?.hints, details: err?.details }));
}

class NativeSidecar {
  readonly key: string;
  private readonly argv: string[];
  private child?: ChildProcess;
  private starting?: Promise<void>;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private idle?: NodeJS.Timeout;
  private stderrTail: string[] = [];
  private crashes: number[] = [];
  private closed = false;
  info: Record<string, any> = {};

  constructor(key: string, argv: string[]) {
    this.key = key;
    this.argv = argv;
  }

  private start(): Promise<void> {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.starting ?? Promise.resolve();
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < CRASH_WINDOW_MS);
    if (this.crashes.length >= MAX_CRASHES) {
      return Promise.reject(new PhoneDockError("iPhone control stopped unexpectedly", 'sidecar_crashed', 502, ["Try again shortly."], [`iOS native sidecar crashed ${this.crashes.length}× in a minute; not restarting yet`, ...(( this.tail() ? [`last stderr: ${this.tail()}`] : undefined ) ?? [])].filter(Boolean).join('\n')));
    }
    const py = nativePython();
    const script = nativeSidecarScript();
    if (!py || !script) {
      return Promise.reject(new PhoneDockError("iPhone control is unavailable", 'sidecar_unavailable', 503, ["Install pymobiledevice3."], ['iOS native control needs pymobiledevice3 (≥ 11.49) and tools/pd-ios-native.py', ...['Install: uv tool install pymobiledevice3 (or pipx install pymobiledevice3)', 'Or set PHONEDOCK_PYMD3_PYTHON to its python']].filter(Boolean).join('\n')));
    }
    this.stderrTail = [];
    const child = spawn(py, ['-I', '-u', script, ...this.argv], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.hold(true);   // keep the event loop alive until ready; afterwards only while requests are pending
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (d: string) => {
      for (const line of d.split('\n')) if (line.trim()) this.stderrTail.push(line.slice(0, 400));
      if (this.stderrTail.length > 30) this.stderrTail.splice(0, this.stderrTail.length - 30);
    });
    child.stdin!.on('error', () => { /* EPIPE after a crash: surfaced via 'exit' */ });
    this.starting = new Promise<void>((res, rej) => {
      const timer = setTimeout(() => { rej(new PhoneDockError("iPhone control did not start in time", 'sidecar_unavailable', 503, undefined, ['iOS native sidecar did not start in time', ...(( this.tail() ? [this.tail()] : undefined ) ?? [])].filter(Boolean).join('\n'))); child.kill('SIGKILL'); }, READY_TIMEOUT_MS);
      timer.unref();
      const onReady = (ev: Record<string, any>) => { clearTimeout(timer); this.info = ev; this.hold(this.pending.size > 0); res(); };
      let buf = '';   // per child: a late line from a killed predecessor must not mix into the next one
      child.stdout!.on('data', (d: string) => { buf = this.onData(buf + d, onReady); });
      child.once('exit', (code, sig) => {
        clearTimeout(timer);
        this.onExit(child, code, sig);
        rej(new PhoneDockError("iPhone control stopped while starting", 'sidecar_crashed', 502, undefined, [`iOS native sidecar exited during start (${sig ?? code})`, ...(( this.tail() ? [this.tail()] : undefined ) ?? [])].filter(Boolean).join('\n')));
      });
      child.once('error', (e) => { clearTimeout(timer); rej(new PhoneDockError("Couldn’t start iPhone control", 'sidecar_unavailable', 503, undefined, `cannot start the iOS native sidecar: ${e.message}`)); });
    });
    this.starting.catch(() => { /* reported to the caller */ });
    return this.starting;
  }

  private tail(): string { return this.stderrTail.slice(-3).join(' | '); }

  /** ref() the child + pipes while work is pending, unref() when idle, so an idle sidecar never pins the process. */
  private hold(on: boolean): void {
    const c = this.child;
    if (!c) return;
    for (const h of [c, c.stdin, c.stdout, c.stderr] as any[]) { if (on) h?.ref?.(); else h?.unref?.(); }
  }

  /** Handles complete lines; returns the unterminated remainder. */
  private onData(data: string, onReady: (ev: Record<string, any>) => void): string {
    let rest = data;
    let nl: number;
    while ((nl = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, nl).trim();
      rest = rest.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { this.stderrTail.push(`non-JSON stdout: ${line.slice(0, 200)}`); continue; }
      if (msg.event) {
        if (msg.event === 'ready') onReady(msg);
        else if (typeof msg.id === 'number') this.pending.get(msg.id)?.onEvent?.(msg);
        continue;
      }
      const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
      if (!p) continue;   // id null = bad request line we never sent
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(toError(msg.error, p.cmd));
    }
    if (rest.length > 64 * 1024 * 1024) { this.stderrTail.push('stdout line over 64 MiB dropped'); return ''; }
    return rest;
  }

  private onExit(child: ChildProcess, code: number | null, sig: NodeJS.Signals | null): void {
    const deliberate = this.closed || (child as any).pdKilled === true;
    if (this.child === child) { this.child = undefined; this.starting = undefined; }
    if (!deliberate && code !== 0) this.crashes.push(Date.now());
    const err = new PhoneDockError("iPhone control stopped unexpectedly", 'sidecar_crashed', 502, undefined, [`iOS native sidecar exited (${sig ?? code})`, ...(( this.tail() ? [`stderr: ${this.tail()}`] : undefined ) ?? [])].filter(Boolean).join('\n'));
    for (const [id, p] of this.pending) {
      if (p.child !== child) continue;
      clearTimeout(p.timer); p.reject(err); this.pending.delete(id);
    }
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => { if (this.pending.size === 0) this.stop(); else this.touch(); }, IDLE_MS);
    this.idle.unref();
  }

  async request<T = any>(cmd: string, args: Record<string, unknown> = {}, opts: RequestOptions = {}, retried = false): Promise<T> {
    this.closed = false;
    await this.start();
    this.touch();
    const id = this.nextId++;
    const child = this.child!;
    const timeoutMs = opts.timeoutMs ?? timeoutFor(cmd, args);
    try {
      return await new Promise<T>((res, rej) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          rej(new PhoneDockError("The iPhone action timed out", 'device_timeout', 504, ["Keep the iPhone awake and unlocked.","Try again."], [`iOS native sidecar: ${cmd} timed out after ${Math.round(timeoutMs / 1000)} s`, ...['Keep the iPhone awake and unlocked', 'The sidecar was restarted; retry']].filter(Boolean).join('\n')));
          this.kill();   // a wedged sidecar holds the tunnel; start clean next time
        }, timeoutMs);
        timer.unref();
        this.pending.set(id, { cmd, child, resolve: res, reject: rej, timer, onEvent: opts.onEvent });
        this.hold(true);
        child.stdin!.write(JSON.stringify({ id, cmd, args }) + '\n');
      }).finally(() => { if (this.child === child) this.hold(this.pending.size > 0); });
    } catch (e) {
      if (!retried && READ_ONLY.has(cmd) && e instanceof PhoneDockError && e.code === 'sidecar_crashed') {
        return this.request<T>(cmd, args, opts, true);
      }
      throw e;
    }
  }

  private kill(): void {
    const c = this.child;
    if (c && c.exitCode === null) { (c as any).pdKilled = true; c.kill('SIGKILL'); }
    if (this.child === c) { this.child = undefined; this.starting = undefined; }   // next request starts fresh
  }

  /** Graceful stop: the sidecar releases the tunnel assertion and any screen stream. */
  stop(): void {
    this.closed = true;
    if (this.idle) clearTimeout(this.idle);
    const c = this.child;
    if (!c || c.exitCode !== null) return;
    (c as any).pdKilled = true;
    this.child = undefined;   // detach: a later request starts a fresh sidecar instead of writing to this one
    this.starting = undefined;
    try { c.stdin!.write(JSON.stringify({ id: this.nextId++, cmd: 'shutdown', args: {} }) + '\n'); c.stdin!.end(); } catch { /* gone */ }
    const t = setTimeout(() => { if (c.exitCode === null) c.kill('SIGKILL'); }, 5_000);
    t.unref();
  }

  killNow(): void { this.closed = true; this.kill(); }
}

const sidecars = new Map<string, NativeSidecar>();
let exitHook = false;
function sidecarFor(key: string, argv: string[]): NativeSidecar {
  let s = sidecars.get(key);
  if (!s) {
    s = new NativeSidecar(key, argv);
    sidecars.set(key, s);
    if (!exitHook) { exitHook = true; process.once('exit', () => { for (const sc of sidecars.values()) sc.killNow(); }); }
  }
  return s;
}

// ── session API ────────────────────────────────────────────────────────────

export interface NativeStatus {
  udid: string;
  name?: string;
  model?: string;
  iosVersion?: string;
  buildVersion?: string;
  connection?: 'usb' | 'wifi' | null;
  via?: 'remoted' | 'usbmux-usb' | 'usbmux-network' | 'remotepairing' | 'fake' | null;
  developerMode?: boolean | null;
  ddiMounted?: boolean;
  inputAvailable?: boolean;
  inputReady?: boolean;
  locked?: boolean | null;
  screenOn?: boolean | null;
  orientation?: string | null;
  screen?: { width: number; height: number; scale?: number } | null;
  uiTree?: { available: boolean; open: boolean; generation: number | null };
  services?: Record<string, boolean>;
  [k: string]: unknown;
}

export interface NativeUiElement {
  type: string;
  label: string | null;
  value: string | null;
  hint: string | null;
  id: string | null;
  traits: string[];
  enabled: boolean;
  selected: boolean;
  clickable: boolean;
  checked?: boolean;
  bounds: { x: number; y: number; width: number; height: number };   // screenshot pixels, clipped to the screen
  frame: { x: number; y: number; width: number; height: number };    // points, as the phone reported (after host offset)
  pid: number | null;
  remote?: boolean;
  offscreen?: boolean;
}

export interface NativeUiResult {
  source: 'accessibility';
  app: { pid: number | null; label: string | null };
  elements: NativeUiElement[];
  offscreen: number;
  unplaced: number;
  truncated: boolean;
  generation: number;
  complete: boolean;
  ageMs: number;
  waitedMs: number;
  screen: { width: number; height: number; scale: number };
}

export interface UiOptions {
  maxAgeMs?: number;          // reuse a pushed tree this fresh (default 0: always ask the phone, ~1.1-1.7 s)
  timeoutSec?: number;        // wait for the dump (default 6)
  settleMs?: number;          // wait for the AdditionalData pass with identifiers/types (default 700)
  includeOffscreen?: boolean;
  maxElements?: number;
}

export interface NativeSession {
  readonly udid: string;
  request<T = any>(cmd: string, args?: Record<string, unknown>, opts?: RequestOptions): Promise<T>;
  connect(opts?: { transport?: NativeTransport; trustTimeoutSec?: number; mountDdi?: boolean }, onEvent?: RequestOptions['onEvent']): Promise<NativeStatus>;
  status(refresh?: boolean): Promise<NativeStatus>;
  screenshot(): Promise<Buffer>;
  ui(opts?: UiOptions): Promise<NativeUiResult>;
  uiTree(opts?: UiOptions): Promise<UiTree>;
  apps(includeSystem?: boolean): Promise<AppInfo[]>;
  launch(bundleId: string, opts?: { args?: string[]; env?: Record<string, string>; terminateExisting?: boolean }): Promise<{ pid?: number | null }>;
  terminate(bundleId: string): Promise<boolean>;
  openUrl(url: string, bundleId?: string): Promise<void>;
  rotate(orientation: 'portrait' | 'landscape' | 'landscapeLeft' | 'landscapeRight' | 'portraitUpsideDown'): Promise<string | null>;
  clipboardGet(): Promise<string | null>;
  clipboardSet(text: string): Promise<void>;
  appearance(style?: 'dark' | 'light'): Promise<string>;
  close(): void;
}

/** One sidecar per udid, started on demand, stopped after ~10 min idle (PHONEDOCK_IOS_NATIVE_IDLE_MS). */
export function nativeSession(udid: string, opts: { transport?: NativeTransport } = {}): NativeSession {
  if (!udid) throw new PhoneDockError('An iPhone identifier is required', 'bad_request', 400);
  const transport = opts.transport ?? (process.env.PHONEDOCK_IOS_NATIVE_TRANSPORT as NativeTransport | undefined) ?? 'auto';
  const sc = sidecarFor(`dev:${udid}`, ['--udid', udid, '--transport', transport]);
  const req = <T = any>(cmd: string, args: Record<string, unknown> = {}, o: RequestOptions = {}) => sc.request<T>(cmd, args, o);
  const session: NativeSession = {
    udid,
    request: req,
    connect: (o = {}, onEvent) => req<NativeStatus>('connect', { transport, ...o }, { onEvent }),
    status: (refresh = false) => req<NativeStatus>('status', { refresh }),
    async screenshot() {
      const dir = mkdtempSync(join(tmpdir(), 'pd-ios-native-'));
      const path = join(dir, 'shot.png');
      try {
        await req('screenshot', { path });
        return readFileSync(path);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
    ui: (o = {}) => req<NativeUiResult>('ui', { ...o }),
    async uiTree(o = {}) { return toUiTree(await req<NativeUiResult>('ui', { ...o })); },
    async apps(includeSystem = true) {
      const r = await req<{ apps: Array<{ bundleId: string; name?: string; version?: string; system?: boolean }> }>('apps', { includeSystem });
      return r.apps.filter((a) => a.bundleId).map((a) => ({ id: a.bundleId, name: a.name ?? undefined, version: a.version ?? undefined, system: a.system }));
    },
    launch: (bundleId, o = {}) => req('launch', { bundleId, args: o.args ?? [], env: o.env ?? {}, terminateExisting: o.terminateExisting ?? true }),
    async terminate(bundleId) { return !!(await req<{ terminated: boolean }>('terminate', { bundleId })).terminated; },
    async openUrl(url, bundleId) { await req('open_url', bundleId ? { url, bundleId } : { url }); },
    async rotate(orientation) { return (await req<{ orientation: string | null }>('rotate', { orientation })).orientation; },
    async clipboardGet() { return (await req<{ text: string | null }>('clipboard_get')).text; },
    async clipboardSet(text) { await req('clipboard_set', { text }); },
    async appearance(style) { return (await req<{ style: string }>('appearance', style ? { style } : {})).style; },
    close: () => { sc.stop(); sidecars.delete(sc.key); },
  };
  return session;
}

/** PhoneDock UiTree from the iOS 27 accessibility dump: root = the frontmost app, children = its elements in
 *  VoiceOver order (the phone reports a flat list), bounds in screenshot pixels. */
export function toUiTree(r: NativeUiResult): UiTree {
  const { width, height, scale } = r.screen;
  let n = 0;
  const children: UiElement[] = r.elements.map((e) => {
    const el: UiElement = { ref: '', type: e.type, bounds: e.bounds };
    if (e.label) { el.label = e.label; el.text = e.label; }
    if (e.value != null) { el.value = e.value; if (!el.text) el.text = e.value; }
    if (e.id) el.id = e.id;
    el.enabled = e.enabled;
    if (e.selected) el.selected = true;
    if (e.clickable) el.clickable = true;
    if (e.checked !== undefined) el.checked = e.checked;
    if (e.type === 'ScrollView' || e.type === 'Table' || e.type === 'CollectionView' || e.traits.includes('Causes Page Turn')) el.scrollable = true;
    return el;
  });
  const app: UiElement = { ref: '', type: 'Application', bounds: { x: 0, y: 0, width, height } };
  if (r.app.label) { app.label = r.app.label; app.text = r.app.label; }
  if (children.length) app.children = children;
  const renum = (els: UiElement[]) => { for (const e of els) { e.ref = `e${++n}`; if (e.children) renum(e.children); } };
  renum([app]);
  return { source: 'accessibility', screen: { width, height, scale }, root: [app], capturedAt: new Date(Date.now() - (r.ageMs ?? 0)).toISOString() };
}

/** Convenience for ios-device.ts: the UI tree of a real iPhone (iOS 27+) without WDA. */
export function nativeUiTree(udid: string, opts: UiOptions = {}): Promise<UiTree> {
  return nativeSession(udid).uiTree(opts);
}

// ── host-level helpers (no device) ─────────────────────────────────────────

export interface NativeDeviceListing {
  native: Array<{ udid: string; name?: string; model?: string; paired: boolean; connected: boolean; attachedPhysically?: boolean | null; authState?: string | null }>;
  usbmux: Array<{ udid: string; connection: 'usb' | 'wifi' }>;
  wifiPairings: Array<{ udid: string; name?: string; model?: string; path: string }>;
  nativeError?: string;
  usbmuxError?: string;
}

/** Phones this Mac can reach: remotepairingd (Xcode/devicectl pairings), usbmuxd, pair-host records. Local only. */
export function listNativeDevices(): Promise<NativeDeviceListing> {
  return sidecarFor('host', []).request<NativeDeviceListing>('devices', {}, { timeoutMs: 20_000 });
}

/** Pair an iPhone over Wi-Fi without a cable (iOS 27+): advertises this Mac; on the iPhone open
 *  Settings › Developer › Paired Macs and tap it, then enter the code passed to `onCode`. Sends mDNS on the LAN,
 *  so the calling process needs Local Network permission (run from PhoneDock.app). UNTESTED on hardware. */
export async function pairWifi(onCode: (code: string) => void,
  opts: { name?: string; timeoutSec?: number; fresh?: boolean; onEvent?: (ev: Record<string, any>) => void } = {}):
  Promise<{ udid: string; name?: string; model?: string; recordPath: string }> {
  const timeoutSec = opts.timeoutSec ?? 180;
  return sidecarFor('host', []).request('pair_wifi', { name: opts.name, timeoutSec, fresh: !!opts.fresh }, {
    onEvent: (ev) => { if (ev.event === 'pair_code' && typeof ev.code === 'string') onCode(ev.code); opts.onEvent?.(ev); },
  });
}

/** Checks python + pymobiledevice3 version without touching any device. */
export async function nativeAvailability(): Promise<{ ok: boolean; reason?: string; pymobiledevice3?: string }> {
  const py = nativePython();
  const script = nativeSidecarScript();
  if (!py) return { ok: false, reason: 'pymobiledevice3 not found (uv tool install pymobiledevice3)' };
  if (!script) return { ok: false, reason: 'tools/pd-ios-native.py not found' };
  return await new Promise((res) => {
    const c = spawn(py, ['-I', script, '--check'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    c.stdout!.setEncoding('utf8');
    c.stdout!.on('data', (d: string) => { out += d; });
    const t = setTimeout(() => c.kill('SIGKILL'), 15_000);
    c.on('close', () => {
      clearTimeout(t);
      try { const j = JSON.parse(out); res({ ok: !!j.ok, reason: j.error, pymobiledevice3: j.pymobiledevice3 ?? undefined }); }
      catch { res({ ok: false, reason: 'sidecar --check failed' }); }
    });
    c.on('error', (e) => { clearTimeout(t); res({ ok: false, reason: e.message }); });
  });
}

export function closeAllNativeSessions(): void {
  for (const s of sidecars.values()) s.stop();
  sidecars.clear();
}
