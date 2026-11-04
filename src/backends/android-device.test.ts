import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayName, mdnsSerial, transportRank } from './android-device.ts';

test('mdnsSerial: reads the hardware serial from an auto-connected Wireless debugging name', () => {
  assert.equal(mdnsSerial('adb-AB12CD34EF56789-x7q2pf._adb-tls-connect._tcp'), 'AB12CD34EF56789');
  assert.equal(mdnsSerial('192.168.0.42:39525'), undefined);
  assert.equal(mdnsSerial('AB12CD34EF56789'), undefined);
});

test('transportRank: USB before Wireless debugging before adb tcpip', () => {
  const order = ['192.168.0.42:5555', '192.168.0.42:39525', 'AB12CD34EF56789', 'adb-AB12CD34EF56789-x7q2pf._adb-tls-connect._tcp']
    .sort((a, b) => transportRank(a) - transportRank(b));
  assert.equal(order[0], 'AB12CD34EF56789');
  assert.equal(order[3], '192.168.0.42:5555');
});

test('displayName: a set device name wins, else brand + model without repeating the brand', () => {
  assert.equal(displayName('V2246', { brand: 'vivo', deviceName: 'V2246' }), 'vivo V2246');
  assert.equal(displayName('Pixel 9', { brand: 'google', deviceName: 'Ada’s Pixel' }), 'Ada’s Pixel');
  assert.equal(displayName('Pixel 9', { brand: 'google' }), 'Google Pixel 9');
  assert.equal(displayName('Galaxy S24', { brand: 'galaxy' }), 'Galaxy S24');
  assert.equal(displayName(undefined, { brand: 'vivo' }), undefined);
});
