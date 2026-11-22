import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CARRIERS, carrierById, generateIdentity, isValidImei, luhnCheckDigit, luhnValid, validateIdentity,
} from './device-identity.ts';
import type { Carrier, DeviceIdentity, DeviceProfile } from './device-identity.ts';

// Made-up models: well-formed shapes, no real handset data.
const PHONE_ONE: DeviceProfile = {
  id: 'test_one', name: 'Testco One', brand: 'testco', manufacturer: 'Testco', model: 'T1', device: 'test_one',
  product: 'test_one', board: 'test_one', hardware: 'test_one', platform: 'testplat', socManufacturer: 'Testco',
  socModel: 'TP1', androidRelease: '14', sdk: 34, buildId: 'TEST.240101.001', incremental: '1000001',
  securityPatch: '2024-01-05', fingerprint: 'testco/test_one/test_one:14/TEST.240101.001/1000001:user/release-keys',
  bootloader: 'test-1.0', baseband: 'test-0.1', screen: { width: 1080, height: 2400, dpi: 420 }, ramMB: 8192,
  gl: { vendor: 'Testco', renderer: 'Testco GPU', version: 'OpenGL ES 3.2' },
  tacs: ['35100000', '35100001'], serial: { length: 10, alphabet: '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ', prefix: 'TC' },
  wifiOuis: ['3C:5A:B4'], btOuis: ['3C:5A:B5'],
};

const PHONE_TWO: DeviceProfile = {
  id: 'test_two', name: 'Testco Two', brand: 'testco', manufacturer: 'Testco', model: 'T2', device: 'test_two',
  product: 'test_two', board: 'test_two', hardware: 'test_two', androidRelease: '13', sdk: 33,
  buildId: 'TEST.230401.002', incremental: '1000002', securityPatch: '2023-04-01',
  fingerprint: 'testco/test_two/test_two:13/TEST.230401.002/1000002:user/release-keys',
  screen: { width: 720, height: 1600, dpi: 320 }, ramMB: 4096,
  tacs: ['35100002'], serial: { length: 8, alphabet: '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ', prefix: 'SN' },
  wifiOuis: ['8C:1A:9E', '9C:2B:10'], btOuis: ['8C:1A:9E'], dualSim: true,
};

const PHONE_THREE: DeviceProfile = {
  id: 'test_three', name: 'Testco Three', brand: 'testco', manufacturer: 'Testco', model: 'T3', device: 'test_three',
  product: 'test_three', board: 'test_three', hardware: 'test_three', androidRelease: '15', sdk: 35,
  buildId: 'TEST.240801.003', incremental: '1000003', securityPatch: '2024-08-05',
  fingerprint: 'testco/test_three/test_three:15/TEST.240801.003/1000003:user/release-keys',
  screen: { width: 1440, height: 3120, dpi: 560 }, ramMB: 12288,
  tacs: ['35100003'], serial: { length: 12, alphabet: '0123456789' },
  wifiOuis: ['2C:44:7C'],
};

const PROFILES = [PHONE_ONE, PHONE_TWO, PHONE_THREE];
const FIXED_NOW = new Date('2024-09-01T10:20:30.000Z');

/** Deterministic, distinct seeds without a random source so test failures are reproducible. */
const seedAt = (n: number): string => n.toString(16).padStart(32, '0');
const seeds = (count: number): string[] => Array.from({ length: count }, (_, i) => seedAt(i + 1));

const generate = (profile: DeviceProfile, seed: string, carrier?: string): DeviceIdentity =>
  generateIdentity(profile, { seed, carrier, now: FIXED_NOW });

const SIM_FIELDS = ['carrier', 'imsi', 'iccid', 'phoneNumber'] as const;
const HARDWARE_FIELDS = ['imei', 'imei2', 'serial', 'androidId', 'wifiMac', 'btMac'] as const;

test('identity: Luhn check digit, Luhn validation and IMEI validation', () => {
  assert.equal(luhnCheckDigit('49015420323751'), '8');
  assert.equal(luhnCheckDigit(''), '0');
  assert.equal(luhnValid('490154203237518'), true);
  assert.equal(isValidImei('490154203237518'), true);
  // A one-digit change invalidates the checksum.
  assert.equal(luhnValid('490154203237519'), false);
  assert.equal(isValidImei('490154203237517'), false);
  assert.equal(luhnValid('1234'), false);
  assert.equal(isValidImei('4901542032375'), false, 'wrong length');
  assert.equal(isValidImei('49015420323751a'), false, 'non-digit');
  assert.equal(isValidImei(''), false);
  assert.equal(luhnValid('49015420323751a'), false);
  assert.throws(() => luhnCheckDigit('49015x'), /luhn/);
});

test('identity: same profile, carrier and seed give the same identity; a different seed moves everything', () => {
  const a = generate(PHONE_ONE, seedAt(1));
  const b = generate(PHONE_ONE, seedAt(1));
  assert.deepEqual(a, b);
  assert.equal(a.createdAt, FIXED_NOW.toISOString());
  assert.equal(a.seed, seedAt(1));
  assert.equal(a.v, 1);
  assert.equal(a.profile, PHONE_ONE.id);

  const other = generate(PHONE_ONE, seedAt(2));
  for (const field of HARDWARE_FIELDS) {
    if (a[field] === undefined) continue; // imei2 only exists on a dual-SIM profile
    assert.notEqual(other[field], a[field], `${field} must depend on the seed`);
  }
  assert.notEqual(other.bootId, a.bootId);

  // An explicit seed is echoed; an omitted one is a fresh 16-byte hex seed.
  const random = [generateIdentity(PHONE_ONE), generateIdentity(PHONE_ONE)];
  for (const id of random) assert.match(id.seed, /^[0-9a-f]{32}$/);
  assert.notEqual(random[0]?.seed, random[1]?.seed);
});

// An IMEI's seed-driven part is 6 digits, so 500 draws from a 10^6 space collide by chance about one
// run in nine. The seeds here are fixed, which makes the assertion deterministic instead of flaky.
test('identity: 500 seeds give 500 distinct IMEIs and serials', () => {
  const imeis = new Set<string>();
  const serials = new Set<string>();
  const androidIds = new Set<string>();
  for (const seed of seeds(500)) {
    const id = generate(PHONE_TWO, seed);
    imeis.add(id.imei);
    serials.add(id.serial);
    androidIds.add(id.androidId);
  }
  assert.equal(imeis.size, 500);
  assert.equal(serials.size, 500);
  assert.equal(androidIds.size, 500);
});

test('identity: switching the carrier changes only the SIM fields', () => {
  const seed = seedAt(7);
  const base = generate(PHONE_TWO, seed, 'tmobile_us');
  for (const carrierId of CARRIERS.map((c) => c.id)) {
    const id = generate(PHONE_TWO, seed, carrierId);
    assert.equal(id.carrier, carrierId);
    for (const field of HARDWARE_FIELDS) assert.equal(id[field], base[field], `${field} must not depend on the carrier`);
    assert.equal(id.bootId, base.bootId);
    assert.equal(id.createdAt, base.createdAt);
    // Each carrier moves all four SIM fields relative to the default carrier.
    for (const field of SIM_FIELDS) if (carrierId !== 'tmobile_us') assert.notEqual(id[field], base[field], `${field} for ${carrierId}`);
  }
});

test('identity: every generated identity validates for each test profile across 200 seeds', () => {
  for (const profile of PROFILES) {
    for (const seed of seeds(200)) {
      for (const carrier of CARRIERS) {
        const id = generate(profile, seed, carrier.id);
        assert.deepEqual(validateIdentity(id, profile), [], `${profile.id} / ${carrier.id} / ${seed}`);
      }
    }
  }
});

test('identity: field formats follow the profile and carrier data', () => {
  for (const profile of PROFILES) {
    const id = generate(profile, seedAt(11), 'ee_uk');
    const carrier = carrierById('ee_uk') as Carrier;

    assert.match(id.imei, /^\d{15}$/);
    assert.ok(isValidImei(id.imei));
    assert.ok(profile.tacs.some((tac) => id.imei.startsWith(tac)), 'IMEI must start with a profile TAC');
    assert.equal(profile.dualSim === true, id.imei2 !== undefined);
    if (id.imei2 !== undefined) {
      assert.ok(isValidImei(id.imei2));
      assert.equal(id.imei2.slice(0, 8), id.imei.slice(0, 8));
      assert.notEqual(id.imei2.slice(8, 14), id.imei.slice(8, 14));
    }

    assert.equal(id.serial.length, profile.serial.length);
    if (profile.serial.prefix) assert.ok(id.serial.startsWith(profile.serial.prefix));
    for (const ch of id.serial) assert.ok(profile.serial.alphabet.includes(ch), `serial char ${ch}`);

    assert.match(id.androidId, /^[0-9a-f]{16}$/);
    assert.notEqual(id.androidId, '0'.repeat(16));

    assert.match(id.wifiMac, /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/);
    assert.match(id.btMac, /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/);
    assert.notEqual(id.wifiMac, id.btMac);
    assert.ok(profile.wifiOuis.map((oui) => oui.toLowerCase()).includes(id.wifiMac.slice(0, 8)));
    assert.ok((profile.btOuis ?? profile.wifiOuis).map((oui) => oui.toLowerCase()).includes(id.btMac.slice(0, 8)));
    for (const mac of [id.wifiMac, id.btMac]) {
      const firstOctet = parseInt(mac.slice(0, 2), 16);
      assert.equal(firstOctet & 1, 0, `${mac} must be unicast`);
      assert.equal(firstOctet & 2, 0, `${mac} must be globally administered`);
    }

    assert.equal(id.carrier, carrier.id);
    assert.match(id.imsi, /^\d{15}$/);
    assert.ok(id.imsi.startsWith(carrier.mcc + carrier.mnc));
    assert.match(id.iccid, /^89\d{17,18}$/);
    assert.ok(luhnValid(id.iccid));
    assert.ok(id.iccid.startsWith(`89${carrier.countryCallingCode}${carrier.iccidIssuer}`));
    assert.match(id.phoneNumber, new RegExp(`^\\+${carrier.countryCallingCode}[2-9]\\d{${carrier.nationalNumberLength - 1}}$`));
    assert.match(id.bootId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(id.createdAt, FIXED_NOW.toISOString());
  }
});

test('identity: US, UK, Indian and German carriers produce 19-digit ICCIDs and 15-digit IMSIs', () => {
  for (const carrier of CARRIERS) {
    const id = generate(PHONE_ONE, seedAt(3), carrier.id);
    assert.equal(id.imsi.length, 15, carrier.id);
    assert.equal(id.iccid.length, 19, carrier.id);
    assert.ok(luhnValid(id.iccid), carrier.id);
    assert.equal(id.phoneNumber.length, 1 + carrier.countryCallingCode.length + carrier.nationalNumberLength);
  }
});

const lastDigitBumped = (digits: string): string => {
  const head = digits.slice(0, -1);
  const last = digits.slice(-1);
  return head + String((Number(last) + 1) % 10);
};

const corrupt = (id: DeviceIdentity, patch: Record<string, unknown>): DeviceIdentity =>
  ({ ...id, ...patch }) as unknown as DeviceIdentity;
const brokenProfile = (profile: DeviceProfile, patch: Record<string, unknown>): DeviceProfile =>
  ({ ...profile, ...patch }) as unknown as DeviceProfile;

test('identity: validateIdentity names each kind of corruption', () => {
  const dual = generate(PHONE_TWO, seedAt(5), 'tmobile_us');
  assert.deepEqual(validateIdentity(dual, PHONE_TWO), []);

  const reports = (id: DeviceIdentity, profile: DeviceProfile, re: RegExp) => {
    const problems = validateIdentity(id, profile);
    assert.ok(problems.some((p) => re.test(p)), `expected ${re} in ${JSON.stringify(problems)}`);
  };

  reports(corrupt(dual, { imei: lastDigitBumped(dual.imei) }), PHONE_TWO, /^imei: .*Luhn/);
  reports(corrupt(dual, { imei: `99999999${dual.imei.slice(8)}` }), PHONE_TWO, /^imei: .*TACs/);
  reports(corrupt(dual, { imei: dual.imei.slice(0, 14) }), PHONE_TWO, /^imei: .*15 digits/);
  reports(corrupt(dual, { imei2: undefined }), PHONE_TWO, /^imei2: missing/);
  reports(corrupt(dual, { imei2: dual.imei }), PHONE_TWO, /^imei2: /);
  reports(corrupt(generate(PHONE_ONE, seedAt(5)), { imei2: '351000001234567' }), PHONE_ONE, /^imei2: present/);

  reports(corrupt(dual, { serial: `${dual.serial.slice(0, -1)}*` }), PHONE_TWO, /^serial: characters "\*"/);
  reports(corrupt(dual, { serial: dual.serial.slice(0, 4) }), PHONE_TWO, /^serial: .*characters/);
  reports(corrupt(dual, { serial: `XX${dual.serial.slice(2)}` }), PHONE_TWO, /^serial: .*does not start with/);

  reports(corrupt(dual, { androidId: '0123456789abcdeg' }), PHONE_TWO, /^androidId: /);
  reports(corrupt(dual, { androidId: '0'.repeat(16) }), PHONE_TWO, /^androidId: .*all zeros/);

  // 0x8d sets the multicast bit (0x8c | 0x01), 0x8e the locally-administered bit.
  reports(corrupt(dual, { wifiMac: `8d${dual.wifiMac.slice(2)}` }), PHONE_TWO, /^wifiMac: .*multicast/);
  reports(corrupt(dual, { wifiMac: `8e${dual.wifiMac.slice(2)}` }), PHONE_TWO, /^wifiMac: .*locally administered/);
  reports(corrupt(dual, { wifiMac: `fe${dual.wifiMac.slice(2)}` }), PHONE_TWO, /^wifiMac: OUI/);
  reports(corrupt(dual, { wifiMac: dual.wifiMac.toUpperCase() }), PHONE_TWO, /^wifiMac: .*lower-case/);
  reports(corrupt(dual, { btMac: dual.wifiMac }), PHONE_TWO, /^btMac: .*differ/);
  reports(corrupt(dual, { btMac: `8d${dual.btMac.slice(2)}` }), PHONE_TWO, /^btMac: .*multicast/);

  reports(corrupt(dual, { carrier: 'nope_mobile' }), PHONE_TWO, /^carrier: unknown carrier/);
  reports(corrupt(dual, { imsi: `999${dual.imsi.slice(3)}` }), PHONE_TWO, /^imsi: .*MCC\+MNC "310260"/);
  reports(corrupt(dual, { imsi: dual.imsi.slice(0, 14) }), PHONE_TWO, /^imsi: .*expected 15/);
  reports(corrupt(dual, { iccid: lastDigitBumped(dual.iccid) }), PHONE_TWO, /^iccid: .*Luhn/);
  reports(corrupt(dual, { iccid: '0012345678901234567' }), PHONE_TWO, /^iccid: .*starting with 89/);
  reports(corrupt(dual, { phoneNumber: '+1312555' }), PHONE_TWO, /^phoneNumber: /);
  reports(corrupt(dual, { phoneNumber: '+1312555000' }), PHONE_TWO, /^phoneNumber: /);
  reports(corrupt(dual, { phoneNumber: '+131255500001' }), PHONE_TWO, /^phoneNumber: /);

  reports(corrupt(dual, { bootId: 'not-a-uuid' }), PHONE_TWO, /^bootId: /);
  reports(corrupt(dual, { createdAt: 'yesterday' }), PHONE_TWO, /^createdAt: /);
  reports(corrupt(dual, { v: 2 }), PHONE_TWO, /^v: expected 1/);
  reports(corrupt(dual, { profile: 'test_one' }), PHONE_TWO, /^profile: "test_one" is not "test_two"/);
});

test('identity: generateIdentity throws on a profile or carrier it cannot honour', () => {
  const base = PHONE_ONE;
  assert.throws(() => generateIdentity(brokenProfile(base, { tacs: [] })), /no TACs/);
  assert.throws(() => generateIdentity(brokenProfile(base, { tacs: ['3510000'] })), /not 8 digits/);
  assert.throws(() => generateIdentity(brokenProfile(base, { tacs: ['3510000X'] })), /not 8 digits/);
  assert.throws(() => generateIdentity(brokenProfile(base, { serial: { length: 5, alphabet: '0123456789' } })), /at least 6/);
  assert.throws(() => generateIdentity(brokenProfile(base, { wifiOuis: [] })), /no Wi-Fi OUIs/);
  assert.throws(() => generateIdentity(brokenProfile(base, { wifiOuis: ['3D:5A:B4'] })), /multicast/);
  assert.throws(() => generateIdentity(brokenProfile(base, { wifiOuis: ['3E:5A:B4'] })), /locally administered/);
  assert.throws(() => generateIdentity(brokenProfile(base, { wifiOuis: ['3C:5A'] })), /not AA:BB:CC/);
  assert.throws(() => generateIdentity(brokenProfile(base, { serial: { length: 8, alphabet: '0123456789', prefix: 'XY' } })), /prefix/);
  assert.throws(() => generateIdentity(base, { seed: seedAt(1), carrier: 'nope_mobile' }), /unknown carrier id "nope_mobile"/);
  assert.throws(() => generateIdentity(base, { seed: 'not-hex' }), /seed: expected a hex string/);
});

test('identity: the carrier list carries real MCC/MNC values with unique ids', () => {
  const ids = new Set(CARRIERS.map((c) => c.id));
  assert.equal(ids.size, CARRIERS.length);
  for (const id of ['tmobile_us', 'att_us', 'verizon_us', 'ee_uk', 'vodafone_uk', 'jio_in', 'airtel_in', 'telekom_de']) {
    assert.ok(ids.has(id), `missing carrier ${id}`);
  }
  assert.deepEqual([carrierById('tmobile_us')?.mcc, carrierById('tmobile_us')?.mnc], ['310', '260']);
  assert.deepEqual([carrierById('att_us')?.mcc, carrierById('att_us')?.mnc], ['310', '410']);
  assert.deepEqual([carrierById('verizon_us')?.mcc, carrierById('verizon_us')?.mnc], ['311', '480']);
  assert.deepEqual([carrierById('ee_uk')?.mcc, carrierById('ee_uk')?.mnc], ['234', '30']);
  assert.deepEqual([carrierById('vodafone_uk')?.mcc, carrierById('vodafone_uk')?.mnc], ['234', '15']);
  assert.deepEqual([carrierById('jio_in')?.mcc, carrierById('jio_in')?.mnc], ['405', '857']);
  assert.deepEqual([carrierById('airtel_in')?.mcc, carrierById('airtel_in')?.mnc], ['404', '10']);
  assert.deepEqual([carrierById('telekom_de')?.mcc, carrierById('telekom_de')?.mnc], ['262', '01']);
  assert.equal(carrierById('mtn_za'), undefined);
  for (const carrier of CARRIERS) {
    assert.match(carrier.mcc, /^\d{3}$/);
    assert.match(carrier.mnc, /^\d{1,3}$/);
    assert.match(carrier.countryIso, /^[a-z]{2}$/);
    assert.match(carrier.countryCallingCode, /^\d{1,3}$/);
  }
});
