// Live screen of an Android device: one `screenrecord` per device sends H.264 straight from the device's encoder, and
// one ScreenSource per device shares it between
//  - the raw video viewers (Backend.video → GET /v1/devices/:id/video): the bytes go out as they came, the app decodes
//    them in hardware; nothing is decoded on the daemon's side,
//  - the JPEG frame streams (Backend.stream → /frame, /stream): ffmpeg decodes and encodes JPEGs, and only runs while
//    one of those is open.
//
// What the source does about screenrecord's habits:
//  - It encodes only when the screen changes, and its encoder may never send another key frame after the first (an
//    emulator sent none in 30 s of scrolling). A viewer that joins mid-stream replays the frames since the key frame
//    (GopCache, decode-only), and after the screen has been still for STILL_REFRESH_MS with many frames cached, a
//    second encoder starts and takes over at its first picture (make before break, no gap), so the cache is one key
//    frame again. Joining (and repairing a cut-short frame) stays cheap.
//  - Raw H.264 has no frame lengths: AccessUnitAssembler (src/core/video.ts) finds the pictures.
//  - It stops after 180 s unless `--time-limit 0` is accepted (Android 14+): older ones get a hand-over at 170 s.
//  - It can't start while the display is off ("INVALID_LAYER_STACK"): state `asleep`, retried until the wake (logcat
//    says "Waking up from"). It letterboxes after a rotation: restarted at the new size (the logcat watcher, or the
//    daemon's restart() after a rotate).
//  - If it never produces a picture (secure surfaces, no usable encoder), the JPEG streams fall back to screenshots
//    and the video viewers are ended with an error (the app then polls /frame).
import { spawn, type ChildProcess } from 'node:child_process';
import { sleep } from '../core/exec.ts';
import { toolEnv } from '../core/paths.ts';
import type { FrameStream, ScreenInfo, VideoPacket, VideoStream } from '../core/types.ts';
import { AccessUnitAssembler, h264NalInfo, joinNals, VideoFanout, type AccessUnit, type FramePacket, type VideoSink } from '../core/video.ts';
import { adb, adbPath, ffmpegPath, H264_AUD, knownScreenState, orientationOf, parseDisplayChange, pngSize, pngToJpeg, readScreen, screenshot, type ScreenState } from './android-common.ts';

const DEFAULT_MAX_SIZE = 720;
const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);
const clampSize = (n?: number) => Math.max(160, Math.min(n || DEFAULT_MAX_SIZE, 4096));
/** After the screen has been still this long… */
const STILL_REFRESH_MS = 1500;
/** …more frames (or bytes) than this since the key frame get replaced by a fresh key frame. */
const REFRESH_FRAMES = 60;
const REFRESH_BYTES = 1.5 * 1024 * 1024;
/** screenrecord without `--time-limit 0` stops at 180 s: a new one takes over before that. */
const LIMIT_HANDOVER_MS = 170_000;
/** How long the input must be quiet before the picture in progress counts as complete (see AccessUnitAssembler:
 *  split writes arrived up to ~10 ms apart on a loaded emulator; a later picture ends the one before at once). */
const IDLE_MS = 16;
/** A source that has shown nothing after this long (and isn't asleep or retrying) gives up. */
const NO_FRAME_MS = 10_000;

/** The encoded size for a screen: the longer side at most `maxSize`, both even. */
export function encodeSize(si: { width: number; height: number }, maxSize: number): { w: number; h: number } {
  const s = Math.max(si.width, si.height) / maxSize;
  const k = s > 1 ? s : 1;
  const even = (n: number) => Math.max(2, Math.round(n / k / 2) * 2);
  return { w: even(si.width), h: even(si.height) };
}
const bitRate = (w: number, h: number) => (Math.max(w, h) > 1000 ? '8000000' : '6000000');

/** screenrecord accepts `--time-limit 0` (no limit; Android 14+). Asked once per serial. */
const unlimitedBySerial = new Map<string, Promise<boolean>>();
const limitKnown = new Map<string, boolean>();
function noTimeLimit(serial: string): Promise<boolean> {
  let p = unlimitedBySerial.get(serial);
  if (!p) {
    p = adb(serial, ['shell', 'screenrecord --help 2>&1'], { allowFail: true, timeoutMs: 5000 }).then((r) => /Set to 0/i.test(r.stdout + r.stderr), () => false);
    p.then((v) => limitKnown.set(serial, v), () => undefined);
    unlimitedBySerial.set(serial, p);
  }
  return p;
}
/** A screen read this recently is trusted for a first start (and checked right after: a wrong guess costs one
 * restart, about what reading first would have cost). Screens rarely change size; rotation is the usual change. */
const KNOWN_SCREEN_MS = 6 * 3600_000;

interface Pipe {
  rec: ChildProcess; asm: AccessUnitAssembler; st: ScreenState; w: number; h: number;
  units: number; head: string; config?: Buffer; limit?: NodeJS.Timeout; killed?: boolean; exited?: boolean;
}
interface Sub { maxSize: number; onFail: (e: Error) => void }

const sources = new Map<string, ScreenSource>();
/** The serial's shared source (created on first use; it closes when its last subscriber leaves). */
export function screenSource(serial: string): ScreenSource {
  let s = sources.get(serial);
  if (!s || s.closed) { s = new ScreenSource(serial); sources.set(serial, s); }
  return s;
}
export function screenSourceStats() { return [...sources.values()].map((s) => ({ serial: s.serial, subscribers: s.subscribers, ...s.stats, cachedFrames: s.fanout.cache.frames.length, cachedBytes: s.fanout.cache.bytes })); }

export class ScreenSource {
  readonly serial: string;
  readonly fanout = new VideoFanout();
  closed = false;
  stats = { encoders: 0, handovers: 0, restarts: 0, repairs: 0, frames: 0 };
  private subs = new Map<VideoSink, Sub>();
  private cur: Pipe | undefined;        // the encoder whose pictures go out
  private incoming: Pipe | undefined;   // a new encoder that takes over at its first picture
  private starting = false;             // the next encoder is reading the screen
  private startGen = 0;                 // bumped by a restart: a start that began before it is dropped
  private target = 0;                   // the longer side to encode at: the largest any subscriber asked for
  private watcher: ChildProcess | undefined;
  private asleep = false;
  private wakeUntil = 0;
  private failures = 0;
  private handoverFailures = 0;
  private lastScreen = '';
  private gotFrame = false;
  private retry: NodeJS.Timeout | undefined;
  private stillTimer: NodeJS.Timeout | undefined;
  private noFrameTimer: NodeJS.Timeout | undefined;

  constructor(serial: string) {
    this.serial = serial;
    this.fanout.onNeedKeyFrame = () => this.requestKeyFrame();
  }

  get subscribers(): number { return this.subs.size; }

  /** `sink` gets what a decoder needs to start, then every packet. `onFail`: the device can't stream (no frames). */
  subscribe(sink: VideoSink, maxSize: number | undefined, onFail: (e: Error) => void): void {
    if (this.closed) { onFail(new Error('stream closed')); return; }
    const want = clampSize(maxSize);
    this.subs.set(sink, { maxSize: want, onFail });
    const grew = want > this.target;
    if (grew) this.target = want;
    this.fanout.add(sink);
    if (!this.cur && !this.incoming && !this.starting && !this.retry) {
      this.start();
      if (!this.noFrameTimer) {
        this.noFrameTimer = setTimeout(() => {
          this.noFrameTimer = undefined;
          if (!this.closed && !this.gotFrame && !this.asleep && this.failures === 0) this.fail(new Error('screenrecord sent no picture in 10 s'));
        }, NO_FRAME_MS);
        this.noFrameTimer.unref?.();
      }
    } else if (grew && this.cur) {
      const { w, h } = encodeSize(this.cur.st.info, this.target);
      if (w !== this.cur.w || h !== this.cur.h) this.handover();   // a bigger picture is wanted
    }
  }

  unsubscribe(sink: VideoSink): void {
    if (!this.subs.delete(sink)) return;
    this.fanout.remove(sink);
    if (!this.subs.size) this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.killPipe(this.cur); this.killPipe(this.incoming); this.cur = this.incoming = undefined;
    for (const t of [this.retry, this.stillTimer, this.noFrameTimer]) if (t) clearTimeout(t);
    try { this.watcher?.kill('SIGKILL'); } catch { /* */ }
    this.watcher = undefined;
    if (sources.get(this.serial) === this) sources.delete(this.serial);
  }

  /** The screen may have turned (the daemon calls this after a rotation): restart at the new size if it did. */
  restart(): void {
    if (this.closed) return;
    void readScreen(this.serial).then((st) => {
      const p = this.cur;
      if (!p || st.rotation !== p.st.rotation || st.info.width !== p.st.info.width || st.info.height !== p.st.info.height) this.restartNow();
    }, () => undefined);
  }

  /** A fresh key frame soon: a second encoder takes over (or, where two at once don't work, a restart). */
  requestKeyFrame(): void {
    if (this.closed) return;
    if (this.handoverFailures >= 2) { if (!this.incoming && !this.starting) this.restartNow(); }
    else this.handover();
  }

  /** Break before make (the screen turned: a new size). Viewers keep the last picture meanwhile (~0.3–0.6 s). */
  private restartNow() {
    if (this.closed) return;
    this.stats.restarts++;
    this.startGen++; this.starting = false;
    this.killPipe(this.cur); this.killPipe(this.incoming); this.cur = this.incoming = undefined;
    if (this.retry) { clearTimeout(this.retry); this.retry = undefined; }
    this.failures = 0;
    this.start();
  }

  /** Make before break: a second encoder starts, and takes over when its first picture (a key frame) arrives. */
  private handover() {
    if (this.closed || this.incoming || this.starting || !this.cur) return;
    this.stats.handovers++;
    this.start();
  }

  private start() {
    if (this.closed || this.starting || this.incoming) return;
    const gen = this.startGen;
    const read = readScreen(this.serial);
    const limit = noTimeLimit(this.serial);
    const known = knownScreenState(this.serial);
    if (!this.cur && known && Date.now() - known.at < KNOWN_SCREEN_MS) {
      // Nothing on screen yet: start at once with the screen as last read (an adb round trip sooner), and check it
      // meanwhile; if it turned since, start again at the new size.
      this.spawnPipe(known, limitKnown.get(this.serial) ?? false);
      void read.then((st) => {
        if (this.closed || gen !== this.startGen) return;
        if (st.rotation !== known.rotation || st.info.width !== known.info.width || st.info.height !== known.info.height) this.restartNow();
      }, () => undefined);
      return;
    }
    this.starting = true;
    void Promise.all([read, limit]).then(([st, unlimited]) => {
      if (this.closed || gen !== this.startGen) return;
      this.starting = false;
      this.spawnPipe(st, unlimited);
    }, (e) => {
      if (this.closed || gen !== this.startGen) return;
      this.starting = false;
      if (!this.cur) this.fail(e as Error);
    });
  }

  private spawnPipe(st: ScreenState, unlimited: boolean) {
    const { w, h } = encodeSize(st.info, this.target || DEFAULT_MAX_SIZE);
    const rec = spawn(adbPath(), ['-s', this.serial, 'exec-out', 'screenrecord', '--output-format=h264', '--size', `${w}x${h}`,
      '--bit-rate', bitRate(w, h), ...(unlimited ? ['--time-limit', '0'] : []), '-'], { env: toolEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
    const p: Pipe = { rec, st, w, h, units: 0, head: '', asm: undefined as unknown as AccessUnitAssembler };
    p.asm = new AccessUnitAssembler((au) => this.onUnit(p, au), { idleMs: IDLE_MS });
    this.incoming = p;
    this.stats.encoders++;
    this.watchDisplay();
    // exec-out has no separate stderr: an error message arrives as the first (and only) output
    rec.stdout!.on('data', (d: Buffer) => { if (p.head.length < 512) p.head += d.subarray(0, 512).toString('latin1'); if (!p.killed) p.asm.push(d); });
    rec.on('error', () => this.onExit(p));
    rec.on('exit', () => this.onExit(p));
    if (!unlimited) p.limit = setTimeout(() => { if (p === this.cur) this.handover(); }, LIMIT_HANDOVER_MS);
  }

  private onUnit(p: Pipe, au: AccessUnit) {
    if (this.closed || p.killed) return;
    if (p === this.incoming) {
      // its first picture: it takes over from the one before (if any)
      const old = this.cur;
      this.cur = p; this.incoming = undefined;
      this.killPipe(old);
      this.sendScreen(p);
    }
    if (p !== this.cur) return;
    p.units++;
    const params: Buffer[] = []; const rest: Buffer[] = [];
    let key = false;
    for (const n of au.nals) { const i = h264NalInfo(n); if (i.param) params.push(n); else { rest.push(n); if (i.key) key = true; } }
    if (params.length) {
      const cfg = joinNals(params);
      if (!p.config || !p.config.equals(cfg)) { p.config = cfg; this.fanout.packet({ type: 'config', codec: 'h264', data: cfg }); }
    }
    if (!rest.length || !p.config) return;
    if (this.asleep) { this.asleep = false; this.fanout.packet({ type: 'state', state: 'live' }); }
    const frame: FramePacket = { type: 'frame', data: joinNals(rest), key, at: au.at };
    this.stats.frames++;
    if (au.repair) {
      // A picture went out cut short. Few frames since the key frame: every viewer replays them, corrected. Many: a
      // fresh key frame is cheaper (the damage shows until it comes, a fraction of a second).
      this.stats.repairs++;
      const c = this.fanout.cache;
      this.fanout.repair(frame, c.frames.length <= REFRESH_FRAMES && c.bytes <= REFRESH_BYTES);
    } else this.fanout.packet(frame);
    this.failures = 0; this.gotFrame = true;
    this.armStill();
  }

  private sendScreen(p: Pipe) {
    const pk: VideoPacket = { type: 'screen', screen: p.st.info, video: { width: p.w, height: p.h }, rotation: p.st.rotation };
    const k = JSON.stringify(pk);
    if (k === this.lastScreen) return;
    this.lastScreen = k;
    this.fanout.packet(pk);
  }

  private onExit(p: Pipe) {
    if (p.exited) return;
    p.exited = true;
    if (p.limit) clearTimeout(p.limit);
    if (this.closed || p.killed) return;
    p.asm.flush();   // its last picture
    p.asm.stop();
    if (p === this.incoming) {
      this.incoming = undefined;
      if (this.cur) { this.handoverFailures++; return; }   // a hand-over that didn't work: the current encoder goes on
      this.startFailed(p);
      return;
    }
    if (p !== this.cur) return;
    this.cur = undefined;
    if (this.incoming || this.starting) return;   // its successor is on the way
    // It ended after showing the screen (the time limit, the display went off, adb hiccup): start again soon.
    this.again(300);
  }

  private startFailed(p: Pipe) {
    if (/INVALID_LAYER_STACK|display state/i.test(p.head)) {
      if (!this.asleep) { this.asleep = true; this.fanout.packet({ type: 'state', state: 'asleep' }); }
      this.failures = 0;
      this.again(Date.now() < this.wakeUntil ? 250 : 2000);
      return;
    }
    // encoder busy / unsupported size: a few tries, then give up (JPEG streams poll screenshots instead)
    this.failures++;
    if (this.failures >= 4) { this.fail(new Error(`screenrecord produced no video${p.head.trim() ? `: ${p.head.replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, 200)}` : ''}`)); return; }
    this.again(1000 * this.failures);
  }

  private again(ms: number) {
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => { this.retry = undefined; if (!this.closed && !this.cur && !this.incoming) this.start(); }, ms);
  }

  private armStill() {
    if (this.stillTimer) clearTimeout(this.stillTimer);
    this.stillTimer = setTimeout(() => {
      this.stillTimer = undefined;
      const c = this.fanout.cache;
      if (this.handoverFailures < 2 && (c.overflowed || c.frames.length > REFRESH_FRAMES || c.bytes > REFRESH_BYTES)) this.handover();
    }, STILL_REFRESH_MS);
    this.stillTimer.unref?.();
  }

  private fail(e: Error) {
    if (this.closed) return;
    const subs = [...this.subs.values()];
    this.close();
    for (const s of subs) { try { s.onFail(e); } catch { /* */ } }
  }

  private killPipe(p: Pipe | undefined) {
    if (!p) return;
    p.killed = true;
    p.asm.stop();
    if (p.limit) clearTimeout(p.limit);
    try { p.rec.kill('SIGKILL'); } catch { /* */ }
  }

  // screenrecord logs when the display turns (and then letterboxes): restart at the new size. PowerManagerService
  // logs the wake: start at once instead of waiting for the next retry.
  private watchDisplay() {
    if (this.closed || this.watcher) return;
    const w = spawn(adbPath(), ['-s', this.serial, 'logcat', '-T', '1', '-v', 'brief', '-s', 'ScreenRecord:D', 'PowerManagerService:I'], { env: toolEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
    this.watcher = w;
    let buf = '';
    w.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split('\n'); buf = lines.pop() ?? '';
      for (const l of lines) {
        if (this.closed) return;
        if (/Waking up from/i.test(l)) {
          this.wakeUntil = Date.now() + 3000;
          if (this.asleep && !this.cur && !this.incoming && !this.starting) { if (this.retry) { clearTimeout(this.retry); this.retry = undefined; } this.start(); }
          continue;
        }
        const c = parseDisplayChange(l);
        const p = this.cur;
        if (!c || !p) continue;
        const sizeChanged = c.width !== undefined && (c.width !== p.st.info.width || c.height !== p.st.info.height);
        if (c.rotation !== p.st.rotation || sizeChanged) this.restartNow();
      }
    });
    w.on('error', () => { /* no logcat: rotations are then picked up by restart() and screenrecord's own exits */ });
    w.on('exit', () => { if (this.watcher === w) this.watcher = undefined; });
  }
}

/** An adb serial, or a way to find it when the stream starts: a real phone is known by its hardware serial, while adb
 *  needs the transport it's on now (over Wi-Fi, ip:port or an mDNS name). */
export type SerialRef = string | (() => Promise<string>);
const resolveSerial = (s: SerialRef): Promise<string> => (typeof s === 'string' ? Promise.resolve(s) : s());

/** Backend.video: one subscription to the serial's shared source. */
export function adbVideoStream(serial: SerialRef, opts: { maxSize?: number } = {}): VideoStream {
  const cbs: ((p: VideoPacket) => void)[] = []; const endCbs: ((e?: Error) => void)[] = [];
  let ended = false; let src: ScreenSource | undefined;
  const sink: VideoSink = { packet: (p) => { for (const cb of cbs) { try { cb(p); } catch { /* */ } } } };
  const end = (e?: Error) => { if (ended) return; ended = true; src?.unsubscribe(sink); for (const cb of endCbs) cb(e); };
  // after the caller has registered its callbacks (the catch-up goes out synchronously)
  setImmediate(() => {
    if (ended) return;
    resolveSerial(serial).then((sr) => { if (ended) return; src = screenSource(sr); src.subscribe(sink, opts.maxSize, (e) => end(e)); },
      (e) => end(e instanceof Error ? e : new Error(String(e))));
  });
  return {
    onPacket(cb) { cbs.push(cb); },
    onEnd(cb) { endCbs.push(cb); },
    stop() { end(); },
    restart() { src?.restart(); },
    requestKeyFrame() { src?.requestKeyFrame(); },
  };
}

/** Backend.stream: JPEG frames decoded from the shared source by ffmpeg (started only for this), at most `fps` a
 *  second. Falls back to screenshots when there's no ffmpeg or the source can't stream. */
export function adbFrameStream(serial: SerialRef, opts: { maxSize?: number; fps?: number; capture?: () => Promise<Buffer> } = {}): FrameStream {
  const frameCbs: ((j: Buffer, s?: ScreenInfo) => void)[] = []; const endCbs: ((e?: Error) => void)[] = [];
  const fps = Math.max(1, Math.min(opts.fps ?? 15, 60));
  const maxSize = clampSize(opts.maxSize);
  let stopped = false; let pollMode = false;
  let ff: ChildProcess | undefined; let ffConfig: Buffer | undefined;
  let screen: ScreenInfo | undefined; let video: { width: number; height: number } | undefined;
  // At most `fps` frames a second, and never holding back the newest: a frame that comes too soon waits for its slot
  // and is replaced by any newer one (the last picture of a movement is the one a still screen keeps showing).
  let lastEmit = 0; let pending: [Buffer, ScreenInfo | undefined] | undefined; let emitTimer: NodeJS.Timeout | undefined;
  const deliver = (j: Buffer, s?: ScreenInfo) => { lastEmit = Date.now(); for (const cb of frameCbs) { try { cb(j, s); } catch { /* */ } } };
  const emit = (j: Buffer, s?: ScreenInfo) => {
    const wait = lastEmit + 1000 / fps - Date.now();
    if (wait <= 0 && !emitTimer) { deliver(j, s); return; }
    pending = [j, s];
    emitTimer ??= setTimeout(() => { emitTimer = undefined; const p = pending; pending = undefined; if (p && !stopped) deliver(p[0], p[1]); }, Math.max(0, wait));
  };
  const killFf = () => { try { ff?.kill('SIGKILL'); } catch { /* */ } ff = undefined; ffConfig = undefined; };
  const ffmpeg = ffmpegPath();
  let src: ScreenSource | undefined;

  const startFf = (config: Buffer) => {
    if (ff && ffConfig?.equals(config)) return;   // same parameter sets: the running decoder takes the new key frame
    killFf();
    const vf: string[] = [];
    if (video && Math.max(video.width, video.height) > maxSize + 2) { const { w, h } = encodeSize(video, maxSize); vf.push('-vf', `scale=${w}:${h}`); }
    const p = spawn(ffmpeg!, ['-loglevel', 'error', '-probesize', '32', '-analyzeduration', '0', '-flags', 'low_delay', '-f', 'h264', '-i', '-',
      ...vf, '-fps_mode', 'passthrough', '-threads', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', '-pix_fmt', 'yuvj420p', '-q:v', '7', '-'], { env: toolEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
    ff = p; ffConfig = config;
    const si = screen;
    p.stdin!.on('error', () => { /* EPIPE */ });
    p.on('error', () => { if (ff === p) ff = undefined; });
    let buf: Buffer = Buffer.alloc(0);
    p.stdout!.on('data', (d: Buffer) => {
      if (ff !== p) return;   // a replaced decoder's leftovers
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      for (;;) {
        const s = buf.indexOf(JPEG_SOI);
        if (s < 0) { buf = Buffer.alloc(0); break; }
        const e = buf.indexOf(JPEG_EOI, s + 2);
        if (e < 0) { if (s > 0) buf = buf.subarray(s); break; }
        emit(Buffer.from(buf.subarray(s, e + 2)), si);
        buf = buf.subarray(e + 2);
      }
    });
    p.stdin!.write(config);
  };
  const sink: VideoSink = {
    packet(p) {
      if (stopped) return;
      switch (p.type) {
        case 'screen': screen = p.screen; video = p.video; break;
        case 'reset': killFf(); break;
        case 'config': startFf(p.data); break;
        case 'frame': if (ff && !ff.stdin!.destroyed) { ff.stdin!.write(p.data); ff.stdin!.write(H264_AUD); } break;
      }
    },
  };

  const capture = opts.capture ?? (async () => screenshot(await resolveSerial(serial)));
  const pollLoop = async () => {
    if (pollMode) return;
    pollMode = true; killFf(); src?.unsubscribe(sink);
    let lastPng: Buffer | undefined;
    while (!stopped) {
      const t0 = Date.now();
      try {
        const png = await capture();
        if (stopped) break;
        // Same pixels → same PNG bytes: skip the conversion and keep the current frame (and its ETag).
        if (!lastPng || !lastPng.equals(png)) {
          const j = await pngToJpeg(png, maxSize, 70);
          if (stopped) break;
          lastPng = png;
          const sz = pngSize(png);
          deliver(j, sz ? { width: sz.width, height: sz.height, scale: 1, orientation: orientationOf(sz.width, sz.height) } : undefined);
        }
      } catch {
        if (!stopped) await sleep(1000);
      }
      await sleep(Math.max(0, 1000 / fps - (Date.now() - t0)));
    }
  };

  setImmediate(() => {
    if (stopped) return;
    if (!ffmpeg) { void pollLoop(); return; }
    resolveSerial(serial).then((sr) => {
      if (stopped) return;
      src = screenSource(sr);
      src.subscribe(sink, maxSize, () => { if (!stopped) void pollLoop(); });
    }, () => { if (!stopped) void pollLoop(); });
  });

  return {
    onFrame(cb) { frameCbs.push(cb); },
    onEnd(cb) { endCbs.push(cb); },
    stop() {
      if (stopped) return;
      stopped = true;
      if (emitTimer) clearTimeout(emitTimer);
      killFf(); src?.unsubscribe(sink);
      for (const cb of endCbs) cb();
    },
    restart() { if (!pollMode) src?.restart(); },
  };
}
