import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { finalizeMp4, probeVideo } from './ios-common.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

// Android's screenrecord writes a frame only when the screen changes, so recording a still screen for 5 s gives a
// one-frame file. finalizeMp4 must hold that frame until the recording really stopped.
test('finalizeMp4: a one-frame recording is held to the time it really ran', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-finalize-'));
  try {
    const src = join(dir, 'one.mp4'), out = join(dir, 'out.mp4');
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=0.04', '-frames:v', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]);
    assert.equal(r.status, 0, String(r.stderr));
    await finalizeMp4(src, out, { minSeconds: 3 });
    const info = await probeVideo(out);
    assert.ok(info?.duration && Math.abs(info.duration - 3) < 0.25, `duration ${info?.duration}`);
    assert.equal(existsSync(src), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('finalizeMp4: without minSeconds a short file is only remuxed', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-finalize-'));
  try {
    const src = join(dir, 'two.mp4'), out = join(dir, 'out.mp4');
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=1:r=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]);
    assert.equal(r.status, 0, String(r.stderr));
    await finalizeMp4(src, out);
    const info = await probeVideo(out);
    assert.ok(info?.duration && info.duration < 1.5, `duration ${info?.duration}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
