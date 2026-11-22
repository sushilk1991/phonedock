import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { OsImage } from '../core/types.ts';
import {
  MAGISK_PIN, clonePersistedDisguise, resolveDisguiseCreation, sha256Buffer, type RunCmd,
} from './android-disguise.ts';
import {
  backend, chooseDisguiseImage, imageIdFromSysdir, resolveDisguiseBoot, snapshotFailure, toDevice,
  type AvdEntry,
} from './android-emulator.ts';

test('snapshot save after a Vulkan app: a clear error and a fix, not "try again"', () => {
  const e = snapshotFailure('save', 'KO: Snapshot save is skipped. Reason: UNSUPPORTED_VK_APP\n');
  assert.equal(e.code, 'snapshot_vulkan');
  assert.match(e.hints?.join(' ') ?? '', /Vulkan graphics \(Chrome does\)/);
  assert.match(e.hints?.join(' ') ?? '', /Restart the phone, then save before opening that app/);
});
test('snapshot restore with different emulator features is explained', () => {
  const e = snapshotFailure('load', 'KO: Error -1 from the snapshot callback\nKO: Snapshot load failure: different emulator features');
  assert.equal(e.code, 'snapshot_incompatible');
});
test('other snapshot failures keep their detail', () => {
  const e = snapshotFailure('load', 'KO: Snapshot not found');
  assert.equal(e.code, 'not_found');
  assert.match(snapshotFailure('save', 'KO: weird').detail ?? '', /weird/);
});

test('disguise image selection: prefers installed Play Store arm64 matching profile SDK', () => {
  const imgs: OsImage[] = [
    { id: 'system-images;android-36;google_apis_playstore;arm64-v8a', backend: 'android-emulator', platform: 'android', name: 'API 36', version: '36', installed: true },
    { id: 'system-images;android-34;google_apis;arm64-v8a', backend: 'android-emulator', platform: 'android', name: 'API 34 Google APIs', version: '34', installed: true },
    { id: 'system-images;android-34;google_apis_playstore;arm64-v8a', backend: 'android-emulator', platform: 'android', name: 'API 34 Play Store', version: '34', installed: true },
    { id: 'system-images;android-34;google_apis_playstore;x86_64', backend: 'android-emulator', platform: 'android', name: 'API 34 x86', version: '34', installed: true },
  ];
  assert.equal(chooseDisguiseImage(34, imgs), 'system-images;android-34;google_apis_playstore;arm64-v8a');
  assert.throws(() => chooseDisguiseImage(33, imgs), (e: any) => e.code === 'no_image' && /android-33;google_apis_playstore;arm64-v8a/.test(e.detail ?? ''));
  assert.equal(imageIdFromSysdir('system-images/android-34/google_apis_playstore/arm64-v8a/'), 'system-images;android-34;google_apis_playstore;arm64-v8a');
  assert.equal(imageIdFromSysdir(undefined), undefined);
});

test('listProfiles and toDevice expose sourced real-phone profiles and additive disguise metadata', async () => {
  const profiles = await backend.listProfiles!();
  for (const id of ['pixel_9', 'pixel_8', 'pixel_8a', 'pixel_7a', 'galaxy_s23', 'galaxy_s24', 'oneplus_12']) {
    assert.ok(profiles.some((p) => p.id === id), `missing profile ${id}`);
  }

  const created = resolveDisguiseCreation({ profile: 'pixel_8', carrier: 'ee_uk', seed: '0123456789abcdef0123456789abcdef' }, { imageSdk: 34 })!;
  const disguisedAvd: AvdEntry = {
    name: 'pdtest-vp',
    home: '/tmp/avd',
    avdDir: '/tmp/avd/pdtest-vp.avd',
    managed: true,
    config: {
      'target': 'android-34',
      'image.sysdir.1': 'system-images/android-34/google_apis_playstore/arm64-v8a/',
      'hw.lcd.width': '1080',
      'hw.lcd.height': '2400',
      'hw.lcd.density': '420',
      'hw.device.name': 'Pixel 8',
    },
    meta: { displayName: 'pdtest-vp', disguise: created.persisted },
  };
  const d = toDevice(disguisedAvd, undefined);
  assert.equal(d.model, 'Pixel 8');
  assert.deepEqual(d.meta?.disguise, {
    enabled: true,
    profile: 'pixel_8',
    carrier: 'ee_uk',
    imei: created.identity.imei,
    serial: created.identity.serial,
    wifiMac: created.identity.wifiMac,
    btMac: created.identity.btMac,
    phoneNumber: created.identity.phoneNumber,
    androidId: created.identity.androidId,
  });

  // Non-disguised AVD has no meta.disguise
  const stockDevice = toDevice({ ...disguisedAvd, meta: { displayName: 'pdtest-stock' } }, undefined);
  assert.equal(stockDevice.meta?.disguise, undefined);
});

test('resolveDisguiseBoot: cold miss boots transient stock patcher, warm boot skips cold boot, clone forces fresh ramdisk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-emu-disguise-'));
  try {
    const home = join(dir, 'home');
    const sdkRootDir = join(dir, 'sdk');
    const imgDir = join(sdkRootDir, 'system-images', 'android-34', 'google_apis_playstore', 'arm64-v8a');
    mkdirSync(imgDir, { recursive: true });
    writeFileSync(join(imgDir, 'ramdisk.img'), gzipSync(Buffer.from('stock-ramdisk-34')));

    const avdDir = join(home, 'avd', 'pdtest-vp1.avd');
    mkdirSync(avdDir, { recursive: true });
    const created = resolveDisguiseCreation({ profile: 'pixel_8', carrier: 'tmobile_us', seed: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, { imageSdk: 34 })!;
    const initialMeta = {
      displayName: 'pdtest-vp1',
      spec: { backend: 'android-emulator', name: 'pdtest-vp1', image: 'system-images;android-34;google_apis_playstore;arm64-v8a' },
      disguise: created.persisted,
    };
    writeFileSync(join(avdDir, 'phonedock.json'), JSON.stringify(initialMeta, null, 2));

    const entry: AvdEntry = {
      name: 'pdtest-vp1',
      home: join(home, 'avd'),
      avdDir,
      managed: true,
      config: { 'image.sysdir.1': 'system-images/android-34/google_apis_playstore/arm64-v8a/' },
      meta: initialMeta,
    };

    const fakeApk = Buffer.from('PK\x03\x04fake-magisk');
    const fakeBase = gzipSync(Buffer.from('patched-magisk-34'));
    const pin = { version: 'v31.1-emu-test', url: 'https://example.invalid/magisk.apk', sha256: sha256Buffer(fakeApk), filename: 'Magisk-test.apk' };

    let bootstraps = 0;
    const fakeRun: RunCmd = async (cmd, args) => {
      if (cmd === '/usr/bin/unzip') {
        const libDir = join(args[args.length - 1], 'lib', 'arm64-v8a');
        mkdirSync(libDir, { recursive: true });
        for (const n of MAGISK_PIN.arm64Libs) writeFileSync(join(libDir, `lib${n}.so`), n);
        return { stdout: '', stderr: '', code: 0 };
      }
      if (args[2] === 'shell' && args[3] === 'sh') return { stdout: 'PATCH_OK\n', stderr: '', code: 0 };
      if (args[2] === 'pull') writeFileSync(args[4], fakeBase);
      return { stdout: '', stderr: '', code: 0 };
    };
    const deps = {
      adbBin: '/sdk/platform-tools/adb',
      sdkRootDir,
      home,
      pin,
      runCmd: fakeRun,
      download: async (_url: string, dest: string) => { writeFileSync(dest, fakeApk); },
      withBootstrapSerial: async (fn: (s: string) => Promise<void>) => { bootstraps += 1; await fn('emulator-5570'); },
    };

    // Unmanaged or non-disguised AVD returns undefined and never invokes bootstrap.
    assert.equal(await resolveDisguiseBoot({ ...entry, managed: false }, deps), undefined);
    assert.equal(await resolveDisguiseBoot({ ...entry, meta: { displayName: 'stock' } }, deps), undefined);
    assert.equal(bootstraps, 0);

    // First boot: Tier 1 miss -> bootstrap runs once, forceColdBoot=true, overlaySha256 persisted only on commit().
    const b1 = (await resolveDisguiseBoot(entry, deps))!;
    assert.equal(bootstraps, 1);
    assert.equal(b1.baseCached, false);
    assert.equal(b1.ramdiskCached, false);
    assert.equal(b1.forceColdBoot, true);
    assert.equal(JSON.parse(readFileSync(join(avdDir, 'phonedock.json'), 'utf8')).disguise.overlaySha256, undefined);
    b1.commit();
    const savedMeta = JSON.parse(readFileSync(join(avdDir, 'phonedock.json'), 'utf8'));
    assert.equal(savedMeta.disguise.overlaySha256, b1.overlaySha256);

    // Second boot with persisted overlaySha256: Tier 1 + Tier 2 cache hits, forceColdBoot=false.
    const b2 = (await resolveDisguiseBoot({ ...entry, meta: savedMeta }, deps))!;
    assert.equal(bootstraps, 1);
    assert.equal(b2.baseCached, true);
    assert.equal(b2.ramdiskCached, true);
    assert.equal(b2.forceColdBoot, false);
    assert.equal(b2.ramdiskPath, b1.ramdiskPath);

    // Cloned AVD gets fresh identity (cleared overlaySha256): Tier 1 hit, new Tier 2 ramdisk, forceColdBoot=true.
    const cloneDir = join(home, 'avd', 'pdtest-vp2.avd');
    mkdirSync(cloneDir, { recursive: true });
    const clonedMeta = { ...savedMeta, displayName: 'pdtest-vp2', disguise: clonePersistedDisguise(savedMeta.disguise) };
    writeFileSync(join(cloneDir, 'phonedock.json'), JSON.stringify(clonedMeta, null, 2));
    const bClone = (await resolveDisguiseBoot({ ...entry, name: 'pdtest-vp2', avdDir: cloneDir, meta: clonedMeta }, deps))!;
    assert.equal(bootstraps, 1, 'clone reuses cached Tier 1 base without another bootstrap boot');
    assert.equal(bClone.baseCached, true);
    assert.equal(bClone.ramdiskCached, false);
    assert.equal(bClone.forceColdBoot, true);
    assert.notEqual(bClone.ramdiskPath, b1.ramdiskPath);
    assert.notEqual(bClone.overlaySha256, b1.overlaySha256);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
