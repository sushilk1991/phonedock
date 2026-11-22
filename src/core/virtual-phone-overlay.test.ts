import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { carrierById, generateIdentity } from './device-identity.ts';
import { deviceProfileById } from './device-profiles.ts';
import {
  EMULATOR_PACKAGES,
  defaultBatteryValues,
  gzipDeterministic,
  packCpioNewc,
  renderDisguiseOverlay,
  shellQuote,
  unpackCpioNewc,
  type CpioEntry,
} from './virtual-phone-overlay.ts';

const FIXED_SEED = '0123456789abcdef0123456789abcdef';
const FIXED_NOW = new Date('2025-01-01T00:00:00Z');

test('cpio: golden bytes for a small deterministic SVR4 newc archive', () => {
  const entries: CpioEntry[] = [
    // Deliberately unsorted to verify deterministic LC_ALL=C sorting.
    { path: 'dir/b.txt', kind: 'file', mode: 0o644, content: 'hi\n' },
    { path: 'dir', kind: 'dir', mode: 0o750 },
  ];
  const archive = packCpioNewc(entries);

  // Hand-computed golden SVR4 newc layout:
  // Entry 1: dir (ino=1, mode=00040750 -> 000041e8, nlink=2, size=0, namesize=4 "dir\0", header+name=114 -> +2 pad = 116)
  // Entry 2: dir/b.txt (ino=2, mode=00100644 -> 000081a4, nlink=1, size=3, namesize=10 "dir/b.txt\0", header+name=120 -> 0 pad; data "hi\n" -> +1 pad = 4)
  // Trailer: TRAILER!!! (ino=0, mode=0, nlink=1, size=0, namesize=11, header+name=121 -> +3 pad = 124)
  const expected = Buffer.concat([
    Buffer.from('07070100000001000041e80000000000000000000000020000000000000000000000000000000000000000000000000000000400000000dir\0\0\0', 'binary'),
    Buffer.from('07070100000002000081a40000000000000000000000010000000000000003000000000000000000000000000000000000000a00000000dir/b.txt\0hi\n\0', 'binary'),
    Buffer.from('07070100000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000b00000000TRAILER!!!\0\0\0\0', 'binary'),
  ]);

  assert.equal(archive.length, 116 + 124 + 124);
  assert.deepEqual(archive, expected);

  // Round-trip re-parse matches exact entries & zeroed metadata.
  const parsed = unpackCpioNewc(archive);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], { path: 'dir', kind: 'dir', mode: 0o750, uid: 0, gid: 0, mtime: 0, size: 0, content: Buffer.alloc(0) });
  assert.deepEqual(parsed[1], { path: 'dir/b.txt', kind: 'file', mode: 0o644, uid: 0, gid: 0, mtime: 0, size: 3, content: Buffer.from('hi\n') });
});

test('cpio: gzipDeterministic zeroes mtime and pins OS=Unix for reproducible hashes', () => {
  const raw = packCpioNewc([{ path: 'a', kind: 'file', mode: 0o644, content: 'hello' }]);
  const g1 = gzipDeterministic(raw);
  const g2 = gzipDeterministic(raw);
  assert.deepEqual(g1, g2);
  assert.equal(g1[0], 0x1f);
  assert.equal(g1[1], 0x8b);
  assert.deepEqual([...g1.subarray(4, 8)], [0, 0, 0, 0], 'gzip MTIME must be 0');
  assert.equal(g1[9], 0x03, 'gzip OS byte must be Unix (3)');
  assert.deepEqual(gunzipSync(g1), raw);
});

test('cpio: rejects invalid paths, duplicates, and malformed archives', () => {
  assert.throws(() => packCpioNewc([{ path: '/abs', kind: 'file', mode: 0o644 }]), /relative/);
  assert.throws(() => packCpioNewc([{ path: 'a/../b', kind: 'file', mode: 0o644 }]), /invalid path segment/);
  assert.throws(() => packCpioNewc([
    { path: 'dup', kind: 'file', mode: 0o644, content: '1' },
    { path: 'dup', kind: 'file', mode: 0o644, content: '2' },
  ]), /duplicate/);
  assert.throws(() => packCpioNewc([{ path: 'd', kind: 'dir', mode: 0o755, content: 'nope' }]), /must not have file content/);
  assert.throws(() => unpackCpioNewc(Buffer.from('not-a-cpio')), /truncated|expected magic/);
});

test('overlay: renders Pixel 8 + T-Mobile, round-trips through gunzip + unpackCpioNewc and system cpio', () => {
  const profile = deviceProfileById('pixel_8')!;
  const carrier = carrierById('tmobile_us')!;
  const identity = generateIdentity(profile, { seed: FIXED_SEED, carrier: carrier.id, now: FIXED_NOW });

  const o1 = renderDisguiseOverlay(profile, identity, carrier);
  const o2 = renderDisguiseOverlay(profile, identity, carrier);
  assert.deepEqual(o1.cpioGz, o2.cpioGz, 'rendered overlay must be byte-for-byte deterministic');
  assert.equal(o1.sha256, o2.sha256);
  assert.match(o1.sha256, /^[0-9a-f]{64}$/);

  // Re-parse our gzipped CPIO back into entries and verify every path, mode, and byte content.
  const unpacked = unpackCpioNewc(gunzipSync(o1.cpioGz));
  assert.deepEqual(
    unpacked.map((e) => ({ path: e.path, kind: e.kind, mode: e.mode, uid: e.uid, gid: e.gid, mtime: e.mtime })),
    [
      { path: 'overlay.d', kind: 'dir', mode: 0o750, uid: 0, gid: 0, mtime: 0 },
      { path: 'overlay.d/pd.rc', kind: 'file', mode: 0o644, uid: 0, gid: 0, mtime: 0 },
      { path: 'overlay.d/sbin', kind: 'dir', mode: 0o750, uid: 0, gid: 0, mtime: 0 },
      { path: 'overlay.d/sbin/pd-boot-completed.sh', kind: 'file', mode: 0o750, uid: 0, gid: 0, mtime: 0 },
      { path: 'overlay.d/sbin/pd-post-fs-data.sh', kind: 'file', mode: 0o750, uid: 0, gid: 0, mtime: 0 },
    ],
  );
  const byPath = new Map(unpacked.map((e) => [e.path, e.content.toString('utf8')]));
  assert.equal(byPath.get('overlay.d/pd.rc'), o1.initRc);
  assert.equal(byPath.get('overlay.d/sbin/pd-post-fs-data.sh'), o1.postFsDataScript);
  assert.equal(byPath.get('overlay.d/sbin/pd-boot-completed.sh'), o1.bootCompletedScript);

  // Cross-check with host /usr/bin/cpio -it to guarantee kernel/BSD/GNU compatibility.
  const listing = execFileSync('/usr/bin/cpio', ['-it'], { input: o1.cpio, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] })
    .trim().split('\n').map((s) => s.trim());
  assert.deepEqual(listing, [
    'overlay.d',
    'overlay.d/pd.rc',
    'overlay.d/sbin',
    'overlay.d/sbin/pd-boot-completed.sh',
    'overlay.d/sbin/pd-post-fs-data.sh',
  ]);
});

test('overlay: stage 1 preserves HAL qemu props while stage 2 cleans them and sets carrier/baseband/settings/battery', () => {
  const profile = deviceProfileById('pixel_8')!;
  const carrier = carrierById('ee_uk')!;
  const identity = generateIdentity(profile, { seed: FIXED_SEED, carrier: carrier.id, now: FIXED_NOW });
  const o = renderDisguiseOverlay(profile, identity, carrier);

  // Init RC: pre-zygote hook + one-shot boot-completed service, NO pd-rootd backdoor.
  assert.match(o.initRc, /on post-fs-data/);
  assert.match(o.initRc, /pd-post-fs-data\.sh/);
  assert.match(o.initRc, /oneshot/);
  assert.match(o.initRc, /on property:sys\.boot_completed=1/);
  assert.doesNotMatch(o.initRc, /pd-rootd/);

  // Stage 1 (post-fs-data): verified Pixel 8 identity + carrier + serial, NO blanket vendor.qemu/ro.boot.qemu deletion, NO /data/adb.
  assert.match(o.postFsDataScript, /s 'ro\.build\.fingerprint' 'google\/shiba\/shiba:14\/AP2A\.240605\.024\/11860263:user\/release-keys'/);
  assert.match(o.postFsDataScript, /s 'ro\.bootloader' 'ripcurrent-14\.5-11693900'/);
  assert.match(o.postFsDataScript, /s 'gsm\.version\.baseband' 'g5300i-240308-240517-B-11857457'/);
  assert.match(o.postFsDataScript, new RegExp(`s 'ro\\.serialno' '${identity.serial}'`));
  assert.match(o.postFsDataScript, /s 'gsm\.operator\.alpha' 'EE'/);
  assert.match(o.postFsDataScript, /s 'gsm\.operator\.numeric' '23430'/);
  assert.match(o.postFsDataScript, /s 'gsm\.operator\.iso-country' 'gb'/);
  assert.doesNotMatch(o.postFsDataScript, /vendor\\\.qemu/, 'post-fs-data must NOT wipe vendor.qemu.* before HALs start');
  assert.doesNotMatch(o.postFsDataScript, /\/data\/adb/, 'must not create /data/adb root artifact');

  // Stage 2 (boot-completed): re-asserts carrier + baseband, rewrites gralloc/vulkan/power, cleans qemu/ranchu/init.svc props, sets settings & battery.
  assert.match(o.bootCompletedScript, /s 'ro\.hardware\.gralloc' 'shiba'/);
  assert.match(o.bootCompletedScript, /s 'ro\.hardware\.vulkan' 'shiba'/);
  assert.match(o.bootCompletedScript, /s 'ro\.hardware\.power' 'shiba'/);
  assert.match(o.bootCompletedScript, /s 'dalvik\.vm\.isa\.arm64\.variant' 'armv8-a'/);
  assert.match(o.bootCompletedScript, /s 'gsm\.version\.baseband' 'g5300i-240308-240517-B-11857457'/);
  assert.match(o.bootCompletedScript, /s 'gsm\.sim\.operator\.alpha' 'EE'/);
  assert.match(o.bootCompletedScript, /init\\\.svc\\\.qemu-/);
  assert.match(o.bootCompletedScript, /settings put global device_name 'Pixel 8'/);
  assert.match(o.bootCompletedScript, /settings put global development_settings_enabled 0/);
  assert.doesNotMatch(o.bootCompletedScript, /adb_enabled 0/, 'must not disable adb_enabled and sever PhoneDock control');
  assert.match(o.bootCompletedScript, new RegExp(`settings put secure android_id '${identity.androidId}'`));
  const batt = defaultBatteryValues(identity.seed);
  assert.ok(batt.voltageMv >= 3920 && batt.voltageMv <= 4210 && batt.voltageMv !== 5000);
  assert.match(o.bootCompletedScript, new RegExp(`dumpsys battery set voltage '${batt.voltageMv}'`));
  assert.match(o.bootCompletedScript, /com\.android\.internal\.display\.cutout\.emulation\.hole/);
  for (const pkg of EMULATOR_PACKAGES) {
    assert.ok(o.bootCompletedScript.includes(pkg), `expected package hide for ${pkg}`);
  }
});

test('overlay: omits unverified bootloader/baseband/host and honors Samsung S23 vendor freeze', () => {
  const s23 = deviceProfileById('galaxy_s23')!;
  const carrier = carrierById('att_us')!;
  const identity = generateIdentity(s23, { seed: FIXED_SEED, carrier: carrier.id, now: FIXED_NOW });
  const o = renderDisguiseOverlay(s23, identity, carrier);

  // Samsung S23 vendor fingerprint is Android 13 TP1A while system is Android 14 UP1A.
  assert.match(o.postFsDataScript, /s 'ro\.build\.fingerprint' 'samsung\/dm1qxxx\/dm1q:14\/UP1A\.231005\.007\/S911BXXS5CXDE:user\/release-keys'/);
  assert.match(o.postFsDataScript, /s 'ro\.vendor\.build\.fingerprint' 'samsung\/dm1qxxx\/dm1q:13\/TP1A\.220624\.014\/S911BXXS5CXDE:user\/release-keys'/);
  // Unverified fields must not be emitted.
  assert.doesNotMatch(o.postFsDataScript, /ro\.bootloader/);
  assert.doesNotMatch(o.postFsDataScript, /gsm\.version\.baseband/);
  assert.doesNotMatch(o.bootCompletedScript, /gsm\.version\.baseband/);
  // AT&T carrier name contains '&' — verify it is safely single-quoted.
  assert.match(o.postFsDataScript, /s 'gsm\.operator\.alpha' 'AT&T'/);
  assert.match(o.bootCompletedScript, /s 'gsm\.sim\.operator\.alpha' 'AT&T'/);
});

test('overlay: shellQuote safety, profile/carrier mismatch checks, and optional teardown flag', () => {
  assert.equal(shellQuote("it's $(bad)"), "'it'\\''s $(bad)'");
  assert.throws(() => shellQuote('bad\0val'), /NUL/);

  const p8 = deviceProfileById('pixel_8')!;
  const p8a = deviceProfileById('pixel_8a')!;
  const tm = carrierById('tmobile_us')!;
  const ee = carrierById('ee_uk')!;
  const id = generateIdentity(p8, { seed: FIXED_SEED, carrier: tm.id, now: FIXED_NOW });

  assert.throws(() => renderDisguiseOverlay(p8a, id, tm), /does not match profile/);
  assert.throws(() => renderDisguiseOverlay(p8, id, ee), /does not match carrier/);

  const withTeardown = renderDisguiseOverlay(p8, id, tm, { teardownMagisk: true, hideEmulatorPackages: false, cutoutOverlay: false });
  assert.match(withTeardown.bootCompletedScript, /umount -l "\$MAGISKTMP"/);
  assert.doesNotMatch(withTeardown.bootCompletedScript, /pm disable-user/);
  assert.doesNotMatch(withTeardown.bootCompletedScript, /cutout\.emulation\.hole/);
});
