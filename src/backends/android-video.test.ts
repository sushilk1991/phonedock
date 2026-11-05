import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adbVideoStream } from './android-video.ts';

test('a phone that cannot be found (no live adb transport) ends the video stream with that error', async () => {
  const s = adbVideoStream(async () => { throw new Error('The Android device is not connected'); });
  const err = await new Promise<Error | undefined>((r) => s.onEnd(r));
  assert.match(String(err?.message), /not connected/);
});

test('a stream stopped before its serial is found never starts', async () => {
  let resolved = false;
  const s = adbVideoStream(() => new Promise((r) => setTimeout(() => { resolved = true; r('never-started'); }, 20)));
  let ends = 0; s.onEnd(() => ends++);
  await new Promise((r) => setImmediate(r));   // the lookup has begun
  s.stop();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(resolved, true);
  assert.equal(ends, 1);   // stopped once; the late serial didn't start an encoder (that would spawn adb -s never-started)
});
