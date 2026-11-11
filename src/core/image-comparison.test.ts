import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { which } from './paths.ts';
import { compareImages } from './image-comparison.ts';

// Small deterministic PNG fixtures, so the test exercises the real decoder rather than mocking its pixels.
function png(width: number, height: number, pixel: (x: number, y: number) => number[]): Buffer {
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const byte of b) { c ^= byte; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (name: string, data: Buffer) => { const h = Buffer.alloc(8); h.writeUInt32BE(data.length); h.write(name, 4); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([h.subarray(4), data]))); return Buffer.concat([h, data, c]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) Buffer.from(pixel(x, y)).copy(raw, y * (width * 4 + 1) + 1 + x * 4);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const white = () => [255, 255, 255, 255];
const hasFfmpeg = !!which('ffmpeg');

test('visual comparison sees color changes and individual full-resolution pixels', { skip: !hasFfmpeg }, async () => {
  const before = png(128, 128, white);
  const after = png(128, 128, (x, y) => x === 5 && y === 9 ? [255, 0, 0, 255] : white());
  assert.equal(await compareImages(before, before), 0);
  assert.equal(await compareImages(before, after), 1 / (128 * 128));
  const red = png(8, 8, () => [255, 0, 0, 255]);
  const green = png(8, 8, () => [0, 130, 0, 255]);
  assert.equal(await compareImages(red, green), 1);
  assert.equal(await compareImages(red, green, { mode: 'thumbnail' }), 0, 'legacy grayscale mode is explicit');
});

test('visual comparison excludes ignored pixels from numerator and denominator', { skip: !hasFfmpeg }, async () => {
  const a = png(2, 1, white), b = png(2, 1, () => [0, 0, 0, 255]);
  assert.equal(await compareImages(a, b, { ignore: [{ x: 0, y: 0, width: 1, height: 1 }] }), 1);
  assert.equal(await compareImages(a, png(2, 1, (x) => x === 0 ? [0, 0, 0, 255] : white()), { ignore: [{ x: 0, y: 0, width: 1, height: 1 }] }), 0);
  await assert.rejects(compareImages(a, b, { ignore: [{ x: 0, y: 0, width: 2, height: 1 }] }), /no pixels left/);
});

test('visual comparison rejects dimension changes, corrupt images and invalid thresholds', async () => {
  await assert.rejects(compareImages(png(1, 1, white), png(2, 1, white)), /dimensions differ/);
  await assert.rejects(compareImages(Buffer.from('not png'), Buffer.from('not png')), /valid PNG/);
  await assert.rejects(compareImages(png(1, 1, white), png(1, 1, white), { pixelThreshold: -1 }), /pixelThreshold/);
});
