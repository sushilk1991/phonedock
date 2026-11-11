import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Backend } from '../core/types.ts';
import { environmentCapabilities, applyEnvironment, type EnvironmentDeps } from './environment.ts';
import { parseEnvironmentAction } from '../core/environment.ts';

const fake = (id: string) => ({ id, kind: id.includes('device') ? 'physical' : 'virtual', platform: id.startsWith('ios') ? 'ios' : 'android' }) as Backend;
function harness(backend = 'ios-simulator') {
  const calls: string[][] = []; let checks = 0; let allowed = '0';
  const deps: EnvironmentDeps = {
    command: async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: args.includes('get') ? '0\n' : '', stderr: '' }; },
    adb: async (serial, args) => { calls.push(['adb', '-s', serial, ...args]); if (args.includes('put') && args.includes('sysui_demo_allowed')) allowed = args.at(-1)!; return { code: 0, stdout: args.includes('get') ? (args.includes('sysui_demo_allowed') ? allowed : '0') + '\n' : '', stderr: '' }; },
    serial: async () => 'emulator-pdtest', beforeMutation: () => { checks++; },
  };
  return { b: fake(backend), deps, calls, checks: () => checks };
}
test('capabilities describe actual services and never offer physical-device authentication', () => {
  assert.ok(!environmentCapabilities(fake('ios-simulator')).permissions.services.includes('camera'));
  assert.ok(!environmentCapabilities(fake('ios-simulator')).permissions.services.includes('notifications'));
  assert.deepEqual(environmentCapabilities(fake('ios-device')).actions, []);
  assert.deepEqual(environmentCapabilities(fake('android-device')).actions, []);
});
test('permissions validate the entire request before sending and remain scoped to one app', async () => {
  const h = harness();
  await applyEnvironment(h.b, 'pdtest-udid', { action: 'permissions', state: 'grant', appId: 'com.example.test', permissions: ['photos', 'microphone'] }, h.deps);
  assert.deepEqual(h.calls.map(c=>c.slice(1)), [['simctl', 'privacy', 'pdtest-udid', 'grant', 'photos', 'com.example.test'], ['simctl', 'privacy', 'pdtest-udid', 'grant', 'microphone', 'com.example.test']]);
  const n = h.calls.length;
  await assert.rejects(applyEnvironment(h.b, 'pdtest-udid', { action: 'permissions', state: 'grant', appId: 'com.example.test', permissions: ['photos', 'camera'] }, h.deps), (e: any) => e.code === 'not_supported' && e.delivery === 'not_sent');
  assert.equal(h.calls.length, n);
  assert.throws(() => parseEnvironmentAction({ action: 'permissions', state: 'grant', appId: 'bad;input', permissions: ['photos'] }));
});
test('Android permission reset revokes only requested permissions and clears app-local flags', async () => {
  const h = harness('android-emulator');
  await applyEnvironment(h.b, 'pdtest-avd', { action: 'permissions', state: 'reset', appId: 'com.example.test', permissions: ['camera'] }, h.deps);
  assert.deepEqual(h.calls, [['adb', '-s', 'emulator-pdtest', 'shell', 'pm', 'revoke', '--user', 'current', 'com.example.test', 'android.permission.CAMERA'], ['adb', '-s', 'emulator-pdtest', 'shell', 'pm', 'clear-permission-flags', '--user', 'current', 'com.example.test', 'android.permission.CAMERA', 'user-set', 'user-fixed']]);
  assert.ok(h.calls.every(c=>c.includes('com.example.test') && !c.includes('reset-permissions')));
});
test('biometric events target the explicit simulator; emulator failures require a distinct finger', async () => {
  const h = harness();
  await applyEnvironment(h.b, 'pdtest-udid', { action: 'biometric', event: 'enroll', modality: 'face' }, h.deps);
  assert.deepEqual(h.calls[0], ['xcrun', 'simctl', 'spawn', 'pdtest-udid', 'notifyutil', '-s', 'com.apple.BiometricKit.enrollmentChanged', '1', '-p', 'com.apple.BiometricKit.enrollmentChanged']);
  await applyEnvironment(h.b, 'pdtest-udid', { action: 'biometric', event: 'fail', modality: 'face' }, h.deps);
  assert.deepEqual(h.calls[1], ['xcrun', 'simctl', 'notify_post', 'pdtest-udid', 'com.apple.BiometricKit_Sim.pearl.nomatch']);
  const a = harness('android-emulator');
  await assert.rejects(applyEnvironment(a.b, 'pdtest-avd', { action: 'biometric', event: 'enroll' }, a.deps), (e: any) => e.code === 'not_supported');
  await applyEnvironment(a.b, 'pdtest-avd', { action: 'biometric', event: 'fail', fingerId: 99 }, a.deps);
  assert.deepEqual(a.calls[0], ['adb', '-s', 'emulator-pdtest', 'emu', 'finger', 'touch', '99']);
});
test('Android status clear exits demo mode and restores its previous enable setting', async () => {
  const h = harness('android-emulator');
  await applyEnvironment(h.b, 'pdtest-avd-status', { action: 'statusBar', mode: 'override', time: '09:41', batteryLevel: 100, wifiBars: 4 }, h.deps);
  assert.ok(h.calls.every(c=>c[1] === '-s' && c[2] === 'emulator-pdtest'));
  assert.ok(h.calls.some(c=>c.includes('clock') && c.includes('0941')));
  await applyEnvironment(h.b, 'pdtest-avd-status', { action: 'statusBar', mode: 'clear' }, h.deps);
  assert.ok(h.calls.some(c=>c.includes('command') && c.includes('exit')));
  assert.deepEqual(h.calls.at(-1), ['adb', '-s', 'emulator-pdtest', 'shell', 'settings', 'put', 'global', 'sysui_demo_allowed', '0']);
});
test('media validates regular files and uses a generated safe destination, never the supplied filename', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdtest-media-')); const path = join(dir, 'a name;$(bad).png'); writeFileSync(path, 'fake');
  try {
    const h = harness('android-emulator');
    const out = await applyEnvironment(h.b, 'pdtest-avd', { action: 'media', path }, h.deps);
    assert.match(out.path!, /^\/sdcard\/Pictures\/PhoneDock\/[a-f0-9-]+\.png$/);
    assert.ok(h.calls.some(c=>c.includes('push') && c.includes(path)));
    assert.ok(h.calls.some(c=>c.includes('android.intent.action.MEDIA_SCANNER_SCAN_FILE') && c.includes('file://' + out.path)));
    await assert.rejects(applyEnvironment(h.b, 'pdtest-avd', { action: 'media', path: dir }, h.deps), (e: any) => e.code === 'bad_request');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('takeover fences each command of a multi-command operation and reports partial delivery', async () => {
  const h = harness('ios-simulator'); let n = 0;
  h.deps.beforeMutation = () => { if (++n === 2) throw Object.assign(new Error('ownership changed'), { code: 'lease_conflict' }); };
  await assert.rejects(applyEnvironment(h.b, 'pdtest-udid', { action: 'permissions', state: 'grant', appId: 'com.example.test', permissions: ['photos', 'microphone'] }, h.deps), (e: any) => e.delivery === 'sent');
  assert.equal(h.calls.length, 1);
});

test('parser rejects unknown fields and malformed values before any command', async () => {
  for (const value of [null, [], { action: 'statusBar', mode: 'override', time: '25:61' }, { action: 'statusBar', mode: 'clear', time: '09:41' }, { action: 'statusBar', mode: 'override', batteryLevel: 101 }, { action: 'biometric', event: 'match', fingerId: 0 }, { action: 'media', path: 'bad\0file' }, { action: 'permissions', appId: 'com.test', state: 'grant', permissions: [] }, { action: 'media', path: '/tmp/image.png', injection: true }]) {
    assert.throws(() => parseEnvironmentAction(value), (e: any) => e.code === 'bad_request' && e.delivery === 'not_sent');
  }
  const h = harness('ios-device');
  await assert.rejects(applyEnvironment(h.b, 'pdtest-physical', { action: 'biometric', event: 'match' }, h.deps), (e: any) => e.code === 'not_supported');
  assert.equal(h.calls.length, 0);
});

test('environment command rejection never claims success or retries', async () => {
  const h = harness(); let n = 0;
  h.deps.command = async () => { n++; return { code: 0, stdout: 'Error: unsupported service', stderr: '' }; };
  await assert.rejects(applyEnvironment(h.b, 'pdtest-udid', { action: 'statusBar', mode: 'clear' }, h.deps), (e: any) => e.code === 'environment_failed' && e.delivery === 'unknown');
  assert.equal(n, 1);
});
