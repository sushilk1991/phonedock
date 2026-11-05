import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtimeOrder, type SimRuntime } from './ios-simulator.ts';

const phone = (name: string) => ({ identifier: `com.apple.CoreSimulator.SimDeviceType.${name.replace(/ /g, '-')}`, name, productFamily: 'iPhone' });
const rt = (identifier: string, version: string, phones: string[]): SimRuntime =>
  ({ identifier, version, name: `iOS ${version}`, supportedDeviceTypes: phones.map(phone) });

// As installed with Xcode 27.2: a Duo-only runtime with the same name and version as the general one, listed first.
const duo = rt('com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4', '27.2', ['iPhone Duo']);
const ios272 = rt('com.apple.CoreSimulator.SimRuntime.iOS-27-2', '27.2', ['iPhone 18 Pro', 'iPhone 18 Pro Max', 'iPhone 17']);
const ios270 = rt('com.apple.CoreSimulator.SimRuntime.iOS-27-0', '27.0', ['iPhone 18 Pro', 'iPhone 17']);

test('runtimeOrder: newest first, and the general runtime before a device-specific one of the same version', () => {
  assert.deepEqual(runtimeOrder([duo, ios270, ios272]).map((r) => r.identifier), [ios272.identifier, duo.identifier, ios270.identifier]);
});

test('runtimeOrder: a profile keeps only runtimes that run it', () => {
  assert.deepEqual(runtimeOrder([duo, ios270, ios272], 'iPhone 18 Pro').map((r) => r.identifier), [ios272.identifier, ios270.identifier]);
  assert.deepEqual(runtimeOrder([duo, ios270, ios272], 'iPhone Duo').map((r) => r.identifier), [duo.identifier]);
  assert.deepEqual(runtimeOrder([duo, ios272], 'com.apple.CoreSimulator.SimDeviceType.iPhone-Duo').map((r) => r.identifier), [duo.identifier]);
  assert.deepEqual(runtimeOrder([duo, ios272], 'iPhone 9'), []);
});

test('runtimeOrder: a runtime that lists no device types is kept (unknown means it may run it)', () => {
  const bare: SimRuntime = { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-28-0', version: '28.0', name: 'iOS 28.0' };
  assert.equal(runtimeOrder([ios272, bare], 'iPhone 18 Pro')[0], bare);
});
