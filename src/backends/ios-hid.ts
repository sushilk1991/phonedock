// iOS 27+ native input for real iPhones: no WebDriverAgent, no root, works over Wi-Fi.
// One persistent `tools/pd-ios-hid.py` sidecar per device holds Apple's CoreDevice tunnel + a display media stream
// open (iOS only honours injected touches while a stream runs). Opening costs ~1.7 s once; each gesture ~50 ms after.
// The sidecar quits after IDLE_MS without use: frees the camera/mic and lets Device Hub / iPhone Mirroring stream.
// It keeps the stream alive with RTCP and reopens it (~0.85 s) if the phone reaped it or another client took over.
// The same stream is the phone's live screen: with a video sink (hidVideoStart, used by ios-video.ts) the sidecar
// writes its HEVC access units to fd 3 and stays up while someone watches.
// Verified on an iPhone 16 Pro Max, iOS 27.0, Wi-Fi paired (2026-11-03).
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { which } from '../core/paths.ts';
import { PhoneDockError } from '../core/types.ts';

// Short: while our stream is open iOS treats the phone as "observed remotely" (camera/mic blocked).
const IDLE_MS = Number(process.env.PHONEDOCK_IOS_HID_IDLE_MS ?? 45_000);
const READY_TIMEOUT_MS = 25_000;
const HID_MAX = 65535;

const READY_HINTS = [
  'iPhone on iOS 27 or later, unlocked, with Settings › Privacy & Security › Developer Mode on',
  'Settings › Developer › Enable UI Automation must be on',
  'Close Xcode Device Hub / iPhone Mirroring for this phone if they are showing its screen (one screen stream at a time)',
  'The phone must be paired with this Mac (devicectl list devices shows it as paired)',
];

export function hidScript(): string | undefined {
  const cands = [
    process.env.PHONEDOCK_IOS_HID_SRC,
    resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'pd-ios-hid.py'),
    resolve(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'pd-ios-hid.py'), // bundle: Resources/{daemon,tools}
    resolve(process.cwd(), 'tools', 'pd-ios-hid.py'),
  ];
  return cands.find((c) => c && existsSync(c));
}

let pyCache: string | null | undefined;
/** The python of the installed pymobiledevice3 (uv/pipx venv), read from its launcher's shebang. */
export function pymd3Python(): string | undefined {
  if (process.env.PHONEDOCK_PYMD3_PYTHON) return process.env.PHONEDOCK_PYMD3_PYTHON;
  if (pyCache !== undefined) return pyCache ?? undefined;
  pyCache = null;
  const bin = which('pymobiledevice3');
  if (bin) {
    try {
      const first = readFileSync(bin, 'utf8').slice(0, 300).split('\n')[0];
      const m = /^#!\s*(\S+)/.exec(first);
      if (m && existsSync(m[1])) pyCache = m[1];
    } catch { /* unreadable launcher */ }
  }
  return pyCache ?? undefined;
}

export function iosMajor(v?: string): number { return Number.parseInt(String(v ?? '').split('.')[0], 10) || 0; }
export function isNativeInputCapable(osVersion?: string): boolean {
  return iosMajor(osVersion) >= 27 && !!hidScript() && !!pymd3Python();
}

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

/** Receives the sidecar's video channel: raw records (see tools/pd-ios-hid.py, "Video fd records"). */
export interface HidVideoSink {
  onData(chunk: Buffer): void;
  /** The sidecar exited (idle, crash, phone gone) or video was switched off by another sink. */
  onClose(err?: Error): void;
}

class HidChannel {
  udid: string;
  proc: ChildProcess;
  ready: Promise<void>;
  pending = new Map<number, Pending>();
  nextId = 1;
  buf = '';
  stderr = '';
  idle?: NodeJS.Timeout;
  dead = false;
  queue: Promise<unknown> = Promise.resolve();
  lastInput = 0;   // never: a sidecar started for a viewer quits as soon as the last viewer leaves
  video?: HidVideoSink;

  /** noSteal: spawned for a viewer, so don't take the screen stream from Xcode / iPhone Mirroring at start-up. */
  constructor(udid: string, opts: { noSteal?: boolean } = {}) {
    this.udid = udid;
    const py = pymd3Python(); const script = hidScript();
    if (!py || !script) {
      throw new PhoneDockError('iPhone input is unavailable', 'ios_native_unavailable', 501, undefined,
        'Native iPhone input needs pymobiledevice3 ≥ 11.49 and tools/pd-ios-hid.py. Install: uv tool install pymobiledevice3. Or set PHONEDOCK_PYMD3_PYTHON / PHONEDOCK_IOS_HID_SRC.');
    }
    // fd 3: the binary video channel (HEVC access units); stdout stays JSON lines
    this.proc = spawn(py, ['-I', '-u', script, '--udid', udid, '--video-fd', '3', ...(opts.noSteal ? ['--no-steal'] : [])],
      { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    let readyOk!: () => void; let readyFail!: (e: Error) => void;
    this.ready = new Promise<void>((res, rej) => { readyOk = res; readyFail = rej; });
    this.ready.catch(() => { /* surfaced via send() */ });
    const readyTimer = setTimeout(() => readyFail(this.err(`iPhone input session did not open within ${READY_TIMEOUT_MS / 1000}s`)), READY_TIMEOUT_MS);
    this.proc.stdout!.setEncoding('utf8');
    this.proc.stdout!.on('data', (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        let m: any; try { m = JSON.parse(line); } catch { continue; }
        if (m.event === 'ready') { clearTimeout(readyTimer); readyOk(); continue; }
        if (m.event === 'failed') { clearTimeout(readyTimer); readyFail(m.code === 'stream_busy' ? busyError(m.error) : this.err(m.error)); continue; }
        const p = this.pending.get(m.id); if (!p) continue;
        this.pending.delete(m.id); clearTimeout(p.timer);
        if (m.ok) p.resolve(m); else p.reject(m.code === 'stream_busy' ? busyError(m.error) : this.err(m.error, !m.fatal));
      }
    });
    const vid = this.proc.stdio[3] as NodeJS.ReadableStream | null;
    vid?.on('data', (d: Buffer) => this.video?.onData(d));
    vid?.on('error', () => { /* the exit handler reports it */ });
    this.proc.stderr!.setEncoding('utf8');
    this.proc.stderr!.on('data', (d: string) => { this.stderr = (this.stderr + d).slice(-4000); });
    this.proc.on('exit', (code) => {
      this.dead = true; clearTimeout(readyTimer);
      const e = this.err(`iPhone input session ended (exit ${code})`);
      readyFail(e);
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); }
      this.pending.clear();
      if (channels.get(udid) === this) channels.delete(udid);
      const v = this.video; this.video = undefined; v?.onClose(e);
    });
  }

  err(msg: string, bad = false): PhoneDockError {
    const tail = this.stderr.trim().split('\n').filter((l) => /error|exception|denied|not found|unavailable/i.test(l)).slice(-2);
    return bad
      ? new PhoneDockError('The iPhone input request is invalid', 'bad_request', 400, undefined, msg)
      : new PhoneDockError('iPhone input failed', 'ios_native_input_failed', 502,
        ['Unlock the phone and enable Developer Mode and UI Automation.', 'Close other apps showing the phone screen.'],
        [msg, ...tail, ...READY_HINTS].join('\n'));
  }

  /** Commands are serialised: a drag must finish before the next tap starts. `input: false` for video commands, which
   *  don't count as use for the idle timeout. */
  send(cmd: Record<string, unknown>, timeoutMs = 20_000, input = true): Promise<any> {
    const run = async () => {
      await this.ready;
      if (this.dead) throw this.err('iPhone input session is not running');
      if (input) this.lastInput = Date.now();
      this.touch();
      const id = this.nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.pending.delete(id); reject(this.err(`iPhone did not acknowledge "${cmd.cmd}" within ${timeoutMs / 1000}s`)); this.close(); }, timeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        this.proc.stdin!.write(JSON.stringify({ id, ...cmd }) + '\n');
      });
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** Quit IDLE_MS after the last input, but never while a viewer is watching: then once the last viewer left (and
   *  the input timeout has passed too), so the phone stops being "observed remotely" right away. */
  touch(): void {
    if (this.idle) clearTimeout(this.idle);
    const left = Math.max(0, this.lastInput + IDLE_MS - Date.now());
    this.idle = setTimeout(() => { if (this.video) this.touch(); else this.close(); }, this.video ? Math.max(left, 5_000) : left);
    this.idle.unref?.();
  }

  close(): void {
    if (this.dead) return;
    this.dead = true;
    try { this.proc.stdin!.write(JSON.stringify({ cmd: 'quit' }) + '\n'); } catch { /* pipe gone */ }
    const p = this.proc; setTimeout(() => { if (p.exitCode === null) p.kill('SIGTERM'); }, 1500).unref?.();
    if (channels.get(this.udid) === this) channels.delete(this.udid);
  }
}

function busyError(detail?: string): PhoneDockError {
  return new PhoneDockError('Another app is showing this iPhone’s screen', 'stream_busy', 409,
    ['Close Xcode Device Hub or iPhone Mirroring for this phone to see it live here.'],
    detail ?? 'Another client is streaming this iPhone’s screen (one screen stream per phone)');
}

const channels = new Map<string, HidChannel>();

function channel(udid: string, opts: { noSteal?: boolean } = {}): HidChannel {
  let c = channels.get(udid);
  if (!c || c.dead) { c = new HidChannel(udid, opts); channels.set(udid, c); }
  return c;
}

/** Live video for one phone: the sidecar writes HEVC access units for `sink` until the returned stop() (or until the
 *  sidecar exits: sink.onClose). One sink per phone (src/backends/ios-video.ts fans out). `steal: false` refuses with
 *  code stream_busy while another client (Xcode Device Hub, iPhone Mirroring, another PhoneDock) streams the phone. */
export async function hidVideoStart(udid: string, sink: HidVideoSink, opts: { steal?: boolean } = {}): Promise<() => void> {
  const c = channel(udid, { noSteal: opts.steal === false });
  const prev = c.video;
  c.video = sink;
  if (prev && prev !== sink) prev.onClose();
  try {
    await c.send({ cmd: 'video', on: true, steal: opts.steal !== false }, 20_000, false);
  } catch (e) {
    if (c.video === sink) c.video = undefined;
    throw e;
  }
  c.touch();
  let stopped = false;
  return () => {
    if (stopped) return; stopped = true;
    if (c.video !== sink) return;
    c.video = undefined;
    if (c.dead) return;
    if (Date.now() - c.lastInput >= IDLE_MS) { c.close(); return; }   // nobody typed for a while: free the phone now
    c.send({ cmd: 'video', on: false }, 10_000, false).catch(() => undefined);
    c.touch();
  };
}
/** Ask the phone for a fresh key frame (the sidecar rate-limits it). No-op without a running sidecar. */
export function hidKeyframe(udid: string): void {
  const c = channels.get(udid);
  if (c && !c.dead && c.video) c.send({ cmd: 'keyframe' }, 10_000, false).catch(() => undefined);
}
/** Stream health and video counters, for diagnostics (undefined when no sidecar runs). */
export async function hidStatus(udid: string): Promise<any> {
  const c = channels.get(udid);
  if (!c || c.dead) return undefined;
  return c.send({ cmd: 'status' }, 10_000, false);
}

/** Screen geometry in screenshot pixels, used to normalise to the HID range. */
export type Geometry = () => Promise<{ width: number; height: number }>;

function norm(v: number, size: number): number { return Math.max(0, Math.min(HID_MAX, Math.round((v / Math.max(1, size)) * HID_MAX))); }

export async function hidTap(udid: string, geo: Geometry, x: number, y: number): Promise<void> {
  const g = await geo(); await channel(udid).send({ cmd: 'tap', x: norm(x, g.width), y: norm(y, g.height) });
}
export async function hidDoubleTap(udid: string, geo: Geometry, x: number, y: number): Promise<void> {
  const g = await geo(); await channel(udid).send({ cmd: 'double_tap', x: norm(x, g.width), y: norm(y, g.height) });
}
export async function hidLongPress(udid: string, geo: Geometry, x: number, y: number, ms: number): Promise<void> {
  const g = await geo(); await channel(udid).send({ cmd: 'hold', x: norm(x, g.width), y: norm(y, g.height), ms }, 20_000 + ms);
}
export async function hidSwipe(udid: string, geo: Geometry, x1: number, y1: number, x2: number, y2: number, ms: number): Promise<void> {
  const g = await geo();
  await channel(udid).send({ cmd: 'drag', x1: norm(x1, g.width), y1: norm(y1, g.height), x2: norm(x2, g.width), y2: norm(y2, g.height), ms }, 20_000 + ms);
}
/** True when the text can be typed key-by-key on the virtual HID keyboard (printable ASCII, newline, tab). */
export function hidTypable(text: string): boolean { return !/[^\x20-\x7e\n\t]/.test(text); }
export async function hidType(udid: string, text: string): Promise<void> {
  if (!hidTypable(text)) {
    throw new PhoneDockError('Native iPhone key typing supports ASCII only', 'not_supported', 400,
      ['Use the device pasteboard for other text.']);
  }
  await channel(udid).send({ cmd: 'type', text }, 20_000 + text.length * 120);
}
/** Modifier chord on the virtual keyboard, e.g. hidCombo(udid, ['cmd'], 'v') to paste. */
export async function hidCombo(udid: string, mods: string[], key: string): Promise<void> {
  await channel(udid).send({ cmd: 'combo', mods, key });
}
const HID_KEYS = new Set(['enter', 'return', 'delete', 'backspace', 'tab', 'escape', 'esc', 'space', 'up', 'down', 'left', 'right']);
const HID_BUTTONS = new Set(['home', 'lock', 'power', 'volume_up', 'volume_down', 'mute', 'siri']);
/** Returns false if the key isn't a keyboard key or hardware button (caller handles e.g. "back"). */
export async function hidKey(udid: string, key: string): Promise<boolean> {
  const k = key.toLowerCase();
  if (HID_BUTTONS.has(k)) { await channel(udid).send({ cmd: 'button', name: k }); return true; }
  if (HID_KEYS.has(k)) { await channel(udid).send({ cmd: 'key', name: k }); return true; }
  return false;
}
/** Open the session ahead of the first gesture (e.g. when the app selects the device). */
export async function hidWarm(udid: string): Promise<void> { await channel(udid).send({ cmd: 'ping' }); }
export function hidClose(udid: string): void { channels.get(udid)?.close(); }
process.once('exit', () => { for (const c of channels.values()) c.close(); });
