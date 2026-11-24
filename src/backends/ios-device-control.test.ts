// Regression tests for the error an iPhone gives when nothing can send it input (a Wake or a tap from the Mac app).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noControlError } from './ios-device.ts';
import type { ComponentStatus } from '../core/types.ts';

const all = { pymd3: true, hid: true };

const baseComp: ComponentStatus = {
  id: 'ios-tools',
  displayName: 'iPhone Control',
  description: 'Python 3.12 + pymobiledevice3',
  state: 'missing',
  pinnedVersion: '11.63.1',
  source: 'none',
  updateAvailable: false,
  estimatedBytes: 277_000_000,
};

test('ios-device no-control error: iOS 27 while ios-tools is installing reports setup progress, not uv or WDA', () => {
  const e = noControlError('UDID-1', '27.2.1', {
    pymd3: false,
    hid: true,
    component: { ...baseComp, state: 'installing', progress: { phase: 'downloading', percent: 42 } },
  });
  assert.equal(e.code, 'not_supported');
  assert.equal(e.status, 501);
  assert.equal(e.message, 'PhoneDock is setting up iPhone control (42%)');
  assert.doesNotMatch(`${e.message} ${e.hints?.join(' ')} ${e.detail}`, /WebDriverAgent|uv tool install/);
});

test('ios-device no-control error: iOS 27 after ios-tools failure gives a retry hint, not uv or WDA', () => {
  const e = noControlError('UDID-1', '27.2.1', {
    pymd3: false,
    hid: true,
    component: { ...baseComp, state: 'failed', error: { code: 'download_failed', message: 'Network unreachable' } },
  });
  assert.equal(e.code, 'not_supported');
  assert.equal(e.status, 501);
  assert.match(e.message, /Couldn’t set up iPhone control/);
  assert.match(e.hints?.join(' ') ?? '', /phonedock components install ios-tools/);
  assert.doesNotMatch(`${e.message} ${e.hints?.join(' ')} ${e.detail}`, /WebDriverAgent|uv tool install/);
});

test('ios-device no-control error: iOS 27 when ios-tools is missing points to phonedock components install', () => {
  const e = noControlError('UDID-1', '27.2.1', { pymd3: false, hid: true, component: baseComp });
  assert.equal(e.code, 'not_supported');
  assert.equal(e.status, 501);
  assert.match(e.message, /can’t control this iPhone yet/);
  assert.match(e.hints?.join(' ') ?? '', /phonedock components install ios-tools/);
  assert.doesNotMatch(`${e.message} ${e.hints?.join(' ')} ${e.detail}`, /WebDriverAgent|uv tool install/);
});

test('ios-device no-control error: iOS 27 with pymobiledevice3 but no input helper says to reinstall PhoneDock', () => {
  const e = noControlError('UDID-1', '27.0', { pymd3: true, hid: false });
  assert.deepEqual(e.hints, ['Reinstall PhoneDock: its iPhone input helper is missing.']);
  assert.doesNotMatch(`${e.message} ${e.hints?.join(' ')}`, /WebDriverAgent/);
});

test('ios-device no-control error: iOS 26 and older, or an unknown version, point at one-step setup', () => {
  for (const os of ['26.4', '17.5', undefined]) {
    const e = noControlError('UDID-1', os, { pymd3: false, hid: false });
    assert.equal(e.code, 'not_supported');
    assert.equal(e.message, 'Set up control for this iPhone first');
    assert.match(e.hints![0], /Set Up Control/);
    assert.match(e.hints![0], /phonedock ios wda-setup --udid UDID-1/);
    assert.match(String(e.detail), /WebDriverAgent/);
    assert.doesNotMatch(String(e.detail), /git clone/);
  }
  // PhoneDock already manages it and is waiting on something: say what, as wda_not_ready.
  const waiting = noControlError('UDID-1', '18.7', { pymd3: false, hid: false, control: {
    managed: true, state: 'waiting_unlock', message: 'Unlock the iPhone so PhoneDock can start WebDriverAgent', attempts: 0, updatedAt: '2026-11-24T00:00:00Z' } });
  assert.equal(waiting.code, 'wda_not_ready');
  assert.equal(waiting.status, 503);
  assert.match(waiting.message, /Unlock the iPhone/);
  // iOS 27 with everything installed only reaches this when native input is off for another reason: same as before.
  assert.equal(noControlError('UDID-1', '27.1', all).message, 'Could not control or inspect the iPhone');
});
