import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { carrierById, generateIdentity } from '../core/device-identity.ts';
import { deviceProfileById } from '../core/device-profiles.ts';
import { unpackCpioNewc } from '../core/virtual-phone-overlay.ts';
import {
  GUEST_PATCH_DIR,
  MAGISK_PIN,
  assembleDisguisedRamdisk,
  baseRamdiskCachePath,
  buildMagiskPatchCommands,
  clonePersistedDisguise,
  deviceRamdiskCachePath,
  disguiseDeviceMeta,
  ensureMagiskApk,
  imageSlug,
  parseDisguiseOption,
  patchBaseRamdiskInGuest,
  prepareDisguiseRamdisk,
  resolveDisguiseCreation,
  sha256Buffer,
  type RunCmd,
} from './android-disguise.ts';

function withTempDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'pd-disguise-test-'));
  return Promise.resolve().then(() => fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const IMAGE_ID = 'system-images;android-34;google_apis_playstore;arm64-v8a';
const FIXED_SEED = 'abcdef0123456789abcdef0123456789';

test('disguise options: parsing, profile/carrier/SDK resolution, and clone fresh identity', () => {
  assert.equal(parseDisguiseOption(undefined), undefined);
  assert.equal(parseDisguiseOption(false), undefined);
  assert.equal(parseDisguiseOption({ enabled: false, profile: 'pixel_8' }), undefined);
  assert.deepEqual(parseDisguiseOption(true), { enabled: true });
  assert.deepEqual(parseDisguiseOption('galaxy_s24'), { enabled: true, profile: 'galaxy_s24' });
  assert.deepEqual(parseDisguiseOption({ profile: 'oneplus_12', carrier: 'ee_uk', seed: FIXED_SEED }), {
    enabled: true, profile: 'oneplus_12', carrier: 'ee_uk', seed: FIXED_SEED,
  });
  assert.throws(() => parseDisguiseOption('   '), /cannot be empty/);
  assert.throws(() => parseDisguiseOption(42), /must be a boolean/);

  // Defaults + explicit options
  const def = resolveDisguiseCreation(true, { imageSdk: 34 })!;
  assert.equal(def.profile.id, 'pixel_8');
  assert.equal(def.carrier.id, 'tmobile_us');
  assert.equal(def.persisted.v, 1);

  const fromSpecProf = resolveDisguiseCreation(true, { specProfile: 'pixel_8a', imageSdk: 34 })!;
  assert.equal(fromSpecProf.profile.id, 'pixel_8a');

  // SDK mismatch rejected honestly instead of lying about ro.build.version.sdk
  assert.throws(
    () => resolveDisguiseCreation('pixel_8', { imageSdk: 36 }),
    (e: any) => e.code === 'sdk_mismatch' && /API 34/.test(e.message) && /API 36/.test(e.message),
  );
  assert.throws(() => resolveDisguiseCreation('nonexistent_phone'), /Unknown virtual phone profile/);
  assert.throws(() => resolveDisguiseCreation({ profile: 'pixel_8', carrier: 'mars_tel' }), /Unknown carrier/);
  assert.throws(() => resolveDisguiseCreation({ profile: 'pixel_8', seed: 'not-hex' }), /Invalid disguise identity/);

  // Public meta summary
  const meta = disguiseDeviceMeta(def.persisted);
  assert.equal(meta.enabled, true);
  assert.equal(meta.profile, 'pixel_8');
  assert.equal(meta.imei, def.identity.imei);
  assert.equal(meta.serial, def.identity.serial);

  // Clone gets a brand-new identity for the same profile & carrier and clears cached overlay hash.
  const srcWithHash = { ...def.persisted, overlaySha256: 'deadbeef' };
  const cloned = clonePersistedDisguise(srcWithHash);
  assert.equal(cloned.profile, srcWithHash.profile);
  assert.equal(cloned.identity.carrier, srcWithHash.identity.carrier);
  assert.equal(cloned.overlaySha256, undefined);
  assert.notEqual(cloned.identity.seed, srcWithHash.identity.seed);
  assert.notEqual(cloned.identity.imei, srcWithHash.identity.imei);
  assert.notEqual(cloned.identity.serial, srcWithHash.identity.serial);
  assert.notEqual(cloned.identity.androidId, srcWithHash.identity.androidId);
  assert.notEqual(cloned.identity.wifiMac, srcWithHash.identity.wifiMac);
});

test('cache paths: deterministic two-tier layout under PHONEDOCK_HOME/virtual-phones and safe slug validation', async () => {
  await withTempDir((home) => {
    assert.equal(imageSlug(IMAGE_ID), 'android-34_google_apis_playstore_arm64-v8a');
    assert.throws(() => imageSlug('not-an-image'), /Invalid Android system image id/);
    assert.throws(() => imageSlug('system-images;..;bad;arm64-v8a'), /Unsafe Android system image id/);

    const basePath = baseRamdiskCachePath(IMAGE_ID, 'ABCDEF0123456789', home);
    assert.equal(
      basePath,
      join(home, 'virtual-phones', 'base', `android-34_google_apis_playstore_arm64-v8a-abcdef012345-magisk-${MAGISK_PIN.version}.img`),
    );

    const devPath = deviceRamdiskCachePath('1111222233334444', 'aaaa555566667777', home);
    assert.equal(devPath, join(home, 'virtual-phones', 'ramdisks', '111122223333-aaaa55556666.img'));
  });
});

test('ensureMagiskApk: verifies SHA-256, caches hits, and rejects corrupted downloads without poisoning cache', async () => {
  await withTempDir(async (home) => {
    const fakeApkBytes = Buffer.from('PK\x03\x04fake-magisk-apk-payload');
    const pin = {
      version: 'v31.1-test',
      url: 'https://example.invalid/Magisk-v31.1-test.apk',
      sha256: sha256Buffer(fakeApkBytes),
      filename: 'Magisk-v31.1-test.apk',
    };

    let downloads = 0;
    const goodDownload = async (_url: string, dest: string) => {
      downloads += 1;
      writeFileSync(dest, fakeApkBytes);
    };

    // Corrupt download fails and does NOT leave a cached APK behind.
    await assert.rejects(
      () => ensureMagiskApk({
        home,
        pin,
        download: async (_url, dest) => { writeFileSync(dest, Buffer.from('tampered')); },
      }),
      (e: any) => e.code === 'checksum_mismatch',
    );
    assert.equal(existsSync(join(home, 'virtual-phones', 'magisk', pin.filename)), false);

    // Good download populates cache.
    const r1 = await ensureMagiskApk({ home, pin, download: goodDownload });
    assert.equal(r1.cached, false);
    assert.equal(downloads, 1);
    assert.ok(existsSync(r1.apkPath));

    // Second call is a pure cache hit (no download).
    const r2 = await ensureMagiskApk({ home, pin, download: goodDownload });
    assert.equal(r2.cached, true);
    assert.equal(r2.apkPath, r1.apkPath);
    assert.equal(downloads, 1);

    // Corrupted cached file is detected and transparently re-downloaded.
    writeFileSync(r1.apkPath, Buffer.from('bit-rot'));
    const r3 = await ensureMagiskApk({ home, pin, download: goodDownload });
    assert.equal(r3.cached, false);
    assert.equal(downloads, 2);
    assert.deepEqual(readFileSync(r3.apkPath), fakeApkBytes);
  });
});

test('in-guest magiskboot patch: argv arrays with explicit -s <serial>, atomic output, and guaranteed guest cleanup', async () => {
  await withTempDir(async (dir) => {
    const libsDir = join(dir, 'libs');
    mkdirSync(libsDir, { recursive: true });
    for (const n of MAGISK_PIN.arm64Libs) writeFileSync(join(libsDir, `lib${n}.so`), `elf-${n}`);
    const stockRamdisk = join(dir, 'ramdisk.img');
    writeFileSync(stockRamdisk, gzipSync(Buffer.from('stock-ramdisk')));
    const outPath = join(dir, 'cache', 'ramdisk.magisk.img');

    const plan = buildMagiskPatchCommands({
      serial: 'emulator-5560',
      adbBin: '/sdk/platform-tools/adb',
      stockRamdiskPath: stockRamdisk,
      extractedLibsDir: libsDir,
      patchScriptLocalPath: join(dir, 'patch.sh'),
      outTempPath: `${outPath}.tmp`,
    });
    // Every single command must target -s emulator-5560 explicitly via argv arrays.
    for (const step of [...plan.steps, plan.cleanup]) {
      assert.equal(step.cmd, '/sdk/platform-tools/adb');
      assert.deepEqual(step.args.slice(0, 2), ['-s', 'emulator-5560']);
    }
    assert.equal(plan.steps.filter((s) => s.args[2] === 'push').length, 6); // 4 libs + ramdisk + patch.sh

    const fakePatched = gzipSync(Buffer.from('magisk-patched-base-ramdisk'));
    const seen: string[][] = [];
    const fakeRun: RunCmd = async (cmd, args) => {
      seen.push([cmd, ...args]);
      if (args[2] === 'shell' && args[3] === 'sh') return { stdout: 'KEEPVERITY=true\nPATCH_OK\n', stderr: '', code: 0 };
      if (args[2] === 'pull') {
        const dest = args[4];
        writeFileSync(dest, fakePatched);
      }
      return { stdout: '', stderr: '', code: 0 };
    };

    const res = await patchBaseRamdiskInGuest(
      {
        serial: 'emulator-5560',
        adbBin: '/sdk/platform-tools/adb',
        stockRamdiskPath: stockRamdisk,
        extractedLibsDir: libsDir,
        outBaseRamdiskPath: outPath,
      },
      { runCmd: fakeRun },
    );
    assert.equal(res.baseRamdiskPath, outPath);
    assert.equal(res.sha256, sha256Buffer(fakePatched));
    assert.deepEqual(readFileSync(outPath), fakePatched);
    assert.deepEqual(seen[seen.length - 1], ['/sdk/platform-tools/adb', '-s', 'emulator-5560', 'shell', 'rm', '-rf', GUEST_PATCH_DIR]);

    // Failure during patch.sh must STILL run guest cleanup and leave no temp/output file.
    const outFail = join(dir, 'cache', 'ramdisk.fail.img');
    const failSeen: string[][] = [];
    const failRun: RunCmd = async (cmd, args) => {
      failSeen.push([cmd, ...args]);
      if (args[2] === 'shell' && args[3] === 'sh') return { stdout: 'boom without sentinel', stderr: 'err', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    };
    await assert.rejects(
      () => patchBaseRamdiskInGuest(
        {
          serial: 'emulator-5560',
          adbBin: '/sdk/platform-tools/adb',
          stockRamdiskPath: stockRamdisk,
          extractedLibsDir: libsDir,
          outBaseRamdiskPath: outFail,
        },
        { runCmd: failRun },
      ),
      (e: any) => e.code === 'patch_failed',
    );
    assert.equal(existsSync(outFail), false);
    assert.deepEqual(failSeen[failSeen.length - 1], ['/sdk/platform-tools/adb', '-s', 'emulator-5560', 'shell', 'rm', '-rf', GUEST_PATCH_DIR]);
  });
});

test('two-tier ramdisk pipeline: cold patch -> warm hit -> distinct identity reuses Tier 1 base', async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, 'home');
    const stockRamdisk = join(dir, 'stock-ramdisk.img');
    writeFileSync(stockRamdisk, gzipSync(Buffer.from('stock-android-34-ramdisk')));
    const fakeBaseMagisk = gzipSync(Buffer.from('patched-magisk-base'));

    const fakeApk = Buffer.from('PK\x03\x04fake-magisk-v31.1');
    const pin = {
      version: 'v31.1-fake',
      url: 'https://example.invalid/Magisk-v31.1-fake.apk',
      sha256: sha256Buffer(fakeApk),
      filename: 'Magisk-v31.1-fake.apk',
    };
    const profile = deviceProfileById('pixel_8')!;
    const carrier = carrierById('tmobile_us')!;
    const id1 = generateIdentity(profile, { seed: FIXED_SEED, carrier: carrier.id });
    const id2 = generateIdentity(profile, { seed: '11111111111111111111111111111111', carrier: 'ee_uk' });

    let downloads = 0;
    let bootstraps = 0;
    const fakeRun: RunCmd = async (cmd, args) => {
      if (cmd === '/usr/bin/unzip') {
        const outDir = args[args.length - 1];
        const libDir = join(outDir, 'lib', 'arm64-v8a');
        mkdirSync(libDir, { recursive: true });
        for (const n of MAGISK_PIN.arm64Libs) writeFileSync(join(libDir, `lib${n}.so`), `elf-${n}`);
        return { stdout: '', stderr: '', code: 0 };
      }
      if (args[2] === 'shell' && args[3] === 'sh') return { stdout: 'PATCH_OK\n', stderr: '', code: 0 };
      if (args[2] === 'pull') writeFileSync(args[4], fakeBaseMagisk);
      return { stdout: '', stderr: '', code: 0 };
    };
    const deps = {
      adbBin: '/sdk/platform-tools/adb',
      home,
      pin,
      runCmd: fakeRun,
      download: async (_url: string, dest: string) => { downloads += 1; writeFileSync(dest, fakeApk); },
      withBootstrapSerial: async (fn: (s: string) => Promise<void>) => {
        bootstraps += 1;
        await fn('emulator-5562');
      },
    };

    // Device 1 cold start: downloads Magisk, extracts libs, runs bootstrap patch once, assembles Tier 2.
    const p1 = await prepareDisguiseRamdisk(
      { imageId: IMAGE_ID, stockRamdiskPath: stockRamdisk, disguise: { v: 1, profile: profile.id, identity: id1 } },
      deps,
    );
    assert.equal(p1.baseCached, false);
    assert.equal(p1.ramdiskCached, false);
    assert.equal(downloads, 1);
    assert.equal(bootstraps, 1);

    // Verify byte structure: exact base || overlay.cpio.gz, and the tail unpacks to overlay.d/ with id1's serial!
    const fullBytes = readFileSync(p1.ramdiskPath);
    assert.deepEqual(fullBytes.subarray(0, fakeBaseMagisk.length), fakeBaseMagisk);
    const tailGz = fullBytes.subarray(fakeBaseMagisk.length);
    const entries = unpackCpioNewc(gunzipSync(tailGz));
    const postFs = entries.find((e) => e.path === 'overlay.d/sbin/pd-post-fs-data.sh')!.content.toString('utf8');
    assert.ok(postFs.includes(id1.serial), 'appended overlay must embed device 1 serial');

    // Device 1 second boot: BOTH Tier 1 and Tier 2 hit! Zero downloads, zero bootstrap boots.
    const p1Again = await prepareDisguiseRamdisk(
      { imageId: IMAGE_ID, stockRamdiskPath: stockRamdisk, disguise: { v: 1, profile: profile.id, identity: id1 } },
      deps,
    );
    assert.equal(p1Again.baseCached, true);
    assert.equal(p1Again.ramdiskCached, true);
    assert.equal(p1Again.ramdiskPath, p1.ramdiskPath);
    assert.equal(downloads, 1);
    assert.equal(bootstraps, 1);

    // Device 2 (different identity/carrier) on same image: Tier 1 hit, fresh Tier 2 ramdisk!
    const p2 = await prepareDisguiseRamdisk(
      { imageId: IMAGE_ID, stockRamdiskPath: stockRamdisk, disguise: { v: 1, profile: profile.id, identity: id2 } },
      deps,
    );
    assert.equal(p2.baseCached, true);
    assert.equal(p2.ramdiskCached, false);
    assert.equal(bootstraps, 1);
    assert.notEqual(p2.ramdiskPath, p1.ramdiskPath);
    assert.notEqual(p2.overlaySha256, p1.overlaySha256);

    // Corrupt non-gzip base ramdisk is rejected explicitly.
    const badBase = join(dir, 'bad-base.img');
    writeFileSync(badBase, fakeApk);
    assert.throws(
      () => assembleDisguisedRamdisk({ baseRamdiskPath: badBase, profile, identity: id1, carrier, home }),
      (e: any) => e.code === 'corrupt_cache',
    );
  });
});
