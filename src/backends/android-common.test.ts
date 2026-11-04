import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appFixedOrientation, clockOffsetFrom, imeFrameFrom, H264Flusher, H264_AUD, orientationOf, parseCurrentSize, parseDisplayChange, parseRotation, rotationFor, rotationPending, startsWithStartCode } from './android-common.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('startsWithStartCode: 3- and 4-byte Annex B start codes only', () => {
  assert.equal(startsWithStartCode(Buffer.from([0, 0, 1, 0x65])), true);
  assert.equal(startsWithStartCode(Buffer.from([0, 0, 0, 1, 0x41])), true);
  assert.equal(startsWithStartCode(Buffer.from([0, 0, 0, 0x41])), false);
  assert.equal(startsWithStartCode(Buffer.from([0x88, 0, 0, 1])), false);
  assert.equal(startsWithStartCode(Buffer.from([0, 0])), false);
});

test('H264Flusher: forwards chunks and appends one AUD after the input goes quiet', async () => {
  const out: Buffer[] = [];
  const f = new H264Flusher((b) => out.push(b), 10);
  f.push(Buffer.from([0, 0, 0, 1, 0x67, 1])); f.push(Buffer.from([2, 3]));   // one access unit split in two writes
  assert.equal(out.length, 2);
  await sleep(30);
  assert.equal(out.length, 3);
  assert.ok(out[2].equals(H264_AUD));
  await sleep(30);
  assert.equal(out.length, 3);                                               // only one AUD per quiet period
  f.stop();
});

test('H264Flusher: reports an AUD that landed inside a NAL unit; stop() cancels a pending AUD', async () => {
  let splits = 0;
  const out: Buffer[] = [];
  const f = new H264Flusher((b) => out.push(b), 5, () => { splits++; });
  f.push(Buffer.from([0, 0, 0, 1, 0x41, 9]));
  await sleep(20);
  f.push(Buffer.from([0, 0, 0, 1, 0x41, 9]));   // starts with a start code: fine
  assert.equal(splits, 0);
  await sleep(20);
  f.push(Buffer.from([7, 7, 7]));               // continuation of a NAL after the AUD: split
  assert.equal(splits, 1);
  f.stop();
  const n = out.length;
  await sleep(20);
  assert.equal(out.length, n);
});

test('clockOffsetFrom: device clock behind the host gives a positive offset', () => {
  // Asked at …396.000 s and answered at …396.040 s (host); the device said …388.300 s → the host is 7.72 s ahead.
  assert.equal(clockOffsetFrom('1793731388.300000000\n', 1_793_731_396_000, 1_793_731_396_040), 7_720);
});

test('clockOffsetFrom: device clock ahead of the host gives a negative offset', () => {
  assert.equal(clockOffsetFrom('1793731400.500000000', 1_793_731_390_000, 1_793_731_390_000), -10_500);
});

test('clockOffsetFrom: seconds-only date (no %N) assumes mid-second; garbage gives 0', () => {
  assert.equal(clockOffsetFrom('1793731388.N', 1_793_731_396_500, 1_793_731_396_500), 8_000);
  assert.equal(clockOffsetFrom('date: unknown option', 1, 2), 0);
  assert.equal(clockOffsetFrom('', 1, 2), 0);
});

test('rotationFor: quarter turns that show the wanted orientation, keeping the current turn when it already does', () => {
  // phone: natural portrait 1080x2424
  assert.equal(rotationFor('landscape', { width: 1080, height: 2424, rotation: 0 }), 1);
  assert.equal(rotationFor('portrait', { width: 2424, height: 1080, rotation: 1 }), 0);
  assert.equal(rotationFor('landscape', { width: 2424, height: 1080, rotation: 3 }), 3);   // already landscape
  assert.equal(rotationFor('portrait', { width: 1080, height: 2424, rotation: 2 }), 2);    // already portrait (upside down)
  assert.equal(rotationFor('portrait', { width: 1080, height: 2424, rotation: 0 }), 0);
  // tablet: natural landscape 2560x1600
  assert.equal(rotationFor('portrait', { width: 2560, height: 1600, rotation: 0 }), 1);
  assert.equal(rotationFor('landscape', { width: 1600, height: 2560, rotation: 1 }), 0);
});

test('parseDisplayChange: screenrecord display-change lines (Android 14+ and older)', () => {
  assert.deepEqual(parseDisplayChange('D/ScreenRecord( 5056): display state changed, now has orientation ROTATION_1, size (2424, 1080)'),
    { rotation: 1, width: 2424, height: 1080 });
  assert.deepEqual(parseDisplayChange('D/ScreenRecord( 5056): display state changed, now has orientation ROTATION_0'), { rotation: 0 });
  assert.deepEqual(parseDisplayChange('D/ScreenRecord(  123): orientation changed, now 3'), { rotation: 3 });
  assert.equal(parseDisplayChange('D/ScreenRecord( 5056): raw video output to tty (fd=1)'), undefined);
});

test('parseRotation and orientationOf', () => {
  assert.equal(parseRotation('      Viewport INTERNAL: displayId=0, uniqueId=local:1, port=0, orientation=1, logicalFrame=[0, 0, 2424, 1080]'), 1);
  assert.equal(parseRotation('    SurfaceOrientation: 3'), 3);
  assert.equal(parseRotation(''), 0);
  assert.equal(orientationOf(2424, 1080), 'landscape');
  assert.equal(orientationOf(1080, 2424), 'portrait');
  assert.equal(orientationOf(1000, 1000), 'portrait');
});

// B1 (blind test round 2): on an API 36 emulator in landscape, `dumpsys input` listed an unbound virtio touch device
// first (displayId=-1, orientation=0), so the old parser said portrait: rotate reported "stays in portrait", get_ui
// kept a portrait image space and x,y taps were mapped wrongly. The window manager's state is the source of truth.
const API36_LANDSCAPE_WINDOW = [
  '    init=1080x2424 420dpi mMinSizeOfResizeableTaskDp=220 cur=2424x1080 app=2424x1080 rng=1080x1080-2424x2424',
  '    mRotation=1 mDeferredRotationPauseCount=0',
].join('\n');
const API36_LANDSCAPE_INPUT = [
  '      Viewport INTERNAL: displayId=-1, uniqueId=, port=<none>, orientation=0, logicalFrame=[0, 0, 0, 0], physicalFrame=[0, 0, 0, 0], deviceSize=[0, 0], isActive=[0]',
  '      Viewport INTERNAL: displayId=-1, uniqueId=, port=<none>, orientation=0, logicalFrame=[0, 0, 0, 0], physicalFrame=[0, 0, 0, 0], deviceSize=[0, 0], isActive=[0]',
  '      Viewport INTERNAL: displayId=0, uniqueId=local:4619827259835644672, port=0, orientation=1, logicalFrame=[0, 0, 2424, 1080], physicalFrame=[0, 0, 2424, 1080], deviceSize=[2424, 1080], isActive=[1]',
].join('\n');

test('parseRotation: the window manager (cur=, mRotation=) wins; dumpsys input only from the display\'s own viewport', () => {
  assert.equal(parseRotation(`Physical size: 1080x2424\nPhysical density: 420\n${API36_LANDSCAPE_WINDOW}`), 1);
  assert.deepEqual(parseCurrentSize(API36_LANDSCAPE_WINDOW), { width: 2424, height: 1080 });
  // fallback (no window manager lines): an unbound touch device listed first must not decide
  assert.equal(parseRotation(API36_LANDSCAPE_INPUT), 1);
  assert.equal(parseRotation('      Viewport INTERNAL: displayId=-1, orientation=0, deviceSize=[0, 0], isActive=[0]\n      Viewport INTERNAL: displayId=0, orientation=3, deviceSize=[2424, 1080]'), 3);
  assert.equal(parseRotation('    SurfaceOrientation: 0\n    SurfaceOrientation: 1'), 1);
  assert.equal(parseCurrentSize('Physical size: 1080x2424'), undefined);
  // portrait home screen: cur says so even with the lock set to landscape
  assert.equal(parseRotation('    init=1080x2424 420dpi cur=1080x2424 app=1080x2361\n    mRotation=0 mDeferredRotationPauseCount=0'), 0);
  // Home pressed in landscape: the portrait launcher opens with a fixed rotation and the display turns afterwards
  assert.equal(rotationPending(`${API36_LANDSCAPE_WINDOW}\n  mFixedRotationLaunchingApp=ActivityRecord{119101662 u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity t6}`), true);
  assert.equal(rotationPending(API36_LANDSCAPE_WINDOW), false);
  assert.equal(rotationPending('  mFixedRotationLaunchingApp=null'), false);
  // the launcher keeps the panel's natural orientation; an app that lets the display turn has none
  assert.equal(appFixedOrientation('    mCurrentAppOrientation=SCREEN_ORIENTATION_NOSENSOR', 'portrait'), 'portrait');
  assert.equal(appFixedOrientation('    mCurrentAppOrientation=SCREEN_ORIENTATION_SENSOR_LANDSCAPE', 'portrait'), 'landscape');
  assert.equal(appFixedOrientation('    mCurrentAppOrientation=SCREEN_ORIENTATION_UNSPECIFIED', 'portrait'), undefined);
});

// Blind re-run 10: in landscape a focused field brings up Gboard's fullscreen keyboard over the whole app; a tap on
// Greet from the tree typed "q" into the field. The daemon hides the keyboard first when its frame covers the target.
test('imeFrameFrom: the keyboard window frame only while the IME is shown', () => {
  const landscape = '      mImeWindowVis=3\n      mInputShown=true\nframe=[142,137][2424,1080]\n';
  assert.deepEqual(imeFrameFrom(landscape), { x: 142, y: 137, width: 2282, height: 943 });
  assert.equal(imeFrameFrom('      mImeWindowVis=0\n      mInputShown=false\n'), undefined);
  assert.equal(imeFrameFrom('      mInputShown=true\n'), undefined);   // shown, frame not reported
});
