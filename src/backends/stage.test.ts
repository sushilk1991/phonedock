import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackends } from './index.ts';

// `stage` drives the app's Beta / Experimental badges (GET /v1/backends). Absent means stable.
test('backends declare their maturity stage', async () => {
  const { backends } = await loadBackends();
  const stage = Object.fromEntries(backends.map((b) => [b.id, b.stage ?? 'stable']));
  assert.equal(stage['android-emulator'], 'stable');
  assert.equal(stage['ios-simulator'], 'stable');
  assert.equal(stage['ios-device'], 'stable');  // iOS 27+; the app marks iOS 26 and older (WebDriverAgent) Beta per device
  assert.equal(stage['qemu'], 'experimental');
  assert.equal(stage['corellium'], 'experimental');
  for (const b of backends) assert.ok(['stable', 'beta', 'experimental'].includes(b.stage ?? 'stable'), `${b.id}: ${b.stage}`);
});
