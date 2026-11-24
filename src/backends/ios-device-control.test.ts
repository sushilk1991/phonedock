// Regression tests for the error an iPhone gives when nothing can send it input (a Wake or a tap from the Mac app).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noControlError } from './ios-device.ts';

const all = { pymd3: true, hid: true };

test('ios-device no-control error: iOS 27 without pymobiledevice3 says to install it, not to set up WebDriverAgent', () => {
  const e = noControlError('UDID-1', '27.2.1', { pymd3: false, hid: true });
  assert.equal(e.code, 'not_supported');
  assert.equal(e.status, 501);
  assert.match(e.message, /can’t control this iPhone yet/);
  assert.deepEqual(e.hints, ['Install pymobiledevice3 on this Mac: uv tool install --python 3.12 pymobiledevice3']);
  assert.doesNotMatch(`${e.message} ${e.hints?.join(' ')} ${e.detail}`, /WebDriverAgent/);
  assert.match(String(e.detail), /Python 3\.11/);
});

test('ios-device no-control error: iOS 27 with pymobiledevice3 but no input helper says to reinstall PhoneDock', () => {
  const e = noControlError('UDID-1', '27.0', { pymd3: true, hid: false });
  assert.deepEqual(e.hints, ['Reinstall PhoneDock: its iPhone input helper is missing.']);
  assert.doesNotMatch(`${e.message} ${e.hints?.join(' ')}`, /WebDriverAgent/);
});

test('ios-device no-control error: iOS 26 and older, or an unknown version, still point at WebDriverAgent', () => {
  for (const os of ['26.4', '17.5', undefined]) {
    const e = noControlError('UDID-1', os, { pymd3: false, hid: false });
    assert.equal(e.message, 'Could not control or inspect the iPhone');
    assert.deepEqual(e.hints, ['Set up WebDriverAgent on the iPhone.']);
    assert.match(String(e.detail), /WebDriverAgent/);
  }
  // iOS 27 with everything installed only reaches this when native input is off for another reason: same as before.
  assert.equal(noControlError('UDID-1', '27.1', all).message, 'Could not control or inspect the iPhone');
});
