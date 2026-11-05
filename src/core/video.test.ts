import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AccessUnitAssembler, encodeVideoPacket, GopCache, h264NalInfo, hevcNalInfo, joinNals, pingMessage, splitNals, startsWithStartCode,
  stillMessage, VideoFanout, VideoMessageReader, VIDEO_FLAG, VIDEO_HEADER_BYTES, VIDEO_MSG, type AccessUnit, type FramePacket, type VideoSink,
} from './video.ts';
import type { VideoPacket } from './types.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SC = [0, 0, 0, 1];
// H.264 NAL units: SPS (7), PPS (8), IDR slice (5), non-IDR slice (1); 0x88 / 0x9a: first_mb_in_slice = 0
const SPS = [0x67, 0x42, 0xc0, 0x1f, 0xda];
const PPS = [0x68, 0xce, 0x3c, 0x80];
const IDR = (n: number) => [0x65, 0x88, 0x84, ...Array.from({ length: n }, (_v, i) => (i % 250) + 1)];
const P = (tag: number, n = 6) => [0x41, 0x9a, tag, ...Array.from({ length: n }, (_v, i) => ((i + tag) % 250) + 1)];
const P2 = (tag: number) => [0x41, 0x42, tag, 7, 7];   // a second slice of a picture (first_mb_in_slice ≠ 0)
const bytes = (...nals: number[][]) => Buffer.from(nals.flatMap((n) => [...SC, ...n]));

function collect(idleMs = 8) {
  const out: AccessUnit[] = [];
  const a = new AccessUnitAssembler((u) => out.push(u), { idleMs, now: () => 1000 });
  return { a, out };
}
const hex = (u: AccessUnit) => u.nals.map((n) => n.toString('hex'));

test('startsWithStartCode / splitNals / joinNals', () => {
  assert.equal(startsWithStartCode(Buffer.from([0, 0, 1, 0x65])), true);
  assert.equal(startsWithStartCode(Buffer.from([0, 0, 0, 1, 0x41])), true);
  assert.equal(startsWithStartCode(Buffer.from([0, 0, 0, 0x41])), false);
  const b = Buffer.from([0, 0, 1, ...SPS, 0, 0, 0, 1, ...PPS, 0, 0 /* trailing zeros */, 0, 0, 1, ...IDR(3)]);
  const nals = splitNals(b);
  assert.deepEqual(nals.map((n) => [...n]), [SPS, PPS, IDR(3)]);
  assert.ok(joinNals(nals).equals(bytes(SPS, PPS, IDR(3))));
});

test('NAL info: H.264 and HEVC types, key frames, first slices', () => {
  assert.deepEqual(h264NalInfo(Buffer.from(SPS)), { vcl: false, key: false, param: true, auStart: true, firstSlice: false });
  assert.equal(h264NalInfo(Buffer.from(IDR(1))).key, true);
  assert.equal(h264NalInfo(Buffer.from(P(1))).firstSlice, true);
  assert.equal(h264NalInfo(Buffer.from(P2(1))).firstSlice, false);
  // HEVC: VPS 32 (0x40 0x01), IDR_W_RADL 19 (0x26 0x01) with first_slice_segment_in_pic_flag, TRAIL_R 1 (0x02 0x01)
  assert.equal(hevcNalInfo(Buffer.from([0x40, 0x01, 0x0c])).param, true);
  assert.deepEqual(hevcNalInfo(Buffer.from([0x26, 0x01, 0xaf])), { vcl: true, key: true, param: false, auStart: false, firstSlice: true });
  assert.equal(hevcNalInfo(Buffer.from([0x02, 0x01, 0x40])).firstSlice, false);
});

test('assembler: a picture is emitted as soon as the next one begins; the last one after the input goes quiet', async () => {
  const { a, out } = collect();
  a.push(bytes(SPS, PPS, IDR(20)));          // screenrecord's first write: parameter sets and the key frame
  assert.equal(out.length, 0);
  a.push(bytes(P(1)));                        // the next picture starts: the first is complete
  assert.equal(out.length, 1);
  assert.deepEqual(hex(out[0]), [SPS, PPS, IDR(20)].map((n) => Buffer.from(n).toString('hex')));
  assert.equal(out[0].key, true);
  a.push(bytes(P(2)));
  assert.equal(out.length, 2);
  assert.equal(out[1].key, false);
  await sleep(25);                            // a still screen: nothing more comes
  assert.equal(out.length, 3);
  assert.deepEqual(hex(out[2]), [Buffer.from(P(2)).toString('hex')]);
  a.stop();
});

test('assembler: chunks split anywhere (inside NAL units and start codes) give the same pictures', async () => {
  const stream = Buffer.concat([bytes(SPS, PPS, IDR(300)), bytes(P(1, 200)), bytes(P(2, 50)), bytes(P(3, 9))]);
  for (const size of [1, 2, 3, 5, 7, 64, 1000]) {
    const { a, out } = collect(1000);
    for (let i = 0; i < stream.length; i += size) a.push(stream.subarray(i, i + size));
    a.flush();
    assert.equal(out.length, 4, `chunk size ${size}`);
    assert.deepEqual(out.map((u) => u.nals.length), [3, 1, 1, 1]);
    assert.deepEqual([...out[3].nals[0]], P(3, 9));
    assert.ok(out.every((u) => !u.repair));
  }
});

test('assembler: leading bytes before the first start code (an error message) are skipped', () => {
  const { a, out } = collect(1000);
  a.push(Buffer.from('ERROR: something\n'));
  a.push(bytes(SPS, PPS, IDR(4), P(1)));
  a.flush();
  assert.equal(out.length, 2);
  assert.equal(out[0].nals.length, 3);
});

test('assembler: a write split by a gap longer than idleMs is emitted again, whole, as a repair', async () => {
  const { a, out } = collect(5);
  a.push(bytes(SPS, PPS, IDR(10)));
  a.push(bytes(P(1)));
  const big = bytes(P(2, 400));
  a.push(big.subarray(0, 100));
  await sleep(20);                            // the idle timer takes the first 100 bytes for a whole picture…
  assert.equal(out.length, 2 + 1);
  assert.equal(out[2].nals[0].length, 100 - 4);
  a.push(big.subarray(100));                  // …but the rest of it arrives
  a.push(bytes(P(3)));
  assert.equal(out.length, 4);
  assert.equal(out[3].repair, true);
  assert.deepEqual([...out[3].nals[0]], P(2, 400));
  assert.equal(a.truncations, 1);
  assert.ok(a.idleMs > 5, 'waits longer from now on');
  a.flush();
  assert.equal(out.length, 5);
  assert.equal(out[4].repair, undefined);
});

test('assembler: a second slice arriving after the idle timer reopens the picture', async () => {
  const { a, out } = collect(5);
  a.push(bytes(SPS, PPS, IDR(10)));
  a.push(bytes(P(1)));
  await sleep(15);
  assert.equal(out.length, 2);
  a.push(bytes(P2(1)));                       // same picture, slice 2
  a.push(bytes(P(2)));
  assert.equal(out.length, 3);
  assert.equal(out[2].repair, true);
  assert.deepEqual(out[2].nals.map((n) => [...n]), [P(1), P2(1)]);
  a.stop();
});

test('assembler: a start code split across the idle timer is not a truncation', async () => {
  const { a, out } = collect(5);
  a.push(Buffer.concat([bytes(SPS, PPS, IDR(10)), Buffer.from([0, 0])]));   // ends with half a start code
  await sleep(15);
  assert.equal(out.length, 1);
  assert.deepEqual([...out[0].nals[2]], IDR(10));
  a.push(Buffer.from([0, 1, ...P(1)]));
  a.flush();
  assert.equal(out.length, 2);
  assert.equal(out[1].repair, undefined);
  assert.equal(a.truncations, 0);
});

const frame = (tag: number, key = false, n = 10): FramePacket => ({ type: 'frame', data: Buffer.alloc(n, tag), key, at: tag });
const config: VideoPacket = { type: 'config', codec: 'h264', data: bytes(SPS, PPS) };
const screen: VideoPacket = { type: 'screen', screen: { width: 1080, height: 2400, scale: 1 }, video: { width: 720, height: 1600 }, rotation: 0 };

test('GopCache: key frames restart it, a new config drops frames, catch-up marks all but the newest as replay', () => {
  const c = new GopCache(1000, 10);
  c.add(frame(1));                                   // nothing to decode it against
  assert.equal(c.frames.length, 0);
  c.add(screen); c.add(config); c.add(frame(2, true)); c.add(frame(3)); c.add(frame(4));
  assert.equal(c.decodable, true);
  const cu = c.catchUp();
  assert.deepEqual(cu.map((p) => p.type), ['screen', 'config', 'frame', 'frame', 'frame']);
  assert.deepEqual(cu.slice(2).map((p) => (p as FramePacket).replay), [true, true, undefined]);
  c.add(frame(5, true));
  assert.deepEqual(c.frames.map((f) => f.at), [5]);
  c.add(config);                                     // same parameter sets: frames stay
  assert.equal(c.frames.length, 1);
  c.add({ type: 'config', codec: 'h264', data: bytes(SPS, [0x68, 1]) });
  assert.equal(c.frames.length, 0);
  assert.equal(c.decodable, false);
});

test('GopCache: past its bounds it gives up until the next key frame; replaceLast swaps the newest frame', () => {
  const c = new GopCache(100, 5);
  c.add(config); c.add(frame(1, true, 10));
  for (let i = 2; i <= 5; i++) c.add(frame(i));
  assert.equal(c.frames.length, 5);
  c.add(frame(6));
  assert.equal(c.overflowed, true);
  assert.equal(c.decodable, false);
  c.add(frame(7));
  assert.equal(c.frames.length, 0);
  c.add(frame(8, true));
  assert.equal(c.overflowed, false);
  assert.equal(c.decodable, true);
  assert.equal(c.replaceLast(frame(9, true, 30)), true);
  assert.equal(c.bytes, 30);
  assert.equal(c.frames[0].at, 9);
});

function sink(backlog = () => 0) {
  const got: VideoPacket[] = [];
  const s: VideoSink & { got: VideoPacket[] } = { got, packet: (p) => { got.push(p); }, backlog };
  return s;
}
const kinds = (ps: VideoPacket[]) => ps.map((p) => (p.type === 'frame' ? `f${p.at}${p.key ? 'k' : ''}${p.replay ? 'r' : ''}` : p.type));

test('VideoFanout: a sink that joins mid-stream gets the catch-up, then live frames', () => {
  const f = new VideoFanout();
  const a = sink();
  f.add(a);
  f.packet(screen); f.packet(config); f.packet(frame(1, true)); f.packet(frame(2));
  const b = sink();
  f.add(b);
  f.packet(frame(3));
  assert.deepEqual(kinds(a.got), ['screen', 'config', 'f1k', 'f2', 'f3']);
  assert.deepEqual(kinds(b.got), ['screen', 'config', 'f1kr', 'f2', 'f3']);
});

test('VideoFanout: without a key frame to replay, a new sink waits for the next one (and asks for it)', () => {
  const f = new VideoFanout(new GopCache(100, 3));
  let asked = 0; f.onNeedKeyFrame = () => { asked++; };
  f.packet(screen); f.packet(config); f.packet(frame(1, true));
  for (let i = 2; i <= 5; i++) f.packet(frame(i));   // overflows
  const s = sink();
  f.add(s);
  assert.equal(asked, 1);
  assert.equal(f.stateOf(s), 'waitkey');
  f.packet(frame(6));
  f.packet(frame(7, true)); f.packet(frame(8));
  assert.deepEqual(kinds(s.got), ['screen', 'config', 'f7k', 'f8']);
  assert.equal(f.stateOf(s), 'live');
});

test('VideoFanout: a slow sink skips frames, never queues them, and resyncs once drained', () => {
  const f = new VideoFanout(new GopCache(), { high: 100, low: 10 });
  let queued = 0;
  const slow = sink(() => queued);
  const fast = sink();
  f.add(slow); f.add(fast);
  f.packet(screen); f.packet(config); f.packet(frame(1, true)); f.packet(frame(2));
  queued = 500;                                        // its socket stops draining
  f.packet(frame(3)); f.packet(frame(4)); f.packet(frame(5));
  assert.equal(f.stateOf(slow), 'lagging');
  assert.deepEqual(kinds(slow.got), ['screen', 'config', 'f1k', 'f2']);
  queued = 0;
  f.drained(slow);                                     // drained: reset + the frames since the key frame
  assert.deepEqual(kinds(slow.got).slice(4), ['reset', 'screen', 'config', 'f1kr', 'f2r', 'f3r', 'f4r', 'f5']);
  f.packet(frame(6));
  assert.equal(kinds(slow.got).at(-1), 'f6');
  assert.deepEqual(kinds(fast.got), ['screen', 'config', 'f1k', 'f2', 'f3', 'f4', 'f5', 'f6']);
  assert.equal(f.dropped, 3);
});

test('VideoFanout: a repaired frame resyncs every sink from the corrected cache', () => {
  const f = new VideoFanout();
  const s = sink();
  f.add(s);
  f.packet(config); f.packet(frame(1, true)); f.packet(frame(2, false, 3));
  f.repair(frame(2, false, 9));
  assert.deepEqual(kinds(s.got), ['config', 'f1k', 'f2', 'reset', 'config', 'f1kr', 'f2']);
  assert.equal((s.got.at(-1) as FramePacket).data.length, 9);
});

test('wire format: packets survive any chunking; header fields as documented', () => {
  const packets: VideoPacket[] = [screen, config, { ...frame(7, true), at: 1_700_000_000_123.456 }, { ...frame(8), replay: true }, { type: 'state', state: 'asleep' }, { type: 'reset' }];
  const wire = Buffer.concat([...packets.flatMap(encodeVideoPacket), pingMessage(5), ...stillMessage(Buffer.from('PNG'), 6)]);
  for (const size of [1, 3, 16, 17, 1000]) {
    const r = new VideoMessageReader();
    const msgs = [];
    for (let i = 0; i < wire.length; i += size) msgs.push(...r.push(wire.subarray(i, i + size)));
    assert.deepEqual(msgs.map((m) => m.type), [VIDEO_MSG.screen, VIDEO_MSG.config, VIDEO_MSG.frame, VIDEO_MSG.frame, VIDEO_MSG.state, VIDEO_MSG.reset, VIDEO_MSG.ping, VIDEO_MSG.still]);
    assert.ok(msgs.every((m) => m.version === 1));
    assert.deepEqual(JSON.parse(msgs[0].payload.toString()), { width: 1080, height: 2400, videoWidth: 720, videoHeight: 1600, rotation: 0, orientation: null, density: null });
    assert.equal(msgs[1].flags, 0);                                   // H.264
    assert.ok(msgs[1].payload.equals(bytes(SPS, PPS)));
    assert.equal(msgs[2].flags, VIDEO_FLAG.key);
    assert.equal(msgs[2].tsUs, 1_700_000_000_123_456n);
    assert.equal(msgs[3].flags, VIDEO_FLAG.replay);
    assert.deepEqual(JSON.parse(msgs[4].payload.toString()), { state: 'asleep' });
    assert.equal(msgs[5].payload.length, 0);
    assert.equal(msgs[7].payload.toString(), 'PNG');
  }
  const h = encodeVideoPacket(frame(1, true, 5))[0];
  assert.equal(h.length, VIDEO_HEADER_BYTES);
  assert.equal(h.readUInt32BE(4), 5);
});
