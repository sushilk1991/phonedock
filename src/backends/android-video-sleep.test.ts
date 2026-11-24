// The JPEG live view of an Android phone falls back to screenshots when the video source can't run (no ffmpeg, or
// screenrecord fails). It must still know when the phone's display is off: idle sleep counts a watched, lit screen only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fakeAndroidSdk } from './android-fake-sdk.ts';

const sdk = fakeAndroidSdk({ wakefulness: 'Asleep' });
const { adbFrameStream } = await import('./android-video.ts');
const emu = spawn(join(sdk.root, 'emulator', 'emulator'), ['-avd', 'pdtest-v', '-port', '5580'], { stdio: 'ignore' });
after(() => { emu.kill('SIGTERM'); });

test('screenshot fallback: asleep() follows the display, not the encoder (#13)', { timeout: 60_000 }, async () => {
  while (!sdk.state().emulators['emulator-5580']) await new Promise((r) => setTimeout(r, 50));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const s = adbFrameStream('emulator-5580', { fps: 2, capture: async () => png, ffmpeg: null } as Parameters<typeof adbFrameStream>[1]);
  s.onFrame(() => {});
  try {
    const t0 = Date.now();
    while (Date.now() - t0 < 30_000 && !s.asleep?.()) await new Promise((r) => setTimeout(r, 200));
    assert.equal(s.asleep?.(), true, 'the display is off');
  } finally { s.stop(); }
});
