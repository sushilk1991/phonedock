import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IOS_TEXT_SIZES, iosTextCategory, iosTextScale, parseAndroidSettingNumber } from './device-settings.ts';

test('iOS content sizes map both ways and clamp to end categories', () => {
  for (const [name, points] of IOS_TEXT_SIZES) {
    assert.equal(iosTextCategory(points / 17), name);
    assert.equal(iosTextScale(name), points / 17);
    assert.equal(iosTextCategory(name), name);
  }
  assert.equal(iosTextCategory('default'), 'large');
  assert.equal(iosTextCategory('smallest'), 'extra-small');
  assert.equal(iosTextCategory('largest'), 'accessibility-extra-extra-extra-large');
  assert.equal(iosTextCategory(0.1), 'extra-small');
  assert.equal(iosTextCategory(99), 'accessibility-extra-extra-extra-large');
  assert.equal(iosTextCategory(1.1), 'extra-large');
  for (let i = 0; i < IOS_TEXT_SIZES.length - 1; i++) {
    assert.equal(iosTextCategory((IOS_TEXT_SIZES[i][1] + IOS_TEXT_SIZES[i + 1][1]) / 34), IOS_TEXT_SIZES[i][0]);
  }
  assert.equal(iosTextScale('unknown'), undefined);
  assert.throws(() => iosTextCategory(0));
  assert.throws(() => iosTextCategory(NaN));
});

test('Android settings output accepts only finite numeric values', () => {
  assert.equal(parseAndroidSettingNumber('1.25\n'), 1.25);
  assert.equal(parseAndroidSettingNumber('-0.5'), -0.5);
  for (const invalid of ['null', '', 'NaN', 'Infinity', '1abc', '0x10', '1\n2']) {
    assert.equal(parseAndroidSettingNumber(invalid), undefined);
  }
});

test('settings validation rejects invalid patches before mutation', async () => {
  const { validateSettingsInput } = await import('./device-settings.ts');
  assert.deepEqual(validateSettingsInput({ textSize: 'largest', boldText: true }), { textSize: 'largest', boldText: true });
  for (const value of [null, [], { textSize: 0 }, { textSize: NaN }, { textSize: 'huge' },
    { boldText: 'true' }, { colorFilter: 'sepia' }, { appearance: 'auto' }, { typo: true }]) {
    assert.throws(() => validateSettingsInput(value));
  }
});
