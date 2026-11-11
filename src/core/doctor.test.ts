import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDoctorReport, diagnoseKnownDevice, type DoctorDeps } from './doctor.ts';
import type { Device } from './types.ts';

const ready = (): DoctorDeps => ({
  nodeVersion: '24.14.0', platform: 'darwin', which: (name) => `/tools/${name}`,
  developerDir: () => '/Xcode/Contents/Developer', androidSdkRoot: () => '/android', javaHome: () => '/java',
  exists: () => true, nativeAvailability: async () => ({ ok: true, pymobiledevice3: '11.49.0' }),
});

test('doctor reports host prerequisites without probing any device', async () => {
  const report = await buildDoctorReport(ready());
  assert.equal(report.ok, true);
  assert.equal(report.scope, 'host-prerequisites');
  assert.equal(report.targets.iosSimulator, true);
  assert.equal(report.targets.androidEmulator, true);
  assert.equal(report.targets.nativeIphone, true);
  assert.ok(report.limits.some((s) => /not.*device|device.*not/i.test(s)));
});

test('doctor distinguishes missing tools, unsupported runtime and failed native imports', async () => {
  const deps = ready(); deps.nodeVersion = '22.1.0'; deps.which = () => undefined; deps.androidSdkRoot = () => undefined;
  deps.nativeAvailability = async () => { throw new Error('broken environment'); };
  const report = await buildDoctorReport(deps);
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((c) => c.id === 'node')?.status, 'unsupported');
  assert.equal(report.checks.find((c) => c.id === 'android-sdk')?.status, 'missing');
  assert.equal(report.checks.find((c) => c.id === 'native-iphone')?.status, 'warning');
  assert.equal(report.targets.nativeIphone, false);
});

test('known-device diagnosis separates locked, stream busy and unsupported capabilities', () => {
  const device = { id: 'ios-device:pdtest-fake', platform: 'ios', backend: 'ios-device', kind: 'physical', state: 'running',
    capabilities: ['screenshot'], meta: { readiness: { locked: true } }, error: 'stream_busy: another client is streaming' } as unknown as Device;
  const diagnosis = diagnoseKnownDevice(device, ['uiTree']);
  assert.ok(diagnosis.issues.some((i) => i.code === 'locked'));
  assert.ok(diagnosis.issues.some((i) => i.code === 'stream_busy'));
  assert.ok(diagnosis.issues.some((i) => i.code === 'unsupported_capability'));
  assert.equal(diagnosis.observedFrom, 'cached-device-metadata');
});
