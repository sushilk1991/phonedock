// Live video plumbing shared by the backends and the daemon (nothing device specific):
//  - Annex B parsing and access-unit assembly for raw H.264 / HEVC elementary streams (AccessUnitAssembler),
//  - the frames since the last key frame, so a viewer that joins mid-stream can start decoding at once (GopCache),
//  - fan-out to viewers with backpressure: a slow viewer skips frames and resyncs, never buffers without bound
//    (VideoFanout),
//  - the wire format of `GET /v1/devices/:id/video` (encodeVideoPacket / VideoMessageReader; docs/API.md "Live video").
import type { ScreenInfo, VideoCodec, VideoPacket } from './types.ts';

export type FramePacket = Extract<VideoPacket, { type: 'frame' }>;
export type ConfigPacket = Extract<VideoPacket, { type: 'config' }>;
export type ScreenPacket = Extract<VideoPacket, { type: 'screen' }>;
export type StatePacket = Extract<VideoPacket, { type: 'state' }>;

const EMPTY = Buffer.alloc(0);
const SC3 = Buffer.from([0, 0, 1]);
export const START_CODE = Buffer.from([0, 0, 0, 1]);

/** A 3- or 4-byte Annex B start code at the start of `b`. */
export function startsWithStartCode(b: Buffer): boolean {
  return b.length >= 3 && b[0] === 0 && b[1] === 0 && (b[2] === 1 || (b[2] === 0 && b.length >= 4 && b[3] === 1));
}

/** The NAL units of an Annex B buffer (without start codes or trailing zero bytes). */
export function splitNals(b: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let i = b.indexOf(SC3);
  while (i >= 0) {
    const start = i + 3;
    const next = b.indexOf(SC3, start);
    let end = next < 0 ? b.length : next;
    while (end > start && b[end - 1] === 0) end--;
    if (end > start) out.push(b.subarray(start, end));
    i = next;
  }
  return out;
}

/** NAL units → Annex B, each after a 4-byte start code. */
export function joinNals(nals: Buffer[]): Buffer {
  const parts: Buffer[] = [];
  for (const n of nals) parts.push(START_CODE, n);
  return Buffer.concat(parts);
}

/** What the assembler needs to know about one NAL unit. */
export interface NalInfo {
  vcl: boolean;        // coded picture data (a slice)
  key: boolean;        // a slice of a key picture (H.264 IDR, HEVC IRAP)
  param: boolean;      // a parameter set (goes in `config`, not in frames)
  auStart: boolean;    // a non-VCL unit that may only begin an access unit (AUD, SPS, PPS, SEI, …)
  firstSlice: boolean; // a slice that begins a picture
}
export function h264NalInfo(n: Buffer): NalInfo {
  const t = n[0] & 0x1f;
  const vcl = t >= 1 && t <= 5;
  return {
    vcl, key: t === 5, param: t === 7 || t === 8,
    auStart: t === 6 || t === 7 || t === 8 || t === 9 || (t >= 14 && t <= 18),
    // first_mb_in_slice is ue(v) and comes first: 0 is coded as a single 1 bit
    firstSlice: vcl && n.length > 1 && (n[1] & 0x80) !== 0,
  };
}
export function hevcNalInfo(n: Buffer): NalInfo {
  const t = (n[0] >> 1) & 0x3f;
  const vcl = t <= 31;
  return {
    vcl, key: t >= 16 && t <= 21, param: t >= 32 && t <= 34,
    auStart: (t >= 32 && t <= 35) || t === 39 || (t >= 41 && t <= 44) || (t >= 48 && t <= 55),
    // first_slice_segment_in_pic_flag is the first bit after the 2-byte NAL header
    firstSlice: vcl && n.length > 2 && (n[2] & 0x80) !== 0,
  };
}
export const nalInfo = (codec: VideoCodec): ((n: Buffer) => NalInfo) => (codec === 'hevc' ? hevcNalInfo : h264NalInfo);

export interface AccessUnit {
  nals: Buffer[];
  key: boolean;
  /** ms since the epoch when its last bytes arrived */
  at: number;
  /** The previous unit was emitted too early (cut short): this is the whole of it, replacing it. */
  repair?: boolean;
}

/** Splits a raw Annex B stream (as it arrives, in chunks of any size) into access units.
 *
 *  A raw elementary stream has no frame lengths, so the end of a picture is known for sure only when the next one
 *  starts. Waiting for that would add a frame of latency and hold the last picture of a movement (or the only picture
 *  of a still screen) back forever, so a unit is also emitted once the input has been quiet for `idleMs`. That guess
 *  can be wrong: a write split in two can arrive with a gap (measured on an emulator under load: mostly ≤ 10 ms, once
 *  48 ms). The next chunk then shows it — it doesn't begin with a start code, or it begins with a slice that continues
 *  the picture — and the unit is reopened and emitted again, whole, with `repair: true` (consumers resync their
 *  decoders); `idleMs` grows each time so it happens less. */
export class AccessUnitAssembler {
  idleMs: number;
  maxIdleMs: number;
  truncations = 0;
  private info: (n: Buffer) => NalInfo;
  private onUnit: (au: AccessUnit) => void;
  private now: () => number;
  private buf: Buffer = EMPTY;     // unparsed input: the NAL unit in progress (after its start code) when inNal
  private inNal = false;
  private peeked = false;          // the NAL unit in progress has been looked at (peek)
  private nals: Buffer[] = [];     // complete NAL units of the unit being built
  private hasVcl = false;
  private repair = false;
  private lastAt = 0;
  private timer: NodeJS.Timeout | undefined;
  /** What the idle timer did, kept until the next chunk shows whether the input really ended there. */
  private check: { emitted?: Buffer[]; zeros: number } | undefined;
  /** The unit the idle timer emitted, until a later one starts (a slice that continues it reopens it). */
  private idleUnit: Buffer[] | undefined;

  constructor(onUnit: (au: AccessUnit) => void, opts: { codec?: VideoCodec; idleMs?: number; maxIdleMs?: number; now?: () => number } = {}) {
    this.onUnit = onUnit;
    this.info = nalInfo(opts.codec ?? 'h264');
    this.idleMs = opts.idleMs ?? 12;
    this.maxIdleMs = opts.maxIdleMs ?? 60;
    this.now = opts.now ?? (() => performance.timeOrigin + performance.now());
  }

  push(chunk: Buffer): void {
    if (!chunk.length) return;
    this.lastAt = this.now();
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const ck = this.check; this.check = undefined;
    if (ck) {
      const zeros = Buffer.alloc(ck.zeros);
      const head = Buffer.concat([zeros, chunk.subarray(0, 4)]);
      if (head.length < 4 && head.every((x) => x === 0)) {
        // too few bytes to tell yet (a start code may be on its way)
        this.check = { ...ck, zeros: ck.zeros + chunk.length }; this.arm();
        return;
      }
      if (!startsWithStartCode(head)) {
        // The input hadn't ended: this continues the last NAL unit the idle timer took as complete.
        this.truncations++;
        this.idleMs = Math.min(this.maxIdleMs, this.idleMs + 8);
        let last: Buffer;
        if (ck.emitted) { last = ck.emitted[ck.emitted.length - 1]; this.nals = ck.emitted.slice(0, -1); this.repair = true; this.idleUnit = undefined; }
        else last = this.nals.pop() ?? EMPTY;
        this.hasVcl = this.nals.some((n) => this.info(n).vcl);
        this.buf = Buffer.concat([last, zeros, chunk]); this.inNal = true; this.peeked = true;
        this.scan(); this.arm();
        return;
      }
      if (ck.zeros) chunk = Buffer.concat([zeros, chunk]);
    }
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    this.scan();
    this.arm();
  }

  /** The input ended: what is buffered is complete. */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.check = undefined;
    this.endNal();
    if (this.hasVcl) this.emit();
  }

  stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }

  private arm() { this.timer = setTimeout(() => this.idle(), this.idleMs); }

  private idle() {
    this.timer = undefined;
    if (!this.inNal || !this.buf.length) return;
    const zeros = this.endNal();
    if (this.hasVcl) { const emitted = this.nals; this.emit(); this.idleUnit = emitted; this.check = { emitted, zeros }; }
    else this.check = { zeros };
  }

  /** Takes the NAL unit in progress as complete; returns how many trailing zero bytes it had (a start code may follow). */
  private endNal(): number {
    if (!this.inNal) return 0;
    let end = this.buf.length; while (end > 0 && this.buf[end - 1] === 0) end--;
    const zeros = this.buf.length - end;
    if (end > 0) this.nal(this.buf.subarray(0, end));
    this.buf = EMPTY; this.inNal = false;
    return zeros;
  }

  private scan() {
    const b = this.buf;
    let pos = 0;
    if (!this.inNal) {
      const i = b.indexOf(SC3);
      if (i < 0) { this.buf = b.length > 3 ? b.subarray(b.length - 3) : b; return; }   // keep a possible partial start code
      pos = i + 3; this.inNal = true; this.peeked = false;
    }
    for (;;) {
      const i = b.indexOf(SC3, pos);
      if (i < 0) break;
      let end = i; while (end > pos && b[end - 1] === 0) end--;
      if (end > pos) this.nal(b.subarray(pos, end));
      pos = i + 3; this.peeked = false;
    }
    this.buf = pos ? b.subarray(pos) : b;
    this.peek();
  }

  /** The NAL unit in progress has its first bytes: if it begins a new picture, the one before is complete — emit it
   *  now rather than when this one ends (a frame of latency). */
  private peek() {
    if (this.peeked || !this.inNal || this.buf.length < 3) return;
    this.peeked = true;
    if (!this.hasVcl) return;
    const i = this.info(this.buf.subarray(0, 3));
    if (i.auStart || (i.vcl && i.firstSlice)) { this.emit(); this.idleUnit = undefined; }
  }

  private nal(n: Buffer) {
    const i = this.info(n);
    if (!this.hasVcl && !this.nals.length && i.vcl && !i.firstSlice && this.idleUnit) {
      // a later slice of the picture the idle timer emitted: it wasn't complete
      this.truncations++;
      this.idleMs = Math.min(this.maxIdleMs, this.idleMs + 8);
      this.nals = [...this.idleUnit]; this.idleUnit = undefined; this.hasVcl = true; this.repair = true;
      this.nals.push(n);
      return;
    }
    if (this.hasVcl && (i.auStart || (i.vcl && i.firstSlice))) this.emit();
    if (i.auStart || i.vcl) this.idleUnit = undefined;
    this.nals.push(n);
    if (i.vcl) this.hasVcl = true;
  }

  private emit() {
    const nals = this.nals;
    this.nals = []; this.hasVcl = false;
    const repair = this.repair; this.repair = false;
    if (!nals.length) return;
    this.onUnit({ nals, key: nals.some((n) => this.info(n).key), at: this.lastAt, ...(repair ? { repair: true } : {}) });
  }
}

// ── key-frame cache ─────────────────────────────────────────────────────────────
/** The latest screen, state and config, and the frames since the last key frame (bounded: past `maxBytes` or
 *  `maxFrames` it gives up until the next key frame, and a joining viewer has to wait for one). */
export class GopCache {
  screen?: ScreenPacket;
  state?: StatePacket;
  config?: ConfigPacket;
  frames: FramePacket[] = [];
  bytes = 0;
  overflowed = false;
  maxBytes: number;
  maxFrames: number;
  constructor(maxBytes = 4 * 1024 * 1024, maxFrames = 300) { this.maxBytes = maxBytes; this.maxFrames = maxFrames; }

  add(p: VideoPacket): void {
    switch (p.type) {
      case 'reset': this.screen = undefined; this.state = undefined; this.config = undefined; this.clearFrames(); return;
      case 'screen': this.screen = p; return;
      case 'state': this.state = p; return;
      case 'config':
        // frames coded with other parameter sets can't be decoded with these
        if (!this.config || this.config.codec !== p.codec || !this.config.data.equals(p.data)) this.clearFrames();
        this.config = p;
        return;
      case 'frame': {
        const f: FramePacket = p.replay ? { type: 'frame', data: p.data, key: p.key, at: p.at } : p;
        if (f.key) { this.frames = [f]; this.bytes = f.data.length; this.overflowed = false; return; }
        if (!this.frames.length) return;    // nothing to decode it against
        if (this.frames.length >= this.maxFrames || this.bytes + f.data.length > this.maxBytes) { this.clearFrames(); this.overflowed = true; return; }
        this.frames.push(f); this.bytes += f.data.length;
      }
    }
  }

  /** A config and a key frame to start from. */
  get decodable(): boolean { return !!this.config && this.frames.length > 0; }

  /** The newest frame was cut short; this is the whole of it. */
  replaceLast(p: FramePacket): boolean {
    const n = this.frames.length;
    if (!n) return false;
    this.bytes += p.data.length - this.frames[n - 1].data.length;
    this.frames[n - 1] = p.replay ? { type: 'frame', data: p.data, key: p.key, at: p.at } : p;
    return true;
  }

  /** What a new decoder needs, in order: screen, state, config, then the frames since the key frame, all but the
   *  newest marked replay. Without a key frame, only screen/state/config. */
  catchUp(): VideoPacket[] {
    const out: VideoPacket[] = [];
    if (this.screen) out.push(this.screen);
    if (this.state) out.push(this.state);
    if (this.config) out.push(this.config);
    if (this.config) {
      const n = this.frames.length;
      for (let i = 0; i < n; i++) out.push(i < n - 1 ? { ...this.frames[i], replay: true } : this.frames[i]);
    }
    return out;
  }

  private clearFrames() { this.frames = []; this.bytes = 0; this.overflowed = false; }
}

// ── fan-out ─────────────────────────────────────────────────────────────────────
export interface VideoSink {
  packet(p: VideoPacket): void;
  /** Bytes queued for it and not yet sent (an HTTP response's writableLength). Absent: never behind. */
  backlog?(): number;
}
type SinkState = 'live' | 'lagging' | 'waitkey';

/** Sends one source's packets to many sinks. A sink that joins gets the cache's catch-up (or waits for the next key
 *  frame). One whose backlog passes `high` skips frames until it is under `low`, then resyncs: `reset` + catch-up. */
export class VideoFanout {
  readonly cache: GopCache;
  high: number;
  low: number;
  /** A sink is waiting for a key frame (the cache had none it could replay). */
  onNeedKeyFrame?: () => void;
  private sinks = new Map<VideoSink, SinkState>();
  dropped = 0;
  resyncs = 0;

  constructor(cache = new GopCache(), opts: { high?: number; low?: number } = {}) {
    this.cache = cache;
    // above the most a catch-up can queue, so a viewer that just joined isn't taken for a slow one
    this.high = opts.high ?? cache.maxBytes + 2 * 1024 * 1024;
    this.low = opts.low ?? 512 * 1024;
  }

  get size(): number { return this.sinks.size; }
  has(s: VideoSink): boolean { return this.sinks.has(s); }
  stateOf(s: VideoSink): SinkState | undefined { return this.sinks.get(s); }

  add(s: VideoSink): void { this.sinks.set(s, 'live'); this.sinks.set(s, this.start(s)); }
  remove(s: VideoSink): void { this.sinks.delete(s); }

  packet(p: VideoPacket): void {
    this.cache.add(p);
    for (const [s, st] of [...this.sinks]) {
      if (!this.sinks.has(s)) continue;
      if (p.type !== 'frame') {
        if (st !== 'lagging') s.packet(p);
        continue;
      }
      if (st === 'waitkey') {
        if (p.key) { this.sinks.set(s, 'live'); s.packet(p); }
        continue;
      }
      if (st === 'lagging') {
        if (this.backlog(s) <= this.low) this.resync(s); else this.dropped++;
        continue;
      }
      if (this.backlog(s) > this.high) { this.sinks.set(s, 'lagging'); this.dropped++; continue; }
      s.packet(p);
    }
  }

  /** The sink's queue drained: a lagging one resyncs now rather than at the next frame (a still screen sends none). */
  drained(s: VideoSink): void {
    if (this.sinks.get(s) === 'lagging' && this.backlog(s) <= this.low) this.resync(s);
  }

  /** The newest frame went out cut short; `p` is the whole of it. Every sink resyncs from the corrected cache, or,
   *  without a key frame to replay from (or with `resync` false: too many frames to replay), a fresh key frame is
   *  asked for and the sinks go on until it comes. */
  repair(p: FramePacket, resync = true): void {
    if (!this.cache.replaceLast(p) || !this.cache.decodable || !resync) { this.onNeedKeyFrame?.(); return; }
    for (const [s, st] of [...this.sinks]) if (st !== 'waitkey' && this.sinks.has(s)) this.resync(s);
  }

  private backlog(s: VideoSink): number { return s.backlog?.() ?? 0; }

  private resync(s: VideoSink) {
    this.resyncs++;
    s.packet({ type: 'reset' });
    if (this.sinks.has(s)) this.sinks.set(s, this.start(s));
  }

  private start(s: VideoSink): SinkState {
    const decodable = this.cache.decodable;
    for (const p of this.cache.catchUp()) { if (!this.sinks.has(s)) return 'live'; s.packet(p); }
    if (decodable) return 'live';
    this.onNeedKeyFrame?.();
    return 'waitkey';
  }
}

// ── wire format (GET /v1/devices/:id/video) ─────────────────────────────────────
// A stream of messages, each a 16-byte header and a payload:
//   0  u8   type      1 screen · 2 config · 3 frame · 4 state · 5 reset · 6 ping · 7 still
//   1  u8   flags     frame: 1 key, 2 replay (decode, don't show) · config: the codec (0 H.264, 1 HEVC)
//   2  u8   version   1
//   3  u8   reserved  0
//   4  u32  payload length (big-endian)
//   8  u64  timestamp, µs since the Unix epoch (big-endian): frame — when the daemon got it; ping — now
//  16  …    payload: screen/state — UTF-8 JSON; config — parameter sets, Annex B; frame — one access unit, Annex B;
//                    still — a PNG or JPEG of the screen, to show until the first frame; reset/ping — empty
export const VIDEO_CONTENT_TYPE = 'application/vnd.phonedock.video';
export const VIDEO_HEADER_BYTES = 16;
export const VIDEO_VERSION = 1;
export const VIDEO_MSG = { screen: 1, config: 2, frame: 3, state: 4, reset: 5, ping: 6, still: 7 } as const;
export const VIDEO_FLAG = { key: 1, replay: 2 } as const;
export const VIDEO_CODEC_ID: Record<VideoCodec, number> = { h264: 0, hevc: 1 };

export function videoHeader(type: number, flags: number, length: number, tsMs: number): Buffer {
  const h = Buffer.alloc(VIDEO_HEADER_BYTES);
  h[0] = type; h[1] = flags; h[2] = VIDEO_VERSION; h[3] = 0;
  h.writeUInt32BE(length, 4);
  h.writeBigUInt64BE(BigInt(Math.max(0, Math.round(tsMs * 1000))), 8);
  return h;
}

/** JSON body of a `screen` message. */
export function screenJson(p: ScreenPacket): Record<string, unknown> {
  const s: ScreenInfo = p.screen;
  return { width: s.width, height: s.height, videoWidth: p.video.width, videoHeight: p.video.height, rotation: p.rotation ?? null, orientation: s.orientation ?? null, density: s.density ?? null,
    ...(p.coded ? { codedWidth: p.coded.width, codedHeight: p.coded.height } : {}) };
}

/** A packet as header + payload buffers (written one after the other). */
export function encodeVideoPacket(p: VideoPacket): Buffer[] {
  switch (p.type) {
    case 'frame': return [videoHeader(VIDEO_MSG.frame, (p.key ? VIDEO_FLAG.key : 0) | (p.replay ? VIDEO_FLAG.replay : 0), p.data.length, p.at), p.data];
    case 'config': return [videoHeader(VIDEO_MSG.config, VIDEO_CODEC_ID[p.codec], p.data.length, 0), p.data];
    case 'reset': return [videoHeader(VIDEO_MSG.reset, 0, 0, 0)];
    case 'screen': case 'state': {
      const body = Buffer.from(JSON.stringify(p.type === 'screen' ? screenJson(p) : { state: p.state }));
      return [videoHeader(p.type === 'screen' ? VIDEO_MSG.screen : VIDEO_MSG.state, 0, body.length, 0), body];
    }
  }
}
export const pingMessage = (nowMs = Date.now()): Buffer => videoHeader(VIDEO_MSG.ping, 0, 0, nowMs);
export const stillMessage = (image: Buffer, atMs: number): Buffer[] => [videoHeader(VIDEO_MSG.still, 0, image.length, atMs), image];

export interface VideoMessage { type: number; flags: number; version: number; tsUs: bigint; payload: Buffer }
/** Parses the wire format from chunks of any size (clients and tests). */
export class VideoMessageReader {
  private buf: Buffer = EMPTY;
  push(chunk: Buffer): VideoMessage[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: VideoMessage[] = [];
    let pos = 0;
    while (this.buf.length - pos >= VIDEO_HEADER_BYTES) {
      const len = this.buf.readUInt32BE(pos + 4);
      if (this.buf.length - pos < VIDEO_HEADER_BYTES + len) break;
      out.push({ type: this.buf[pos], flags: this.buf[pos + 1], version: this.buf[pos + 2], tsUs: this.buf.readBigUInt64BE(pos + 8),
        payload: this.buf.subarray(pos + VIDEO_HEADER_BYTES, pos + VIDEO_HEADER_BYTES + len) });
      pos += VIDEO_HEADER_BYTES + len;
    }
    this.buf = pos ? this.buf.subarray(pos) : this.buf;
    return out;
  }
}
