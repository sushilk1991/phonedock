import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARRIERS, generateIdentity, validateIdentity } from './device-identity.ts';
import {
  CTS_FALLBACK_SERIAL_ALPHABET,
  DEFAULT_DEVICE_PROFILE_ID,
  DEVICE_PROFILES,
  defaultDeviceProfile,
  deviceProfileById,
  findDeviceProfile,
  listDeviceProfiles,
  loadProfilesFromRaw,
  resolveRawProfile,
  type RawProfileEntry,
} from './device-profiles.ts';

const EXPECTED_IDS = ['pixel_8', 'pixel_8a', 'pixel_7a', 'galaxy_s23', 'galaxy_s24', 'oneplus_12'];

test('device-profiles: loads all 6 sourced real-phone profiles with unique ids and provenance', () => {
  assert.deepEqual(DEVICE_PROFILES.map((p) => p.id), EXPECTED_IDS);
  for (const p of DEVICE_PROFILES) {
    assert.ok(p.name.length > 0, `${p.id}: name`);
    assert.ok(p.fingerprint.includes(':user/release-keys'), `${p.id}: release-keys fingerprint`);
    assert.equal(p.sdk, 34, `${p.id}: Android 14 (API 34)`);
    assert.equal(p.androidRelease, '14', `${p.id}: release 14`);
    assert.ok(p.tacs.length > 0, `${p.id}: at least one TAC`);
    assert.ok(p.wifiOuis.length > 0, `${p.id}: at least one Wi-Fi OUI`);
    assert.ok(Object.keys(p.sources).length >= 5, `${p.id}: primary source URLs`);
    for (const url of Object.values(p.sources)) {
      assert.match(url, /^https:\/\//, `${p.id}: source URL must be https`);
    }
  }
});

test('device-profiles: every shipped profile produces valid identities across all carriers and seeds', () => {
  const seeds = ['00000000000000000000000000000001', 'deadbeefcafebabe0123456789abcdef', 'ffffffffffffffffffffffffffffffff'];
  for (const profile of DEVICE_PROFILES) {
    for (const carrier of CARRIERS) {
      for (const seed of seeds) {
        const id = generateIdentity(profile, { seed, carrier: carrier.id, now: new Date('2025-01-01T00:00:00Z') });
        assert.deepEqual(validateIdentity(id, profile), [], `${profile.id} / ${carrier.id} / ${seed}`);
        // AOSP CTS BuildTest allows ^[0-9A-Za-z]{6,20}$
        assert.match(id.serial, /^[0-9A-Za-z]{6,20}$/, `${profile.id} serial must satisfy CTS`);
      }
    }
  }
});

test('device-profiles: null/unverified OEM fields are omitted, never fabricated', () => {
  const p8 = deviceProfileById('pixel_8')!;
  assert.equal(p8.bootloader, 'ripcurrent-14.5-11693900');
  assert.equal(p8.baseband, 'g5300i-240308-240517-B-11857457');
  assert.equal(p8.props['ro.build.host'], 'r-82b05a39f2cf359a-z8kw');
  assert.equal(p8.props['ro.vendor.build.fingerprint'], p8.fingerprint);

  const p8a = deviceProfileById('pixel_8a')!;
  assert.equal(p8a.bootloader, 'akita-14.5-12100691');
  assert.equal(p8a.baseband, 'g5300o-240308-240517-B-11857457');
  assert.equal(p8a.props['ro.build.host'], undefined, 'pixel_8a ro.build.host is unverified');
  assert.equal(p8a.props['ro.vendor.build.fingerprint'], undefined, 'pixel_8a ro.vendor.build.fingerprint is unverified');

  for (const id of ['galaxy_s23', 'galaxy_s24', 'oneplus_12']) {
    const p = deviceProfileById(id)!;
    assert.equal(p.bootloader, undefined, `${id}: unverified bootloader must remain undefined`);
    assert.equal(p.baseband, undefined, `${id}: unverified baseband must remain undefined`);
    assert.equal(p.props['ro.bootloader'], undefined);
    assert.equal(p.props['gsm.version.baseband'], undefined);
  }

  // Samsung docs confirm 11-char serial length; alphabet is unverified so CTS fallback is marked honestly.
  assert.equal(deviceProfileById('galaxy_s23')!.serial.length, 11);
  assert.equal(deviceProfileById('galaxy_s24')!.serial.length, 11);
  assert.equal(deviceProfileById('galaxy_s23')!.serialRuleSource, 'cts-fallback');
  assert.equal(deviceProfileById('pixel_8')!.serial.alphabet, CTS_FALLBACK_SERIAL_ALPHABET);
  assert.equal(deviceProfileById('pixel_8')!.serialRuleSource, 'cts-fallback');
});

test('device-profiles: lookup and filtering helpers', () => {
  assert.equal(defaultDeviceProfile().id, DEFAULT_DEVICE_PROFILE_ID);
  assert.equal(defaultDeviceProfile(34).id, 'pixel_8');
  assert.equal(defaultDeviceProfile(99).id, DEFAULT_DEVICE_PROFILE_ID);
  assert.equal(listDeviceProfiles().length, 6);
  assert.equal(listDeviceProfiles({ sdk: 34 }).length, 6);
  assert.equal(listDeviceProfiles({ sdk: 35 }).length, 0);
  assert.equal(deviceProfileById('galaxy_s24')?.model, 'SM-S921B');
  assert.equal(deviceProfileById('missing'), undefined);
  assert.equal(findDeviceProfile('Google Pixel 8')?.id, 'pixel_8');
  assert.equal(findDeviceProfile('sm-s911b')?.id, 'galaxy_s23');
  assert.equal(findDeviceProfile('oneplus_12')?.id, 'oneplus_12');
  assert.equal(findDeviceProfile('nonexistent'), undefined);
});

test('device-profiles: resolveRawProfile & loadProfilesFromRaw validate malformed entries', () => {
  const validRaw: RawProfileEntry = {
    id: 'test_phone',
    name: 'Test Phone',
    props: {
      'ro.product.brand': 'acme',
      'ro.product.manufacturer': 'Acme',
      'ro.product.model': 'TP-1',
      'ro.product.device': 'tp1',
      'ro.product.name': 'tp1',
      'ro.product.board': 'tp1',
      'ro.hardware': 'tp1',
      'ro.build.version.release': '14',
      'ro.build.version.sdk': '34',
      'ro.build.id': 'AP2A.240605.024',
      'ro.build.version.incremental': '100',
      'ro.build.version.security_patch': '2024-06-05',
      'ro.build.fingerprint': 'acme/tp1/tp1:14/AP2A.240605.024/100:user/release-keys',
    },
    screen: { width: 1080, height: 2400, dpi: 420 },
    ramMB: 8192,
    tacs: ['35154570'],
    serial: { length: 10, alphabet: '0123456789ABCDEF', prefix: 'AC' },
    wifiOuis: ['60:70:6C'],
  };

  const resolved = resolveRawProfile(validRaw);
  assert.equal(resolved.serialRuleSource, 'verified');
  assert.equal(resolved.serial.prefix, 'AC');
  assert.equal(loadProfilesFromRaw({ profiles: [validRaw] }).length, 1);

  assert.throws(() => loadProfilesFromRaw({ profiles: [] }), /empty/);
  assert.throws(() => loadProfilesFromRaw({ profiles: [validRaw, validRaw] }), /duplicate/);
  assert.throws(() => resolveRawProfile({ ...validRaw, id: 'Bad Id' }), /invalid id/);
  assert.throws(() => resolveRawProfile({ ...validRaw, tacs: ['123'] }), /invalid TAC/);
  assert.throws(() => resolveRawProfile({ ...validRaw, wifiOuis: ['61:70:6C'] }), /multicast/);
  assert.throws(() => resolveRawProfile({ ...validRaw, wifiOuis: ['62:70:6C'] }), /locally administered/);
  assert.throws(
    () => resolveRawProfile({ ...validRaw, props: { ...validRaw.props, 'ro.build.version.sdk': 'notanumber' } }),
    /ro\.build\.version\.sdk/,
  );
  assert.throws(
    () => resolveRawProfile({ ...validRaw, props: { ...validRaw.props, 'ro.build.fingerprint': null } }),
    /ro\.build\.fingerprint/,
  );
});
