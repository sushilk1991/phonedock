// Live video of a real iPhone on iOS 27+, from the display stream the HID sidecar (tools/pd-ios-hid.py) already holds
// for touches: iOS allows one screen stream per phone, so video and input share it.
//
//   phone ──RTP/HEVC──▶ pd-ios-hid.py (depacketize, fd 3) ──▶ DeviceFeed (one per phone, fans out)
//                                                               ├─▶ iosVideoFrameStream: tools/pd-ios-video.swift
//                                                               │     (VideoToolbox decode → JPEG, ≤ fps, only changes)
//                                                               ├─▶ iosHevcFeed: raw access units + decoder config
//                                                               └─▶ startHevcRecording: the same helper writes an .mp4
//
// Every consumer starts at a key frame: joining asks the phone for one (RTCP PLI, ~40 ms), so a viewer never waits for
// the encoder's own (it may send none for minutes). A viewer never takes the stream from Xcode Device Hub / iPhone
// Mirroring (steal: false): while another client streams, or when the stream can't open (locked phone, older iOS), the
// frame stream shows screenshots instead and tries the video again every RETRY_MS.
// Measured on an iPhone 16 Pro Max, iOS 27.0, over Wi-Fi: see docs/IPHONE-WIFI.md.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, runBuffer, sleep } from '../core/exec.ts';
import { stateDir, toolEnv } from '../core/paths.ts';
import { PhoneDockError, type FrameStream, type ScreenInfo, type VideoPacket, type VideoStream } from '../core/types.ts';
import { ffmpegBin, pngSize } from './ios-common.ts';
import { hidKeyframe, hidVideoStart, type HidVideoSink } from './ios-hid.ts';

const RETRY_MS = 10_000;          // screenshot fallback → try the video again (doubling up to RETRY_MAX_MS)
const RETRY_MAX_MS = 60_000;
const STALL_MS = 3_000;           // no access unit for this long while someone watches: check the stream
const HELPER_BACKLOG = 4 << 20;   // bytes queued for the decoder before it is considered behind

// ── wire format (see tools/pd-ios-hid.py "Video fd records" and tools/pd-ios-video.swift) ──────────────────────────

export const KIND_ACCESS_UNIT = 1;
export const KIND_CONFIG = 2;
export const FLAG_KEY = 1;
export const FLAG_DISCONTINUITY = 2;
export const RECORD_HEADER = 20;

/** Splits a byte stream of `u32 BE length` + body records (the sidecar's video fd, the Swift helper's stdout). */
export class RecordReader {
  private buf: Buffer = Buffer.alloc(0);
  private readonly onRecord: (rec: Buffer) => void;
  private readonly maxLen: number;
  constructor(onRecord: (rec: Buffer) => void, maxLen = 64 << 20) { this.onRecord = onRecord; this.maxLen = maxLen; }
  /** Feed bytes; calls onRecord with each complete record (length prefix included). Throws on an impossible length. */
  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let off = 0;
    while (this.buf.length - off >= 4) {
      const len = this.buf.readUInt32BE(off);
      if (len > this.maxLen) { this.buf = Buffer.alloc(0); throw new Error(`bad record length ${len}`); }
      if (this.buf.length - off < 4 + len) break;
      this.onRecord(this.buf.subarray(off, off + 4 + len));
      off += 4 + len;
    }
    this.buf = off ? Buffer.from(this.buf.subarray(off)) : this.buf;
  }
  get pending(): number { return this.buf.length; }
}

export interface VideoRecord {
  kind: number; flags: number; rtpTs: number; recvUs: number;
  payload: Buffer;    // kind 1: NAL units with 4-byte BE length prefixes; kind 2: JSON
  raw: Buffer;        // the whole record, as the Swift helper reads it
}

/** Parse one sidecar video record (length prefix included). */
export function parseVideoRecord(rec: Buffer): VideoRecord | undefined {
  if (rec.length < RECORD_HEADER || rec.readUInt32BE(0) !== rec.length - 4) return undefined;
  return { kind: rec[4], flags: rec[5], rtpTs: rec.readUInt32BE(8), recvUs: Number(rec.readBigUInt64BE(12)), payload: rec.subarray(RECORD_HEADER), raw: rec };
}

/** Build a sidecar video record (tests, and re-framing). */
export function videoRecord(kind: number, flags: number, rtpTs: number, recvUs: number, payload: Buffer): Buffer {
  const h = Buffer.alloc(RECORD_HEADER);
  h.writeUInt32BE(16 + payload.length, 0); h[4] = kind; h[5] = flags; h.writeUInt32BE(rtpTs >>> 0, 8); h.writeBigUInt64BE(BigInt(Math.max(0, Math.round(recvUs))), 12);
  return Buffer.concat([h, payload]);
}

/** NAL units of a 4-byte-length-prefixed access unit. Stops at a truncated unit. */
export function splitNals(au: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let i = 0;
  while (i + 4 <= au.length) {
    const n = au.readUInt32BE(i); i += 4;
    if (n === 0 || i + n > au.length) break;
    out.push(au.subarray(i, i + n)); i += n;
  }
  return out;
}
export function nalType(nal: Buffer): number { return (nal[0] >> 1) & 0x3f; }

/** Length-prefixed access unit → Annex-B (start codes), for tools that want an elementary stream. */
export function toAnnexB(au: Buffer): Buffer {
  const parts: Buffer[] = [];
  const sc = Buffer.from([0, 0, 0, 1]);
  for (const n of splitNals(au)) parts.push(sc, n);
  return Buffer.concat(parts);
}

/** Picture size from an HEVC SPS NAL unit (ITU-T H.265 7.3.2.2): the coded size, and the size after the conformance
 *  window (the visible picture; equal to the coded size when the SPS has no window, as the iPhone's stream does). */
export function parseHevcSps(sps: Buffer): { codedWidth: number; codedHeight: number; width: number; height: number; chromaFormat: number } {
  // RBSP: drop the 2-byte NAL header and the emulation-prevention bytes (00 00 03 → 00 00)
  const rb: number[] = [];
  for (let i = 2, zeros = 0; i < sps.length; i++) {
    const b = sps[i];
    if (zeros >= 2 && b === 3) { zeros = 0; continue; }
    rb.push(b); zeros = b === 0 ? zeros + 1 : 0;
  }
  let pos = 0;
  const bit = () => { if (pos >> 3 >= rb.length) throw new Error('SPS truncated'); const v = (rb[pos >> 3] >> (7 - (pos & 7))) & 1; pos++; return v; };
  const bits = (n: number) => { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + bit(); return v; };
  const ue = () => { let z = 0; while (bit() === 0) { if (++z > 31) throw new Error('bad exp-Golomb code'); } return (2 ** z - 1) + bits(z); };
  bits(4);                              // sps_video_parameter_set_id
  const maxSub = bits(3);               // sps_max_sub_layers_minus1
  bits(1);                              // sps_temporal_id_nesting_flag
  // profile_tier_level(1, maxSub): 88 bits of general profile + 8 bits of general level
  pos += 88; bits(8);
  const subProfile: number[] = [], subLevel: number[] = [];
  for (let i = 0; i < maxSub; i++) { subProfile.push(bit()); subLevel.push(bit()); }
  if (maxSub > 0) for (let i = maxSub; i < 8; i++) bits(2);
  for (let i = 0; i < maxSub; i++) { if (subProfile[i]) pos += 88; if (subLevel[i]) pos += 8; }
  ue();                                 // sps_seq_parameter_set_id
  const chroma = ue();                  // chroma_format_idc
  if (chroma === 3) bit();              // separate_colour_plane_flag
  const codedWidth = ue(), codedHeight = ue();
  let width = codedWidth, height = codedHeight;
  if (bit()) {                          // conformance_window_flag
    const l = ue(), r = ue(), t = ue(), b = ue();
    const subW = chroma === 1 || chroma === 2 ? 2 : 1, subH = chroma === 1 ? 2 : 1;
    width = codedWidth - subW * (l + r); height = codedHeight - subH * (t + b);
  }
  return { codedWidth, codedHeight, width, height, chromaFormat: chroma };
}

/** Continuous presentation time (µs) from the phone's 24 kHz RTP clock: wrap-safe, and rebased on a discontinuity
 *  (a new stream starts its RTP clock anywhere) so time keeps moving forward by the host's arrival time. */
export class RtpClock {
  private ext = 0; private last = 0; private base = 0; private seg = 0; private lastPts = -1; private lastRecv = 0; private started = false;
  pts(rtpTs: number, recvUs: number, discontinuity: boolean): number {
    if (!this.started) { this.started = true; this.ext = rtpTs; this.base = rtpTs; this.seg = 0; }
    else if (discontinuity) { this.ext = rtpTs; this.base = rtpTs; this.seg = this.lastPts + Math.max(1, Math.round((recvUs - this.lastRecv) * 0.024)); }
    else this.ext += ((rtpTs - this.last) << 0);   // signed 32-bit difference
    this.last = rtpTs; this.lastRecv = recvUs;
    let t = this.seg + (this.ext - this.base);
    if (t <= this.lastPts) t = this.lastPts + 1;
    this.lastPts = t;
    return Math.round(t / 0.024);
  }
}

// ── the HEVC feed (public: for a raw /video endpoint and the Mac app's VideoToolbox view) ─────────────────────────────

/** Decoder configuration of the iPhone stream. The coded picture is padded (1328x2896 for a 1320x2868 screen) and the
 *  SPS has no conformance window: show the top-left width x height. */
export interface HevcConfig {
  codec: 'hevc';
  codecString?: string;   // WebCodecs / RFC 6381, e.g. "hev1.1.6.L150.B0" (from pymobiledevice3)
  hvcC?: Buffer;          // ISO/IEC 14496-15 HEVCDecoderConfigurationRecord (from pymobiledevice3)
  vps: Buffer; sps: Buffer; pps: Buffer;
  codedWidth: number; codedHeight: number;
  width: number; height: number;   // the visible picture (= the screen in screenshot pixels, when known)
}
export interface HevcAccessUnit {
  data: Buffer;           // NAL units, each with a 4-byte BE length prefix (hvcC sample format); key units carry VPS/SPS/PPS
  key: boolean;
  discontinuity: boolean; // a new stream: reset the decoder (a key frame follows at once)
  rtpTs: number;          // the phone's 24 kHz RTP timestamp
  ptsUs: number;          // presentation time, µs, continuous across stream restarts (RtpClock)
  recvUs: number;         // host wall-clock µs when it arrived (Date.now() * 1000 scale)
}
export interface HevcVideoFeed {
  onConfig(cb: (c: HevcConfig) => void): void;   // before the first key frame, and whenever the parameter sets change
  onAccessUnit(cb: (au: HevcAccessUnit) => void): void;   // starts at a key frame
  onEnd(cb: (err?: Error) => void): void;
  requestKeyframe(): void;
  stop(): void;
}

interface Consumer { onRecord(r: VideoRecord, cfg: HevcConfig | undefined, cfgChanged: boolean): void; onEnd(err?: Error): void; wantKey: boolean; cfg?: HevcConfig }

/** One phone's access-unit stream, shared by every consumer. Lives while it has consumers. */
class DeviceFeed {
  readonly udid: string;
  readonly consumers = new Set<Consumer>();
  config?: HevcConfig;
  screen?: { width: number; height: number };
  stopHid?: () => void;
  starting?: Promise<void>;
  lastUnitAt = 0;
  units = 0; bytes = 0;
  private reader: RecordReader;
  private watchdog?: NodeJS.Timeout;
  private checking = false;
  private closed = false;
  private readonly sink: HidVideoSink;

  constructor(udid: string) {
    this.udid = udid;
    this.reader = new RecordReader((rec) => this.onRecord(rec));
    this.sink = { onData: (d) => this.onData(d), onClose: (e) => this.close(e) };
  }

  /** Resolves (with the feed the consumer joined) once the sidecar sends video; rejects on stream_busy, no sidecar,
   *  phone gone. A consumer joining a running feed starts at a key frame it asks for. */
  async add(c: Consumer, opts: { steal?: boolean; screen?: { width: number; height: number } }): Promise<DeviceFeed> {
    if (this.closed) return feed(this.udid).add(c, opts);
    if (opts.screen) this.screen = opts.screen;
    this.consumers.add(c);
    if (this.stopHid) { hidKeyframe(this.udid); return this; }
    this.starting ??= (async () => {
      try {
        const stop = await hidVideoStart(this.udid, this.sink, { steal: opts.steal });
        if (this.closed) { stop(); throw new Error('the video feed closed while starting'); }
        this.stopHid = stop;
        this.lastUnitAt = Date.now();
        this.watchdog = setInterval(() => this.check(), 1000);
        this.watchdog.unref?.();
      } finally { this.starting = undefined; }
    })();
    try { await this.starting; } catch (e) { this.remove(c); throw e; }
    return this;
  }

  remove(c: Consumer): void {
    if (!this.consumers.delete(c)) return;
    if (!this.consumers.size) this.close();
  }

  private onData(d: Buffer): void {
    try { this.reader.push(d); } catch (e) { this.close(e as Error); }
  }

  private onRecord(rec: Buffer): void {
    const r = parseVideoRecord(rec);
    if (!r) return;
    if (r.kind === KIND_CONFIG) {
      try { this.config = configFrom(JSON.parse(r.payload.toString('utf8')), this.screen); } catch { /* keep the last */ }
      return;
    }
    if (r.kind !== KIND_ACCESS_UNIT) return;
    this.lastUnitAt = Date.now(); this.units++; this.bytes += r.payload.length;
    const key = (r.flags & FLAG_KEY) !== 0;
    for (const c of [...this.consumers]) {
      if (c.wantKey && !key) continue;
      c.wantKey = false;
      const changed = !!this.config && c.cfg !== this.config;
      c.cfg = this.config;
      try { c.onRecord(r, this.config, changed); } catch { /* a consumer's bug must not stop the others */ }
    }
  }

  /** No access units for STALL_MS: ask the sidecar to switch video on again, which reopens a stale stream, or
   *  answers stream_busy when another client took it (then the consumers end and fall back). */
  private check(): void {
    if (this.closed || this.checking || Date.now() - this.lastUnitAt < STALL_MS) return;
    this.checking = true;
    // same sink: the sidecar re-arms video (reopening a stale stream) without dropping this feed
    hidVideoStart(this.udid, this.sink, { steal: false })
      .then((stop) => { if (this.closed) { stop(); return; } this.stopHid = stop; this.lastUnitAt = Date.now(); for (const c of this.consumers) c.wantKey = true; },
        (e) => this.close(e as Error))
      .finally(() => { this.checking = false; });
  }

  requestKeyframe(): void { hidKeyframe(this.udid); }

  close(err?: Error): void {
    if (this.closed) return;
    this.closed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (feeds.get(this.udid) === this) feeds.delete(this.udid);
    const stop = this.stopHid; this.stopHid = undefined;
    try { stop?.(); } catch { /* */ }
    const cs = [...this.consumers]; this.consumers.clear();
    for (const c of cs) { try { c.onEnd(err); } catch { /* */ } }
  }
}

/** The sidecar's kind-2 JSON → HevcConfig; with the screen size (portrait or not), the visible part of the padded picture. */
export function configFrom(j: any, screen?: { width: number; height: number }): HevcConfig {
  const b = (s: unknown) => Buffer.from(String(s ?? ''), 'base64');
  return { ...hevcConfig(b(j.vps), b(j.sps), b(j.pps), screen), codecString: j.codec, hvcC: j.hvcC ? b(j.hvcC) : undefined };
}

/** The decoder configuration from parameter sets; with the screen size (portrait or not), the visible part of the
 *  padded picture. */
export function hevcConfig(vps: Buffer, sps: Buffer, pps: Buffer, screen?: { width: number; height: number }): HevcConfig {
  const size = parseHevcSps(sps);
  let { width, height } = size;
  if (screen && screen.width > 0 && screen.height > 0) {
    // the phone pads without a conformance window: the screen size (turned like the picture) is what's visible
    const [a, c] = size.codedWidth > size.codedHeight ? [Math.max(screen.width, screen.height), Math.min(screen.width, screen.height)] : [Math.min(screen.width, screen.height), Math.max(screen.width, screen.height)];
    width = Math.min(a, width); height = Math.min(c, height);
  }
  return { codec: 'hevc', vps, sps, pps, codedWidth: size.codedWidth, codedHeight: size.codedHeight, width, height };
}

const feeds = new Map<string, DeviceFeed>();
function feed(udid: string): DeviceFeed {
  let f = feeds.get(udid);
  if (!f) { f = new DeviceFeed(udid); feeds.set(udid, f); }
  return f;
}

/** Raw HEVC access units of the phone's screen (the stream is the one input uses; it stays open while subscribed).
 *  Doesn't take the stream from another client: onEnd gets a stream_busy error instead. */
export function iosHevcFeed(udid: string, opts: { screen?: () => Promise<{ width: number; height: number }> } = {}): HevcVideoFeed {
  const cfgCbs: ((c: HevcConfig) => void)[] = []; const auCbs: ((a: HevcAccessUnit) => void)[] = []; const endCbs: ((e?: Error) => void)[] = [];
  const clock = new RtpClock();
  let ended = false;
  const end = (e?: Error) => { if (ended) return; ended = true; for (const cb of endCbs) cb(e); };
  const c: Consumer = {
    wantKey: true,
    onRecord(r, cfg, changed) {
      if (changed && cfg) for (const cb of cfgCbs) cb(cfg);
      const disc = (r.flags & FLAG_DISCONTINUITY) !== 0;
      const au: HevcAccessUnit = { data: r.payload, key: (r.flags & FLAG_KEY) !== 0, discontinuity: disc, rtpTs: r.rtpTs, recvUs: r.recvUs, ptsUs: clock.pts(r.rtpTs, r.recvUs, disc) };
      for (const cb of auCbs) cb(au);
    },
    onEnd: end,
  };
  let f: DeviceFeed | undefined;
  let stopped = false;
  (async () => {
    const screen = await opts.screen?.().catch(() => undefined);   // the visible size: the phone pads its picture
    if (stopped) return;
    const joined = await feed(udid).add(c, { steal: false, screen });
    if (stopped) joined.remove(c); else f = joined;
  })().catch((e) => end(e as Error));
  return {
    onConfig(cb) { cfgCbs.push(cb); },
    onAccessUnit(cb) { auCbs.push(cb); },
    onEnd(cb) { endCbs.push(cb); },
    requestKeyframe() { f?.requestKeyframe(); },
    stop() { stopped = true; f?.remove(c); f = undefined; end(); },
  };
}

// ── Backend.video: the HEVC stream as VideoPackets (GET /video, the Mac app's VideoToolbox view) ─────────────────

const START = Buffer.from([0, 0, 0, 1]);
const isParamSet = (n: Buffer) => { const t = nalType(n); return t >= 32 && t <= 34; };   // VPS, SPS, PPS
const annexB = (nals: Buffer[]) => Buffer.concat(nals.flatMap((n) => [START, n]));

/** The phone's own stream, not re-encoded, as `GET /v1/devices/:id/video` packets: `screen` (the visible picture, and
 *  the padded `coded` one), `config` (VPS/SPS/PPS, Annex B), then frames from a key frame. The parameter sets come from
 *  the key frames themselves (they change when the phone turns), else from the sidecar's config record.
 *  Never takes the screen stream from another app: it ends with stream_busy instead (the viewer then polls /frame). */
export function iosVideoStream(udid: string, deps: VideoDeps, makeFeed: typeof iosHevcFeed = iosHevcFeed): VideoStream {
  const cbs: ((p: VideoPacket) => void)[] = []; const endCbs: ((e?: Error) => void)[] = [];
  let ended = false;
  let f: HevcVideoFeed | undefined;
  let scr: ScreenInfo | undefined;
  let fromFeed: HevcConfig | undefined;   // the sidecar's config record
  let paramKey: Buffer | undefined;       // the parameter sets now in use (VPS+SPS+PPS)
  let screenPk: VideoPacket | undefined; let configPk: VideoPacket | undefined;
  let frames = 0;
  const send = (p: VideoPacket) => { for (const cb of cbs) { try { cb(p); } catch { /* */ } } };
  const end = (e?: Error) => { if (ended) return; ended = true; const x = f; f = undefined; x?.stop(); for (const cb of endCbs) cb(e); };
  const use = (c: HevcConfig) => {
    const key = Buffer.concat([c.vps, c.sps, c.pps]);
    if (paramKey?.equals(key)) return;
    paramKey = key;
    screenPk = {
      type: 'screen', screen: { width: c.width, height: c.height, scale: scr?.scale, orientation: c.width > c.height ? 'landscape' : 'portrait' },
      video: { width: c.width, height: c.height }, ...(c.codedWidth !== c.width || c.codedHeight !== c.height ? { coded: { width: c.codedWidth, height: c.codedHeight } } : {}),
    };
    configPk = { type: 'config', codec: 'hevc', data: annexB([c.vps, c.sps, c.pps]) };
    send(screenPk); send(configPk);
  };
  setImmediate(() => void (async () => {
    if (ended) return;
    if (!(await deps.capable().catch(() => false))) throw new PhoneDockError('Live video needs iOS 27 or later', 'not_supported', 501, ['Use GET /v1/devices/:id/frame (JPEG) instead.'], 'iPhone live video rides the iOS 27 screen stream (pymobiledevice3)');
    scr = await deps.screen();
    if (ended) return;
    const feed = makeFeed(udid, { screen: async () => scr! });
    f = feed;
    feed.onConfig((c) => { fromFeed = c; });
    feed.onAccessUnit((au) => {
      if (ended) return;
      const nals = splitNals(au.data);
      if (au.discontinuity && frames > 0) { send({ type: 'reset' }); paramKey = undefined; }   // a new stream: decoders start over
      if (au.key) {
        const ps = nals.filter(isParamSet);
        const vps = ps.find((n) => nalType(n) === 32), sps = ps.find((n) => nalType(n) === 33), pps = ps.find((n) => nalType(n) === 34);
        if (vps && sps && pps) { try { use(hevcConfig(vps, sps, pps, scr)); } catch { if (fromFeed) use(fromFeed); } }
        else if (fromFeed) use(fromFeed);
      }
      if (!paramKey) return;   // nothing to decode against yet (the feed starts at a key frame, so this is rare)
      const rest = nals.filter((n) => !isParamSet(n));
      if (!rest.length) return;
      frames++;
      send({ type: 'frame', data: annexB(rest), key: au.key, at: Math.round(au.recvUs / 1000) });
    });
    feed.onEnd((e) => end(e));
  })().catch((e) => end(e as Error)));
  return {
    onPacket(cb) { cbs.push(cb); },
    onEnd(cb) { endCbs.push(cb); },
    stop() { end(); },
    requestKeyFrame() { f?.requestKeyframe(); },
  };
}

// ── the Swift helper (decode → JPEG, or record) ────────────────────────────────────────────────────────────────

function helperSource(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const res = process.env.PHONEDOCK_BUNDLE_RESOURCES;
  return [
    process.env.PHONEDOCK_IOS_VIDEO_SRC,
    resolve(here, '..', '..', 'tools', 'pd-ios-video.swift'),     // repo: src/backends
    resolve(here, '..', 'tools', 'pd-ios-video.swift'),           // app bundle: Resources/{daemon,tools}
    res ? join(res, 'tools', 'pd-ios-video.swift') : undefined,
    resolve(process.cwd(), 'tools', 'pd-ios-video.swift'),
  ].find((c): c is string => !!c && existsSync(c));
}

let building: Promise<string> | undefined;
let built: string | undefined;
/** The compiled helper: stateDir('bin')/pd-ios-video-<source hash> (shared by every checkout with the same source;
 *  an older build is used when swiftc fails). */
export async function videoHelper(): Promise<string> {
  if (built && existsSync(built)) return built;
  const dir = stateDir('bin');
  const older = () => { try { return readdirSync(dir).filter((n) => /^pd-ios-video-[0-9a-f]{12}$/.test(n)).map((n) => join(dir, n)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]; } catch { return undefined; } };
  const src = helperSource();
  if (!src) { const o = older(); if (o) return (built = o); throw new PhoneDockError('Live iPhone video is unavailable', 'ios_video_unavailable', 501, undefined, 'tools/pd-ios-video.swift not found (set PHONEDOCK_IOS_VIDEO_SRC)'); }
  const bin = join(dir, `pd-ios-video-${createHash('sha256').update(readFileSync(src)).digest('hex').slice(0, 12)}`);
  if (existsSync(bin)) return (built = bin);
  building ??= (async () => {
    const tmp = `${bin}.${process.pid}.tmp`;
    try {
      await run('xcrun', ['swiftc', '-O', '-suppress-warnings', '-o', tmp, src], { env: toolEnv(), timeoutMs: 300_000 });
      renameSync(tmp, bin);
      return (built = bin);
    } catch (e) {
      rmSync(tmp, { force: true });
      const o = older(); if (o) return (built = o);
      throw new PhoneDockError('Live iPhone video is unavailable', 'ios_video_unavailable', 501, ['Install Xcode and try again.'], `Building tools/pd-ios-video.swift failed: ${(e as PhoneDockError).detail ?? (e as Error).message}`);
    }
  })().finally(() => { building = undefined; });
  return building;
}
/** Build the helper in the background, so the first viewer doesn't wait for swiftc. */
export function warmVideoHelper(): void { if (process.platform === 'darwin' && !built && !building) videoHelper().catch(() => undefined); }

/** A JPEG frame record from the helper (stdout type 1). */
export function parseHelperFrame(rec: Buffer): { visW: number; visH: number; contentW: number; contentH: number; rtpTs: number; recvUs: number; jpeg: Buffer } | undefined {
  if (rec.length < 5 + 20 || rec[4] !== 1) return undefined;
  return { visW: rec.readUInt16BE(5), visH: rec.readUInt16BE(7), contentW: rec.readUInt16BE(9), contentH: rec.readUInt16BE(11), rtpTs: rec.readUInt32BE(13), recvUs: Number(rec.readBigUInt64BE(17)), jpeg: rec.subarray(25) };
}

// ── FrameStream: JPEGs for /frame, /stream and the app ───────────────────────────────────────────────────────────

export interface VideoDeps {
  /** iOS 27+ with the sidecar available (else: screenshots only). */
  capable(): Promise<boolean>;
  /** The screen in screenshot pixels (portrait), with its point scale. */
  screen(): Promise<ScreenInfo>;
  screenshot(): Promise<Buffer>;
}

export interface VideoStats {
  mode: 'starting' | 'video' | 'screenshots' | 'stopped';
  reason?: string;           // why screenshots
  frames: number;            // JPEGs emitted
  fps: number;               // over the last 5 s
  latencyMs?: number;        // access unit arrival in the sidecar → JPEG in the daemon, median of the last 60
  collapsed: number;         // frames the phone had shrunk into the corner (stretched back)
  startedAt: number;
  firstFrameMs?: number;
}
const statsByUdid = new Map<string, VideoStats>();
export function iosVideoStats(udid: string): VideoStats | undefined { return statsByUdid.get(udid); }

function orientationOf(w: number, h: number): 'portrait' | 'landscape' { return w > h ? 'landscape' : 'portrait'; }

/** PNG → JPEG with the longest side at most maxSize (ffmpeg, else sips). */
async function shotJpeg(png: Buffer, maxSize: number): Promise<Buffer> {
  const { width, height } = pngSize(png);
  const k = Math.max(width, height) / maxSize;
  const w = k > 1 ? Math.max(2, Math.round(width / k / 2) * 2) : width, h = k > 1 ? Math.max(2, Math.round(height / k / 2) * 2) : height;
  const ff = ffmpegBin();
  if (ff) return (await runBuffer(ff, ['-loglevel', 'error', '-f', 'png_pipe', '-i', '-', '-vf', `scale=${w}:${h}`, '-f', 'mjpeg', '-q:v', '7', '-'], { input: png, timeoutMs: 20_000 })).stdout;
  const dir = mkdtempSync(join(tmpdir(), 'pd-iosvid-'));
  try {
    const src = join(dir, 's.png'), dst = join(dir, 's.jpg');
    writeFileSync(src, png);
    await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '70', '-z', String(h), String(w), src, '--out', dst]);
    return readFileSync(dst);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Live JPEG frames of a real iPhone. Video while it can (iOS 27+, nobody else streaming the phone), screenshots
 *  otherwise; never ends by itself. */
export function iosVideoFrameStream(udid: string, opts: { maxSize?: number; fps?: number }, deps: VideoDeps): FrameStream {
  const frameCbs: ((j: Buffer, s?: ScreenInfo) => void)[] = []; const endCbs: ((e?: Error) => void)[] = [];
  const maxSize = Math.max(160, Math.min(opts.maxSize ?? 720, 4096));
  const fps = Math.max(1, Math.min(opts.fps ?? 15, 60));
  const stats: VideoStats = { mode: 'starting', frames: 0, fps: 0, collapsed: 0, startedAt: Date.now() };
  statsByUdid.set(udid, stats);
  let stopped = false;
  let helper: ChildProcess | undefined;
  let consumer: Consumer | undefined;
  let joined: DeviceFeed | undefined;   // the feed `consumer` is in
  let polling = false;
  let retry: NodeJS.Timeout | undefined;
  let retryMs = RETRY_MS;
  let gen = 0;
  const recent: number[] = []; const lat: number[] = [];

  const emit = (jpeg: Buffer, s?: ScreenInfo) => {
    stats.frames++; stats.firstFrameMs ??= Date.now() - stats.startedAt;
    const now = Date.now(); recent.push(now); while (recent.length && now - recent[0] > 5000) recent.shift();
    stats.fps = Math.round((recent.length / 5) * 10) / 10;
    for (const cb of frameCbs) { try { cb(jpeg, s); } catch { /* */ } }
  };

  const stopVideo = () => {
    gen++;
    if (consumer) { const c = consumer, f = joined; consumer = undefined; joined = undefined; f?.remove(c); }
    if (helper) { const h = helper; helper = undefined; try { h.stdin?.end(); } catch { /* */ } setTimeout(() => { if (h.exitCode === null) h.kill('SIGKILL'); }, 2000).unref?.(); }
  };

  /** Screenshots until the video is back (or for good, when it can't work here). */
  const fallback = (reason: string, retryVideo: boolean) => {
    if (stopped) return;
    stopVideo();
    stats.mode = 'screenshots'; stats.reason = reason;
    if (retryVideo && !retry) {
      retry = setTimeout(() => { retry = undefined; void startVideo(); }, retryMs);
      retryMs = Math.min(RETRY_MAX_MS, retryMs * 2);
    }
    if (polling) return;
    polling = true;
    void (async () => {
      let last: Buffer | undefined;
      while (!stopped && stats.mode === 'screenshots') {
        const t0 = Date.now();
        try {
          const png = await deps.screenshot();
          if (stopped || stats.mode !== 'screenshots') break;
          if (!last || !last.equals(png)) {
            last = png;
            const { width, height } = pngSize(png);
            const scr = await deps.screen().catch(() => undefined);
            emit(await shotJpeg(png, maxSize), { width, height, scale: scr?.scale, orientation: orientationOf(width, height) });
          }
        } catch { await sleep(1000); }
        await sleep(Math.max(0, 1000 / Math.min(fps, 5) - (Date.now() - t0)));
      }
      polling = false;
    })();
  };

  const startVideo = async () => {
    if (stopped) return;
    const my = ++gen;
    let scr: ScreenInfo;
    let bin: string;
    try {
      if (!(await deps.capable())) { fallback('live video needs iOS 27 or later and pymobiledevice3', false); return; }
      [bin, scr] = await Promise.all([videoHelper(), deps.screen()]);
    } catch (e) { fallback((e as Error).message, false); return; }
    if (stopped || my !== gen) return;
    const h = spawn(bin, ['--max-size', String(maxSize), '--fps', String(fps), '--quality', '0.7', '--screen', `${scr.width}x${scr.height}`], { stdio: ['pipe', 'pipe', 'pipe'] });
    helper = h;
    let stderr = '';
    h.stderr!.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000); });
    h.stdin!.on('error', () => { /* EPIPE: the exit handler reports it */ });
    let dropping = false;
    const out = new RecordReader((rec) => {
      if (my !== gen) return;
      if (rec[4] === 2) { if (/needKey/.test(rec.subarray(5).toString())) joined?.requestKeyframe(); return; }
      const f = parseHelperFrame(rec);
      if (!f) return;
      lat.push(Date.now() - f.recvUs / 1000); if (lat.length > 60) lat.shift();
      stats.latencyMs = [...lat].sort((a, b) => a - b)[lat.length >> 1];
      if (f.contentW < f.visW || f.contentH < f.visH) stats.collapsed++;
      if (stats.mode !== 'video') { stats.mode = 'video'; stats.reason = undefined; retryMs = RETRY_MS; }
      emit(f.jpeg, { width: f.visW, height: f.visH, scale: scr.scale, orientation: orientationOf(f.visW, f.visH) });
    });
    h.stdout!.on('data', (d: Buffer) => { try { out.push(d); } catch { /* */ } });
    h.on('exit', (code) => { if (my === gen && !stopped) fallback(`the video decoder stopped (exit ${code}): ${stderr.trim().split('\n').pop() ?? ''}`, true); });
    const c: Consumer = {
      wantKey: true,
      onRecord(r) {
        if (my !== gen || !h.stdin || h.stdin.destroyed) return;
        const key = (r.flags & FLAG_KEY) !== 0;
        if (h.stdin.writableLength > HELPER_BACKLOG) { dropping = true; joined?.requestKeyframe(); return; }   // decoder behind
        if (dropping && !key) return;
        dropping = false;
        h.stdin.write(r.raw);
      },
      onEnd(err) {
        if (my !== gen || stopped) return;
        const busy = (err as PhoneDockError | undefined)?.code === 'stream_busy';
        fallback(busy ? 'another app (Xcode Device Hub, iPhone Mirroring) is showing this iPhone' : `the screen stream ended: ${err?.message ?? 'closed'}`, true);
      },
    };
    consumer = c;
    try {
      const f = await feed(udid).add(c, { steal: false, screen: { width: scr.width, height: scr.height } });
      if (my !== gen || stopped || consumer !== c) { f.remove(c); return; }
      joined = f;
    } catch (e) {
      if (my !== gen || stopped) return;
      const busy = (e as PhoneDockError).code === 'stream_busy';
      fallback(busy ? 'another app (Xcode Device Hub, iPhone Mirroring) is showing this iPhone' : (e as Error).message, true);
    }
  };

  void startVideo();
  return {
    onFrame(cb) { frameCbs.push(cb); },
    onEnd(cb) { endCbs.push(cb); },
    stop() {
      if (stopped) return;
      stopped = true; stats.mode = 'stopped';
      if (retry) clearTimeout(retry);
      stopVideo();
      for (const cb of endCbs) cb();
    },
    // A real iPhone turns by itself; the stream's picture turns with it (each frame reports its own orientation).
    restart() { /* nothing to restart */ },
  };
}

// ── recording from the same stream (no re-encode) ────────────────────────────────────────────────────────────

export interface HevcRecording { stop(): Promise<string> }

/** Record the phone's own HEVC stream into `outPath` (.mp4), timed by its RTP clock. Resolves once the first key frame
 *  is being written; rejects (stream_busy, no video, no key frame within 8 s) so the caller can fall back. */
export async function startHevcRecording(udid: string, outPath: string, opts: { maxSeconds: number }, deps: VideoDeps): Promise<HevcRecording> {
  if (!(await deps.capable())) throw new PhoneDockError('Live iPhone video is unavailable', 'ios_video_unavailable', 501, undefined, 'needs iOS 27+ and pymobiledevice3');
  const [bin, scr] = await Promise.all([videoHelper(), deps.screen()]);
  const dir = mkdtempSync(join(tmpdir(), 'pd-iosrec-'));
  const tmp = join(dir, 'rec.mp4');
  const h = spawn(bin, ['--record', tmp, '--screen', `${scr.width}x${scr.height}`], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  h.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
  h.stderr!.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-4000); });
  h.stdin!.on('error', () => { /* reported by the exit code */ });
  const exited = new Promise<number | null>((res) => { h.on('exit', (code) => res(code)); h.on('error', () => res(-1)); });
  let cfg: HevcConfig | undefined;
  let gotKey!: () => void;
  const keyed = new Promise<void>((res) => { gotKey = res; });
  let ended: Error | undefined;
  const c: Consumer = {
    wantKey: true,
    onRecord(r, config) { cfg = config ?? cfg; if (!h.stdin!.destroyed) h.stdin!.write(r.raw); gotKey(); },
    onEnd(err) { ended = err ?? new Error('the screen stream ended'); try { h.stdin!.end(); } catch { /* */ } },
  };
  let f: DeviceFeed | undefined;
  let finished = false;
  const finish = () => { if (finished) return; finished = true; f?.remove(c); try { h.stdin!.end(); } catch { /* */ } };
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    f = await feed(udid).add(c, { steal: false, screen: { width: scr.width, height: scr.height } });
    const ok = await Promise.race([keyed.then(() => true), sleep(8000).then(() => false), exited.then(() => false)]);
    if (!ok) throw new PhoneDockError('The iPhone sent no video', 'record_failed', 502, undefined, `no key frame within 8 s: ${stderr.trim().slice(-300)}`);
  } catch (e) { finish(); h.kill('SIGKILL'); cleanup(); throw e; }
  const limit = setTimeout(finish, opts.maxSeconds * 1000);
  limit.unref?.();
  return {
    async stop() {
      clearTimeout(limit);
      finish();
      const code = await Promise.race([exited, sleep(60_000).then(() => 'timeout' as const)]);
      try {
        if (code === 'timeout') { h.kill('SIGKILL'); throw new PhoneDockError('The recording did not finish in time', 'record_failed', 504, undefined, 'pd-ios-video did not finish within 60 s'); }
        if (code !== 0 || !existsSync(tmp)) throw new PhoneDockError('The recording produced no file', 'record_failed', 502, undefined, `pd-ios-video exited ${code}: ${stderr.trim().slice(-600)}${ended ? ` (stream: ${ended.message})` : ''}`);
        // Bake the crop into the SPS (conformance window) so every player hides the padding, not only the ones that read
        // the mp4's clean aperture; also moves the index to the front (faststart).
        const ff = ffmpegBin();
        const sz = cfg ? { r: cfg.codedWidth - cfg.width, b: cfg.codedHeight - cfg.height } : undefined;
        if (ff) {
          const bsf = sz && (sz.r > 0 || sz.b > 0) ? ['-bsf:v', `hevc_metadata=crop_right=${sz.r}:crop_bottom=${sz.b}`] : [];
          const r = await run(ff, ['-v', 'error', '-y', '-i', tmp, '-c', 'copy', ...bsf, '-tag:v', 'hvc1', '-movflags', '+faststart', `${outPath}.pd-tmp.mp4`], { allowFail: true, timeoutMs: 600_000, env: toolEnv() });
          if (r.code === 0) { renameSync(`${outPath}.pd-tmp.mp4`, outPath); return outPath; }
          rmSync(`${outPath}.pd-tmp.mp4`, { force: true });
        }
        renameSync(tmp, outPath);
        return outPath;
      } finally { cleanup(); }
    },
  };
}

/** For diagnostics: what the shared feed of a phone is doing. */
export function iosFeedStats(udid: string): { consumers: number; units: number; bytes: number; lastUnitAgoMs: number | null; config?: Omit<HevcConfig, 'vps' | 'sps' | 'pps' | 'hvcC'> } | undefined {
  const f = feeds.get(udid);
  if (!f) return undefined;
  const cfg = f.config ? { codec: f.config.codec, codecString: f.config.codecString, codedWidth: f.config.codedWidth, codedHeight: f.config.codedHeight, width: f.config.width, height: f.config.height } : undefined;
  return { consumers: f.consumers.size, units: f.units, bytes: f.bytes, lastUnitAgoMs: f.lastUnitAt ? Date.now() - f.lastUnitAt : null, config: cfg };
}
