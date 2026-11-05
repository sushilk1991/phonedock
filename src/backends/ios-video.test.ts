import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import {
  FLAG_DISCONTINUITY, FLAG_KEY, KIND_ACCESS_UNIT, KIND_CONFIG, RECORD_HEADER, RecordReader, RtpClock, configFrom, iosVideoFrameStream,
  iosVideoStats, iosVideoStream, nalType, parseHelperFrame, parseHevcSps, parseVideoRecord, splitNals, toAnnexB, videoRecord,
} from './ios-video.ts';
import { pymd3Python } from './ios-hid.ts';
import type { VideoPacket } from '../core/types.ts';

const hex = (s: string) => Buffer.from(s, 'hex');
const lp = (...nals: Buffer[]) => Buffer.concat(nals.flatMap((n) => { const l = Buffer.alloc(4); l.writeUInt32BE(n.length); return [l, n]; }));

// SPS NAL units (fixtures): the iPhone 16 Pro Max stream (padded, no conformance window), VideoToolbox's encoder at the
// visible size (with a window), x265 at an odd size.
const SPS_PHONE = hex('420111016000000300b000000300000300964800a62002d45880cee45218b9fc4fc2fe86fd43fea823f5504feaa82bf55505feaaa833f555529b8101010040');
const SPS_VT = hex('420101016000000300b00000030000030096a00298800b41cb3e202fb916452ffcb9fc4feb016a04040401');
const SPS_X265 = hex('4201010408000003009e0800000300007890007810021ceef2cacd24995e02dc08080010000003001000000300a080');
const VPS = hex('40010c01ffff016000000300b0000003000003009695940900');
const PPS = hex('4401c172b46240');
const IDR = hex('2601af1c0ffee0000301d3c0de');   // type 19 (IDR_W_RADL); carries an emulation-prevention byte
const TRAIL = hex('0201d00dfeed');                 // type 1 (TRAIL_R)

test('RecordReader: records split across chunks, several in one chunk, and a bad length', () => {
  const a = videoRecord(KIND_ACCESS_UNIT, FLAG_KEY, 1, 2, lp(IDR));
  const b = videoRecord(KIND_ACCESS_UNIT, 0, 3, 4, lp(TRAIL));
  const all = Buffer.concat([a, b, a]);
  const got: Buffer[] = [];
  const r = new RecordReader((x) => got.push(Buffer.from(x)));
  for (let i = 0; i < all.length; i++) r.push(all.subarray(i, i + 1));   // one byte at a time
  assert.equal(got.length, 3);
  assert.deepEqual(got, [a, b, a]);
  assert.equal(r.pending, 0);

  const got2: Buffer[] = [];
  const r2 = new RecordReader((x) => got2.push(x));
  r2.push(Buffer.concat([a, b, b.subarray(0, 7)]));
  assert.equal(got2.length, 2);
  assert.equal(r2.pending, 7);
  r2.push(b.subarray(7));
  assert.equal(got2.length, 3);

  const r3 = new RecordReader(() => undefined, 1024);
  const bad = Buffer.alloc(8); bad.writeUInt32BE(1 << 30);
  assert.throws(() => r3.push(bad), /bad record length/);
  assert.equal(r3.pending, 0);
});

test('parseVideoRecord: the sidecar header round-trips, a wrong length is refused', () => {
  const payload = lp(VPS, SPS_PHONE, PPS, IDR);
  const rec = videoRecord(KIND_ACCESS_UNIT, FLAG_KEY | FLAG_DISCONTINUITY, 0xfffffff0, 1_762_300_000_123_456, payload);
  assert.equal(rec.length, RECORD_HEADER + payload.length);
  assert.equal(rec.readUInt32BE(0), 16 + payload.length);
  const p = parseVideoRecord(rec)!;
  assert.equal(p.kind, KIND_ACCESS_UNIT);
  assert.equal(p.flags, FLAG_KEY | FLAG_DISCONTINUITY);
  assert.equal(p.rtpTs, 0xfffffff0);
  assert.equal(p.recvUs, 1_762_300_000_123_456);
  assert.deepEqual(p.payload, payload);
  assert.equal(p.raw, rec);
  assert.equal(parseVideoRecord(rec.subarray(0, rec.length - 1)), undefined);
  assert.equal(parseVideoRecord(Buffer.alloc(10)), undefined);
});

test('splitNals / nalType / toAnnexB', () => {
  const au = lp(VPS, SPS_PHONE, PPS, IDR);
  const nals = splitNals(au);
  assert.deepEqual(nals.map(nalType), [32, 33, 34, 19]);
  assert.deepEqual(nals[3], IDR);
  assert.deepEqual(splitNals(au.subarray(0, au.length - 2)).map(nalType), [32, 33, 34]);   // a truncated unit stops
  const annexB = toAnnexB(lp(PPS, TRAIL));
  assert.deepEqual(annexB, Buffer.concat([hex('00000001'), PPS, hex('00000001'), TRAIL]));
});

test('parseHevcSps: coded size and conformance window', () => {
  assert.deepEqual(parseHevcSps(SPS_PHONE), { codedWidth: 1328, codedHeight: 2896, width: 1328, height: 2896, chromaFormat: 1 });
  const vt = parseHevcSps(SPS_VT);
  assert.equal(vt.width, 1320); assert.equal(vt.height, 2868);
  assert.ok(vt.codedWidth >= 1320 && vt.codedHeight >= 2868);
  const x = parseHevcSps(SPS_X265);
  assert.equal(x.width, 1918); assert.equal(x.height, 1078);
  assert.throws(() => parseHevcSps(SPS_PHONE.subarray(0, 12)), /truncated/);
});

test('configFrom: the screen size tells the visible part of the padded picture, in either orientation', () => {
  const j = { codec: 'hev1.1.6.L150.B0', vps: VPS.toString('base64'), sps: SPS_PHONE.toString('base64'), pps: PPS.toString('base64') };
  const c = configFrom(j, { width: 1320, height: 2868 });
  assert.equal(c.codedWidth, 1328); assert.equal(c.codedHeight, 2896);
  assert.equal(c.width, 1320); assert.equal(c.height, 2868);
  assert.equal(c.codecString, 'hev1.1.6.L150.B0');
  assert.deepEqual(c.sps, SPS_PHONE);
  assert.equal(c.hvcC, undefined);
  // a landscape screen size against a portrait picture still crops the right sides
  const l = configFrom(j, { width: 2868, height: 1320 });
  assert.equal(l.width, 1320); assert.equal(l.height, 2868);
  // no screen size: the whole coded picture
  const n = configFrom(j);
  assert.equal(n.width, 1328); assert.equal(n.height, 2896);
});

test('RtpClock: 24 kHz → µs, across the 32-bit wrap, and forward over a new stream', () => {
  const c = new RtpClock();
  assert.equal(c.pts(0xffffff00, 1_000_000, false), 0);
  assert.equal(c.pts(0xffffff00 + 2400, 1_100_000, false), 100_000);          // still below 2^32
  assert.equal(c.pts((0xffffff00 + 4800) >>> 0, 1_200_000, false), 200_000);  // wrapped
  // a new stream: its RTP clock starts anywhere; time continues by the wall-clock gap (0.5 s here)
  assert.equal(c.pts(12345, 1_700_000, true), 700_000);
  assert.equal(c.pts(12345 + 24, 1_700_001, false), 701_000);
  // never backwards, never equal
  const t = c.pts(12345, 1_700_002, false);
  assert.ok(t > 701_000);
});

test('parseHelperFrame: the Swift helper\'s JPEG record', () => {
  const jpeg = hex('ffd8ffe000104a464946ffd9');
  const rec = Buffer.alloc(25 + jpeg.length);
  rec.writeUInt32BE(rec.length - 4, 0); rec[4] = 1;
  rec.writeUInt16BE(1320, 5); rec.writeUInt16BE(2868, 7); rec.writeUInt16BE(660, 9); rec.writeUInt16BE(1434, 11);
  rec.writeUInt32BE(0xdeadbeef, 13); rec.writeBigUInt64BE(1_762_300_000_000_001n, 17); jpeg.copy(rec, 25);
  assert.deepEqual(parseHelperFrame(rec), { visW: 1320, visH: 2868, contentW: 660, contentH: 1434, rtpTs: 0xdeadbeef, recvUs: 1_762_300_000_000_001, jpeg });
  const ev = Buffer.concat([Buffer.from([0, 0, 0, 17, 2]), Buffer.from('{"needKey":true}')]);
  assert.equal(parseHelperFrame(ev), undefined);
});

// The sidecar's RTP → access-unit path (tools/pd-ios-hid.py Stream._drain + Video.unit), fed synthetic RTP packets
// through a fake transport: sync at a marker, an aggregation packet, a fragmented IDR, a header extension, RTCP mixed in,
// the 16-bit sequence wrap, a lost packet (unit dropped, PLI sent, deltas held back until the next key frame).
const py = pymd3Python();
const script = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'pd-ios-hid.py');
test('pd-ios-hid.py: RTP/HEVC → video fd records', { skip: !py && 'pymobiledevice3 not installed' }, () => {
  const prog = String.raw`
import asyncio, importlib.util, json, os, struct, sys
spec = importlib.util.spec_from_file_location("pdhid", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
N = {k: bytes.fromhex(v) for k, v in json.loads(sys.argv[2]).items()}
seq = 65530
def rtp(payload, ts, marker=False, ext=False):
    global seq
    h = struct.pack("!BBHII", 0x80 | (0x10 if ext else 0), (0x80 if marker else 0) | 100, seq & 0xFFFF, ts, 0x22222222)
    seq += 1
    if ext: h += struct.pack("!HH", 0xBEDE, 1) + b"\0\0\0\0"
    return h + payload
def ap(*nals): return bytes([48 << 1, 1]) + b"".join(len(n).to_bytes(2, "big") + n for n in nals)
def fu(nal, parts):
    t = (nal[0] >> 1) & 0x3F; body = nal[2:]; k = (len(body) + parts - 1) // parts; out = []
    for i in range(parts):
        fh = t | (0x80 if i == 0 else 0) | (0x40 if i == parts - 1 else 0)
        out.append(bytes([(nal[0] & 0x81) | (49 << 1), nal[1], fh]) + body[i * k:(i + 1) * k])
    return out
rtcp = bytes([0x80, 200]) + b"\0" * 26
pk = [rtp(N["trail"], 900), rtp(N["trail"], 900, marker=True)]            # before sync: dropped
f = fu(N["idr"], 3)
pk += [rtp(ap(N["vps"], N["sps"], N["pps"]), 1000), rtp(f[0], 1000), rtcp, rtp(f[1], 1000), rtp(f[2], 1000, marker=True)]  # A: key
pk += [rtp(N["trail"], 1400, marker=True, ext=True)]                     # B: delta (seq 0 after the wrap)
pk += [rtp(N["trail"], 1800)]; seq += 1; pk += [rtp(N["trail"], 1800, marker=True)]  # C: a packet lost
pk += [rtp(N["trail"], 2200, marker=True)]                               # D: delta while waiting for a key
pk += [rtp(ap(N["vps"], N["sps"], N["pps"], N["idr"]), 2600, marker=True)]  # E: key, same parameter sets
class T:
    def __init__(s, p): s.p = list(p); s.sent = []
    async def recv(s):
        if not s.p: raise OSError("eof")
        return s.p.pop(0)
    async def sendto(s, d, ip, port): s.sent.append(d.hex())
class Out:
    def __init__(s): s.recs = []
    def put(s, r): s.recs.append(r); return True
async def go():
    v = m.Video(Out()); v.start()
    st = m.Stream(None, v); st.transport = T(pk); st.dest = ("127.0.0.1", 9); st.ours = 0x11111111; st.dev = 0x22222222
    await st._drain(); await asyncio.sleep(0.01)
    sys.stdout.buffer.write(b"".join(v.out.recs)); sys.stdout.buffer.flush()
    r, w = os.pipe(); vo = m.VideoOut(w); vo.put(b"\0\0\0\x02hi"); vo.put(b"\0\0\0\x01!")
    got = b""
    while len(got) < 11: got += os.read(r, 64)
    sys.stderr.write(json.dumps({"sent": st.transport.sent, "stats": v.stats(), "pipe": got.hex()}))
asyncio.run(go())
`;
  const nals = { vps: VPS.toString('hex'), sps: SPS_PHONE.toString('hex'), pps: PPS.toString('hex'), idr: IDR.toString('hex'), trail: TRAIL.toString('hex') };
  const r = spawnSync(py!, ['-I', '-B', '-c', prog, script, JSON.stringify(nals)], { timeout: 30_000 });
  assert.equal(r.status, 0, String(r.stderr));
  const side = JSON.parse(String(r.stderr));
  const recs: Buffer[] = [];
  new RecordReader((x) => recs.push(Buffer.from(x))).push(r.stdout);
  const parsed = recs.map((x) => parseVideoRecord(x)!);
  assert.deepEqual(parsed.map((p) => [p.kind, p.flags, p.rtpTs]), [
    [KIND_CONFIG, 0, 1000],
    [KIND_ACCESS_UNIT, FLAG_KEY | FLAG_DISCONTINUITY, 1000],
    [KIND_ACCESS_UNIT, 0, 1400],
    [KIND_ACCESS_UNIT, FLAG_KEY, 2600],
  ]);
  assert.deepEqual(splitNals(parsed[1].payload), [VPS, SPS_PHONE, PPS, IDR]);   // the fragmented IDR reassembled
  assert.deepEqual(splitNals(parsed[2].payload), [TRAIL]);                      // the header extension skipped
  assert.deepEqual(splitNals(parsed[3].payload), [VPS, SPS_PHONE, PPS, IDR]);
  const cfg = configFrom(JSON.parse(parsed[0].payload.toString('utf8')), { width: 1320, height: 2868 });
  assert.deepEqual(cfg.vps, VPS); assert.deepEqual(cfg.sps, SPS_PHONE); assert.deepEqual(cfg.pps, PPS);
  assert.match(cfg.codecString ?? '', /^hev1\./);
  assert.equal(cfg.width, 1320);
  // one PLI for the lost packet (RFC 4585: V=2 FMT=1, PT 206, length 2, our SSRC, the phone's)
  assert.deepEqual(side.sent, ['81ce00021111111122222222']);
  assert.equal(side.stats.units, 3); assert.equal(side.stats.keys, 2); assert.equal(side.stats.lost, 1); assert.equal(side.stats.keyRequests, 1);
  assert.equal(side.pipe, '0000000268690000000121');
});

/** A w x h grey RGB PNG. */
function png(w: number, h: number, v = 128): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.alloc((w * 3 + 1) * h, v); for (let y = 0; y < h; y++) rows[y * (w * 3 + 1)] = 0;
  return Buffer.concat([hex('89504e470d0a1a0a'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

test('iosVideoFrameStream: older iOS gets screenshots (JPEG, screen size, orientation)', async () => {
  let shots = 0;
  const s = iosVideoFrameStream('pdtest-old-ios', { maxSize: 64, fps: 5 }, {
    capable: async () => false,
    screen: async () => ({ width: 40, height: 80, scale: 2 }),
    screenshot: async () => { shots++; return png(40, 80, 100 + shots); },
  });
  const frames: { jpeg: Buffer; s?: { width: number; height: number; orientation?: string; scale?: number } }[] = [];
  s.onFrame((jpeg, scr) => frames.push({ jpeg, s: scr }));
  const t0 = Date.now();
  while (frames.length < 2 && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 50));
  assert.equal(iosVideoStats('pdtest-old-ios')!.mode, 'screenshots');
  assert.match(iosVideoStats('pdtest-old-ios')!.reason ?? '', /iOS 27/);
  let ended = false; s.onEnd(() => { ended = true; });
  s.stop();
  assert.ok(frames.length >= 2, `frames: ${frames.length}`);
  assert.equal(frames[0].jpeg[0], 0xff); assert.equal(frames[0].jpeg[1], 0xd8);   // JPEG
  assert.deepEqual(frames[0].s, { width: 40, height: 80, scale: 2, orientation: 'portrait' });
  assert.equal(ended, true);
  const st = iosVideoStats('pdtest-old-ios')!;
  assert.equal(st.mode, 'stopped');
  assert.ok(st.frames >= 2);
});

/** A stand-in for the phone's shared feed: the test pushes access units into it. */
function fakeFeed() {
  const au: ((a: any) => void)[] = []; const end: ((e?: Error) => void)[] = [];
  let keyRequests = 0; let stopped = false;
  const make = () => ({
    onConfig() { /* parameter sets come from the key frames */ }, onAccessUnit(cb: (a: any) => void) { au.push(cb); }, onEnd(cb: (e?: Error) => void) { end.push(cb); },
    requestKeyframe() { keyRequests++; }, stop() { stopped = true; },
  });
  let t = 0;
  const push = (data: Buffer, key: boolean, discontinuity = false) => { t += 16_667; for (const cb of au) cb({ data, key, discontinuity, rtpTs: 0, ptsUs: t, recvUs: 1_700_000_000_000_000 + t }); };
  return { make, push, end: (e?: Error) => { for (const cb of end) cb(e); }, keyRequests: () => keyRequests, stopped: () => stopped };
}
const phoneDeps = { capable: async () => true, screen: async () => ({ width: 1320, height: 2868, scale: 3 }), screenshot: async () => Buffer.alloc(0) };
const annexB = (...n: Buffer[]) => Buffer.concat(n.flatMap((x) => [Buffer.from([0, 0, 0, 1]), x]));

test('iosVideoStream: screen (visible + padded size), config from the key frame, frames without parameter sets', async () => {
  const f = fakeFeed();
  const s = iosVideoStream('u', phoneDeps, f.make as any);
  const got: VideoPacket[] = []; s.onPacket((p) => got.push(p));
  await new Promise((r) => setTimeout(r, 10));
  f.push(lp(VPS, SPS_PHONE, PPS, IDR), true);
  f.push(lp(TRAIL), false);
  assert.deepEqual(got.map((p) => p.type), ['screen', 'config', 'frame', 'frame']);
  const scr = got[0] as Extract<VideoPacket, { type: 'screen' }>;
  assert.deepEqual(scr.video, { width: 1320, height: 2868 });
  assert.deepEqual(scr.coded, { width: 1328, height: 2896 });
  assert.equal(scr.screen.scale, 3); assert.equal(scr.screen.orientation, 'portrait');
  const cfg = got[1] as Extract<VideoPacket, { type: 'config' }>;
  assert.equal(cfg.codec, 'hevc'); assert.deepEqual(cfg.data, annexB(VPS, SPS_PHONE, PPS));
  const [k, p] = got.slice(2) as Extract<VideoPacket, { type: 'frame' }>[];
  assert.deepEqual(k.data, annexB(IDR)); assert.equal(k.key, true);
  assert.deepEqual(p.data, annexB(TRAIL)); assert.equal(p.key, false);
  assert.equal(k.at, 1_700_000_000_000 + 17);   // when it reached the Mac (ms), not when the daemon sent it
  s.requestKeyFrame?.(); assert.equal(f.keyRequests(), 1);
  s.stop(); assert.equal(f.stopped(), true);
});

test('iosVideoStream: the same parameter sets again send nothing new; a new stream resets the decoder', async () => {
  const f = fakeFeed();
  const s = iosVideoStream('u', phoneDeps, f.make as any);
  const got: string[] = []; s.onPacket((p) => got.push(p.type));
  await new Promise((r) => setTimeout(r, 10));
  f.push(lp(VPS, SPS_PHONE, PPS, IDR), true);
  f.push(lp(VPS, SPS_PHONE, PPS, IDR), true);           // a requested key frame: same settings
  f.push(lp(VPS, SPS_PHONE, PPS, IDR), true, true);     // the stream reopened
  assert.deepEqual(got, ['screen', 'config', 'frame', 'frame', 'reset', 'screen', 'config', 'frame']);
});

test('iosVideoStream: an older iPhone (no screen stream) ends with not_supported; the feed ending ends it', async () => {
  const s1 = iosVideoStream('u', { ...phoneDeps, capable: async () => false }, fakeFeed().make as any);
  const e1 = await new Promise<any>((r) => s1.onEnd(r));
  assert.equal(e1?.code, 'not_supported');
  const f = fakeFeed();
  const s2 = iosVideoStream('u', phoneDeps, f.make as any);
  const ended = new Promise<any>((r) => s2.onEnd(r));
  await new Promise((r) => setTimeout(r, 10));
  const busy = Object.assign(new Error('another app is showing the screen'), { code: 'stream_busy' });
  f.end(busy);
  assert.equal((await ended)?.code, 'stream_busy');
});
