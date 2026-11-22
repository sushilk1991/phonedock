// Managed Magisk + overlay ramdisk pipeline for disguised Android Emulator virtual phones.
//
// Two-tier cache under `$PHONEDOCK_HOME/virtual-phones/`:
//   Tier 1 (shared per system image):
//     magisk/Magisk-<ver>.apk                                  (pinned release, SHA-256 verified)
//     base/<imageSlug>-<stockSha12>-magisk-<ver>.img           (patched once via in-guest magiskboot)
//   Tier 2 (per unique base + rendered overlay):
//     ramdisks/<baseSha12>-<overlaySha12>.img                  (base || deterministic overlay.cpio.gz)
//
// External binaries (`adb`, `/usr/bin/unzip`) are always invoked via `src/core/exec.ts` with argv
// arrays — never shell strings.

import { createHash } from 'node:crypto';
import {
  createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  CARRIERS, carrierById, generateIdentity,
  type Carrier, type DeviceIdentity,
} from '../core/device-identity.ts';
import {
  DEVICE_PROFILES, defaultDeviceProfile, deviceProfileById, findDeviceProfile,
  type ResolvedDeviceProfile,
} from '../core/device-profiles.ts';
import { run, type RunOptions } from '../core/exec.ts';
import { stateDir, toolEnv } from '../core/paths.ts';
import { PhoneDockError, type ExecResult } from '../core/types.ts';
import { renderDisguiseOverlay, type OverlayOptions } from '../core/virtual-phone-overlay.ts';

/** Pinned upstream Magisk release used to patch AVD ramdisks. Verified by SHA-256 before extraction. */
export const MAGISK_PIN = {
  version: 'v31.1',
  url: 'https://github.com/topjohnwu/Magisk/releases/download/v31.1/Magisk-v31.1.apk',
  sha256: '89cefac0a318afa39fb3880c45c87b036c05bc1ebf02a7a715b7f8d7c26ac6e7',
  filename: 'Magisk-v31.1.apk',
  arm64Libs: ['magisk', 'magiskboot', 'magiskinit', 'init-ld'] as const,
} as const;

export const GUEST_PATCH_DIR = '/data/local/tmp/pdvp';
/** Default carrier for disguised virtual phones (avoids the emulator's hardcoded 310260 T-Mobile default). */
export const DEFAULT_CARRIER_ID = 'att_us';

/** In-guest POSIX shell script that runs Magisk's arm64 `magiskboot` against an AVD's stock ramdisk.img. */
export const GUEST_MAGISK_PATCH_SCRIPT = [
  '#!/system/bin/sh',
  'set -e',
  `cd ${GUEST_PATCH_DIR}`,
  'chmod 755 magisk magiskboot magiskinit init-ld',
  'rm -f ramdisk.cpio ramdisk.cpio.orig config *.xz ramdisk.magisk.img',
  './magiskboot decompress ramdisk.img ramdisk.cpio',
  'cp ramdisk.cpio ramdisk.cpio.orig',
  '{ echo KEEPVERITY=true; echo KEEPFORCEENCRYPT=true; echo "PREINITDEVICE=$(./magisk --preinit-device)"; } > config',
  './magiskboot compress=xz magisk magisk.xz',
  './magiskboot compress=xz init-ld init-ld.xz',
  './magiskboot cpio ramdisk.cpio \\',
  '  "add 0750 init magiskinit" "mkdir 0750 overlay.d" "mkdir 0750 overlay.d/sbin" \\',
  '  "add 0644 overlay.d/sbin/magisk.xz magisk.xz" "add 0644 overlay.d/sbin/init-ld.xz init-ld.xz" \\',
  '  "patch" "backup ramdisk.cpio.orig" "mkdir 000 .backup" "add 000 .backup/.magisk config"',
  './magiskboot compress=gzip ramdisk.cpio ramdisk.magisk.img',
  'echo PATCH_OK',
  '',
].join('\n');

// ---------------------------------------------------------------- options & persisted state

export interface DisguiseOptions {
  enabled?: boolean;
  profile?: string;
  carrier?: string;
  seed?: string;
  teardownMagisk?: boolean;
}

export interface PersistedDisguise {
  v: 1;
  profile: string;
  identity: DeviceIdentity;
  overlaySha256?: string;
  teardownMagisk?: boolean;
}

export interface DisguiseDeviceMeta {
  enabled: true;
  profile: string;
  carrier: string;
  imei: string;
  serial: string;
  wifiMac: string;
  btMac: string;
  phoneNumber: string;
  androidId: string;
}

/** Parse `DeviceSpec.options.disguise`: `boolean | string (profileId) | DisguiseOptions`. */
export function parseDisguiseOption(raw: unknown): DisguiseOptions | undefined {
  if (raw === undefined || raw === null || raw === false) return undefined;
  if (raw === true) return { enabled: true };
  if (typeof raw === 'string') {
    const profile = raw.trim();
    if (!profile) throw new PhoneDockError('disguise profile name cannot be empty', 'bad_request', 400);
    return { enabled: true, profile };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PhoneDockError(
      'options.disguise must be a boolean, a profile id string, or an object',
      'bad_request',
      400,
    );
  }
  const obj = raw as Record<string, unknown>;
  if (obj.enabled === false) return undefined;
  if (obj.enabled !== undefined && typeof obj.enabled !== 'boolean') {
    throw new PhoneDockError('options.disguise.enabled must be a boolean', 'bad_request', 400);
  }
  const out: DisguiseOptions = { enabled: true };
  if (obj.profile !== undefined) {
    if (typeof obj.profile !== 'string' || !obj.profile.trim()) {
      throw new PhoneDockError('options.disguise.profile must be a non-empty string', 'bad_request', 400);
    }
    out.profile = obj.profile.trim();
  }
  if (obj.carrier !== undefined) {
    if (typeof obj.carrier !== 'string' || !obj.carrier.trim()) {
      throw new PhoneDockError('options.disguise.carrier must be a non-empty string', 'bad_request', 400);
    }
    out.carrier = obj.carrier.trim();
  }
  if (obj.seed !== undefined) {
    if (typeof obj.seed !== 'string' || !obj.seed.trim()) {
      throw new PhoneDockError('options.disguise.seed must be a non-empty hex string', 'bad_request', 400);
    }
    out.seed = obj.seed.trim();
  }
  if (obj.teardownMagisk !== undefined) {
    if (typeof obj.teardownMagisk !== 'boolean') {
      throw new PhoneDockError('options.disguise.teardownMagisk must be a boolean', 'bad_request', 400);
    }
    out.teardownMagisk = obj.teardownMagisk;
  }
  return out;
}

export interface ResolvedDisguiseCreation {
  profile: ResolvedDeviceProfile;
  carrier: Carrier;
  identity: DeviceIdentity;
  persisted: PersistedDisguise;
}

/**
 * Resolve the profile, carrier, and deterministic identity for a newly created disguised device.
 * Refuses an explicit SDK mismatch so `ro.build.version.sdk` is never spoofed away from the real image.
 */
export function resolveDisguiseCreation(
  rawOption: unknown,
  ctx: { specProfile?: string; imageSdk?: number; now?: Date } = {},
): ResolvedDisguiseCreation | undefined {
  const opt = parseDisguiseOption(rawOption);
  if (!opt) return undefined;

  let profile: ResolvedDeviceProfile | undefined;
  if (opt.profile) {
    profile = findDeviceProfile(opt.profile);
    if (!profile) {
      throw new PhoneDockError(
        `Unknown virtual phone profile "${opt.profile}"`,
        'bad_request',
        400,
        [`Available profiles: ${DEVICE_PROFILES.map((p) => p.id).join(', ')}`],
      );
    }
  } else if (ctx.specProfile) {
    profile = findDeviceProfile(ctx.specProfile) ?? defaultDeviceProfile(ctx.imageSdk);
  } else {
    profile = defaultDeviceProfile(ctx.imageSdk);
  }

  if (ctx.imageSdk !== undefined && ctx.imageSdk !== profile.sdk) {
    throw new PhoneDockError(
      `Profile "${profile.id}" requires Android ${profile.androidRelease} (API ${profile.sdk}), but the chosen system image is API ${ctx.imageSdk}`,
      'sdk_mismatch',
      400,
      [`Use system-images;android-${profile.sdk};google_apis_playstore;arm64-v8a (or omit image to let PhoneDock pick a matching one).`],
    );
  }

  const carrierId = opt.carrier ?? DEFAULT_CARRIER_ID;
  const carrier = carrierById(carrierId);
  if (!carrier) {
    throw new PhoneDockError(
      `Unknown carrier "${carrierId}"`,
      'bad_request',
      400,
      [`Available carriers: ${CARRIERS.map((c) => c.id).join(', ')}`],
    );
  }

  let identity: DeviceIdentity;
  try {
    identity = generateIdentity(profile, { carrier: carrier.id, seed: opt.seed, now: ctx.now });
  } catch (e) {
    throw new PhoneDockError(
      `Invalid disguise identity options: ${(e as Error).message}`,
      'bad_request',
      400,
    );
  }

  const persisted: PersistedDisguise = {
    v: 1,
    profile: profile.id,
    identity,
    ...(opt.teardownMagisk !== undefined ? { teardownMagisk: opt.teardownMagisk } : {}),
  };
  return { profile, carrier, identity, persisted };
}

/** Generate a fresh identity (new random seed, same profile & carrier) when cloning a disguised AVD. */
export function clonePersistedDisguise(src: PersistedDisguise, now?: Date): PersistedDisguise {
  const profile = deviceProfileById(src.profile);
  if (!profile) {
    throw new PhoneDockError(`Cannot clone disguised device: unknown profile "${src.profile}"`, 'bad_request', 400);
  }
  const identity = generateIdentity(profile, { carrier: src.identity.carrier, now });
  return {
    v: 1,
    profile: profile.id,
    identity,
    ...(src.teardownMagisk !== undefined ? { teardownMagisk: src.teardownMagisk } : {}),
  };
}

/** Public summary placed on `Device.meta.disguise`. */
export function disguiseDeviceMeta(d: PersistedDisguise): DisguiseDeviceMeta {
  return {
    enabled: true,
    profile: d.profile,
    carrier: d.identity.carrier,
    imei: d.identity.imei,
    serial: d.identity.serial,
    wifiMac: d.identity.wifiMac,
    btMac: d.identity.btMac,
    phoneNumber: d.identity.phoneNumber,
    androidId: d.identity.androidId,
  };
}

// ---------------------------------------------------------------- hashing & cache paths

export function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function sha256File(path: string): string {
  return sha256Buffer(readFileSync(path));
}

export function isGzipBuffer(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

export function verifyFileSha256(path: string, expectedSha256: string, label: string): void {
  if (!existsSync(path)) {
    throw new PhoneDockError(`${label} is missing at ${path}`, 'not_found', 500);
  }
  const actual = sha256File(path).toLowerCase();
  const expected = expectedSha256.toLowerCase();
  if (actual !== expected) {
    throw new PhoneDockError(
      `${label} SHA-256 mismatch`,
      'checksum_mismatch',
      502,
      ['Delete the cached file and retry the download.'],
      `expected ${expected}, got ${actual} (${path})`,
    );
  }
}

/** Root directory for virtual-phone caches (`$PHONEDOCK_HOME/virtual-phones`). */
export function virtualPhonesRoot(home?: string): string {
  if (home) {
    const dir = join(home, 'virtual-phones');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }
  return stateDir('virtual-phones');
}

/** Convert an Android SDK image id (`system-images;android-34;google_apis_playstore;arm64-v8a`) to a safe filename slug. */
export function imageSlug(imageId: string): string {
  const parts = imageId.split(';');
  if (parts.length !== 4 || parts[0] !== 'system-images') {
    throw new PhoneDockError(`Invalid Android system image id "${imageId}"`, 'bad_request', 400);
  }
  const body = parts.slice(1).join('_');
  if (!/^[A-Za-z0-9._-]+$/.test(body) || body.includes('..')) {
    throw new PhoneDockError(`Unsafe Android system image id "${imageId}"`, 'bad_request', 400);
  }
  return body;
}

export function magiskApkCachePath(home?: string, pin: { filename: string } = MAGISK_PIN): string {
  return join(virtualPhonesRoot(home), 'magisk', pin.filename);
}

/** Tier 1 cache path: Magisk-patched base ramdisk per `(imageId, stockRamdiskSha256, magiskVersion)`. */
export function baseRamdiskCachePath(
  imageId: string,
  stockRamdiskSha256: string,
  home?: string,
  magiskVersion: string = MAGISK_PIN.version,
): string {
  if (!/^[0-9a-f]{12,}$/i.test(stockRamdiskSha256)) {
    throw new PhoneDockError(`Invalid ramdisk SHA-256 "${stockRamdiskSha256}"`, 'bad_request', 400);
  }
  const ver = magiskVersion.replace(/[^A-Za-z0-9._-]+/g, '_');
  return join(virtualPhonesRoot(home), 'base', `${imageSlug(imageId)}-${stockRamdiskSha256.slice(0, 12).toLowerCase()}-magisk-${ver}.img`);
}

/** Tier 2 cache path: per-device ramdisk (`base || overlay.cpio.gz`) keyed by `(baseSha256, overlaySha256)`. */
export function deviceRamdiskCachePath(
  baseRamdiskSha256: string,
  overlaySha256: string,
  home?: string,
): string {
  if (!/^[0-9a-f]{12,}$/i.test(baseRamdiskSha256) || !/^[0-9a-f]{12,}$/i.test(overlaySha256)) {
    throw new PhoneDockError('Invalid base or overlay SHA-256 for ramdisk cache key', 'bad_request', 400);
  }
  return join(
    virtualPhonesRoot(home),
    'ramdisks',
    `${baseRamdiskSha256.slice(0, 12).toLowerCase()}-${overlaySha256.slice(0, 12).toLowerCase()}.img`,
  );
}

export interface BaseRamdiskLookup {
  stockSha256: string;
  cachePath: string;
  exists: boolean;
}

export function findCachedBaseRamdisk(
  imageId: string,
  stockRamdiskPath: string,
  home?: string,
): BaseRamdiskLookup {
  if (!existsSync(stockRamdiskPath)) {
    throw new PhoneDockError(
      `Stock ramdisk.img not found for ${imageId}`,
      'not_found',
      404,
      ['Reinstall the Android system image.'],
      stockRamdiskPath,
    );
  }
  const stockSha256 = sha256File(stockRamdiskPath);
  const cachePath = baseRamdiskCachePath(imageId, stockSha256, home);
  return { stockSha256, cachePath, exists: existsSync(cachePath) };
}

// ---------------------------------------------------------------- Magisk download & extraction

export type RunCmd = (cmd: string, args: string[], opts?: RunOptions) => Promise<ExecResult>;
export type DownloadFn = (url: string, destPath: string) => Promise<void>;

async function defaultDownload(url: string, destPath: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new PhoneDockError(
      `Failed to download Magisk (${res.status} ${res.statusText})`,
      'download_failed',
      502,
      ['Check internet connectivity and retry.'],
      url,
    );
  }
  mkdirSync(dirname(destPath), { recursive: true });
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(destPath));
}

export interface EnsureMagiskDeps {
  home?: string;
  download?: DownloadFn;
  onProgress?: (line: string) => void;
  pin?: { version: string; url: string; sha256: string; filename: string };
}

/** Ensure the pinned Magisk APK is cached locally and passes SHA-256 verification. */
export async function ensureMagiskApk(deps: EnsureMagiskDeps = {}): Promise<{ apkPath: string; cached: boolean }> {
  const pin = deps.pin ?? MAGISK_PIN;
  const apkPath = magiskApkCachePath(deps.home, pin);
  mkdirSync(dirname(apkPath), { recursive: true });

  if (existsSync(apkPath)) {
    try {
      verifyFileSha256(apkPath, pin.sha256, `Magisk ${pin.version}`);
      return { apkPath, cached: true };
    } catch {
      rmSync(apkPath, { force: true });
    }
  }

  deps.onProgress?.(`Downloading Magisk ${pin.version}…`);
  const tmpPath = `${apkPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await (deps.download ?? defaultDownload)(pin.url, tmpPath);
    verifyFileSha256(tmpPath, pin.sha256, `Magisk ${pin.version}`);
    renameSync(tmpPath, apkPath);
    return { apkPath, cached: false };
  } catch (e) {
    rmSync(tmpPath, { force: true });
    throw e;
  }
}

/** Extract Magisk's arm64 ELF tools (`lib{magisk,magiskboot,magiskinit,init-ld}.so`) via `/usr/bin/unzip` (argv array). */
export async function extractMagiskArm64Tools(
  apkPath: string,
  outDir: string,
  deps: { runCmd?: RunCmd; unzipBin?: string } = {},
): Promise<string> {
  mkdirSync(outDir, { recursive: true });
  const entries = MAGISK_PIN.arm64Libs.map((n) => `lib/arm64-v8a/lib${n}.so`);
  await (deps.runCmd ?? run)(
    deps.unzipBin ?? '/usr/bin/unzip',
    ['-q', '-o', apkPath, ...entries, '-d', outDir],
    { env: toolEnv(), timeoutMs: 30_000, failureMessage: 'Couldn’t extract Magisk tools from APK' },
  );
  const libDir = join(outDir, 'lib', 'arm64-v8a');
  for (const name of MAGISK_PIN.arm64Libs) {
    const p = join(libDir, `lib${name}.so`);
    if (!existsSync(p)) {
      throw new PhoneDockError(
        `Extracted Magisk APK is missing lib/arm64-v8a/lib${name}.so`,
        'extract_failed',
        500,
        undefined,
        p,
      );
    }
  }
  return libDir;
}

// ---------------------------------------------------------------- in-guest magiskboot patch driver

export interface PatchCommandSpec {
  label: string;
  cmd: string;
  args: string[];
  expectOutput?: RegExp;
  timeoutMs?: number;
}

export interface MagiskPatchPlan {
  steps: PatchCommandSpec[];
  cleanup: PatchCommandSpec;
}

/** Build the ordered argv-array `adb -s <serial>` command sequence for in-guest `magiskboot` ramdisk patching. */
export function buildMagiskPatchCommands(opts: {
  serial: string;
  adbBin: string;
  stockRamdiskPath: string;
  extractedLibsDir: string;
  patchScriptLocalPath: string;
  outTempPath: string;
}): MagiskPatchPlan {
  if (!opts.serial) throw new PhoneDockError('adb serial is required to patch ramdisk', 'bad_request', 400);
  const adb = (label: string, args: string[], extra?: Partial<PatchCommandSpec>): PatchCommandSpec => ({
    label,
    cmd: opts.adbBin,
    args: ['-s', opts.serial, ...args],
    ...extra,
  });

  const steps: PatchCommandSpec[] = [
    adb('clean guest workspace', ['shell', 'rm', '-rf', GUEST_PATCH_DIR]),
    adb('create guest workspace', ['shell', 'mkdir', '-p', GUEST_PATCH_DIR]),
  ];

  for (const name of MAGISK_PIN.arm64Libs) {
    steps.push(adb(`push ${name}`, ['push', join(opts.extractedLibsDir, `lib${name}.so`), `${GUEST_PATCH_DIR}/${name}`]));
  }

  steps.push(
    adb('push stock ramdisk.img', ['push', opts.stockRamdiskPath, `${GUEST_PATCH_DIR}/ramdisk.img`]),
    adb('push patch script', ['push', opts.patchScriptLocalPath, `${GUEST_PATCH_DIR}/patch.sh`]),
    adb('run magiskboot patch', ['shell', 'sh', `${GUEST_PATCH_DIR}/patch.sh`], {
      expectOutput: /PATCH_OK/,
      timeoutMs: 120_000,
    }),
    adb('pull patched ramdisk', ['pull', `${GUEST_PATCH_DIR}/ramdisk.magisk.img`, opts.outTempPath], {
      timeoutMs: 60_000,
    }),
  );

  const cleanup = adb('cleanup guest workspace', ['shell', 'rm', '-rf', GUEST_PATCH_DIR], { timeoutMs: 15_000 });
  return { steps, cleanup };
}

export interface PatchBaseRamdiskOpts {
  serial: string;
  adbBin: string;
  stockRamdiskPath: string;
  extractedLibsDir: string;
  outBaseRamdiskPath: string;
  onProgress?: (line: string) => void;
}

/** Run the in-guest `magiskboot` patch plan over `adb -s <serial>` and atomically write the Tier 1 cache file. */
export async function patchBaseRamdiskInGuest(
  opts: PatchBaseRamdiskOpts,
  deps: { runCmd?: RunCmd } = {},
): Promise<{ baseRamdiskPath: string; sha256: string }> {
  const runCmd = deps.runCmd ?? run;
  const workDir = mkdtempSync(join(tmpdir(), 'pd-magisk-patch-'));
  const patchScriptLocalPath = join(workDir, 'patch.sh');
  mkdirSync(dirname(opts.outBaseRamdiskPath), { recursive: true });
  const outTempPath = `${opts.outBaseRamdiskPath}.tmp-${process.pid}-${Date.now()}`;

  writeFileSync(patchScriptLocalPath, GUEST_MAGISK_PATCH_SCRIPT, { mode: 0o755 });
  const plan = buildMagiskPatchCommands({
    serial: opts.serial,
    adbBin: opts.adbBin,
    stockRamdiskPath: opts.stockRamdiskPath,
    extractedLibsDir: opts.extractedLibsDir,
    patchScriptLocalPath,
    outTempPath,
  });

  try {
    for (const step of plan.steps) {
      opts.onProgress?.(`ramdisk patch: ${step.label}`);
      const res = await runCmd(step.cmd, step.args, {
        env: toolEnv(),
        timeoutMs: step.timeoutMs ?? 60_000,
        failureMessage: `Magisk ramdisk patch failed during "${step.label}"`,
      });
      if (step.expectOutput && !step.expectOutput.test(res.stdout)) {
        throw new PhoneDockError(
          `Magisk ramdisk patch did not report success during "${step.label}"`,
          'patch_failed',
          500,
          undefined,
          `${res.stdout}\n${res.stderr}`.trim().slice(-1024),
        );
      }
    }

    if (!existsSync(outTempPath) || statSync(outTempPath).size === 0) {
      throw new PhoneDockError('Patched base ramdisk was not produced', 'patch_failed', 500, undefined, outTempPath);
    }
    const buf = readFileSync(outTempPath);
    if (!isGzipBuffer(buf)) {
      throw new PhoneDockError('Patched base ramdisk is not a valid gzip archive', 'patch_failed', 500, undefined, outTempPath);
    }
    const sha256 = sha256Buffer(buf);
    renameSync(outTempPath, opts.outBaseRamdiskPath);
    return { baseRamdiskPath: opts.outBaseRamdiskPath, sha256 };
  } catch (e) {
    rmSync(outTempPath, { force: true });
    throw e;
  } finally {
    await runCmd(plan.cleanup.cmd, plan.cleanup.args, {
      env: toolEnv(),
      allowFail: true,
      timeoutMs: plan.cleanup.timeoutMs ?? 15_000,
    }).catch(() => undefined);
    rmSync(workDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- Tier 2 ramdisk assembly & full pipeline

export interface AssembledRamdisk {
  ramdiskPath: string;
  baseSha256: string;
  overlaySha256: string;
  cached: boolean;
}

/**
 * Assemble a per-device ramdisk by concatenating the cached Magisk base ramdisk with the
 * deterministic gzipped `overlay.d/` CPIO archive. Content-addressed in Tier 2 cache.
 */
export function assembleDisguisedRamdisk(opts: {
  baseRamdiskPath: string;
  profile: ResolvedDeviceProfile;
  identity: DeviceIdentity;
  carrier: Carrier;
  overlayOptions?: OverlayOptions;
  home?: string;
}): AssembledRamdisk {
  if (!existsSync(opts.baseRamdiskPath)) {
    throw new PhoneDockError('Base Magisk ramdisk not found', 'not_found', 500, undefined, opts.baseRamdiskPath);
  }
  const baseBuf = readFileSync(opts.baseRamdiskPath);
  if (!isGzipBuffer(baseBuf)) {
    throw new PhoneDockError('Base Magisk ramdisk is not a valid gzip archive', 'corrupt_cache', 500, undefined, opts.baseRamdiskPath);
  }
  const baseSha256 = sha256Buffer(baseBuf);
  const overlay = renderDisguiseOverlay(opts.profile, opts.identity, opts.carrier, opts.overlayOptions);
  const ramdiskPath = deviceRamdiskCachePath(baseSha256, overlay.sha256, opts.home);
  const expectedSize = baseBuf.length + overlay.cpioGz.length;

  if (existsSync(ramdiskPath) && statSync(ramdiskPath).size === expectedSize) {
    return { ramdiskPath, baseSha256, overlaySha256: overlay.sha256, cached: true };
  }

  mkdirSync(dirname(ramdiskPath), { recursive: true });
  const tmpPath = `${ramdiskPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmpPath, Buffer.concat([baseBuf, overlay.cpioGz]));
    renameSync(tmpPath, ramdiskPath);
  } catch (e) {
    rmSync(tmpPath, { force: true });
    throw e;
  }
  return { ramdiskPath, baseSha256, overlaySha256: overlay.sha256, cached: false };
}

export interface PreparedDisguiseRamdisk {
  ramdiskPath: string;
  baseRamdiskPath: string;
  baseSha256: string;
  overlaySha256: string;
  baseCached: boolean;
  ramdiskCached: boolean;
}

export interface PrepareDisguiseDeps {
  adbBin: string;
  home?: string;
  runCmd?: RunCmd;
  download?: DownloadFn;
  unzipBin?: string;
  onProgress?: (line: string) => void;
  /** Override pinned Magisk metadata (tests only). */
  pin?: { version: string; url: string; sha256: string; filename: string };
  /** Acquire a booted stock emulator serial for one-time Tier 1 base ramdisk patching (only called on Tier 1 cache miss). */
  withBootstrapSerial: (fn: (serial: string) => Promise<void>) => Promise<void>;
}

/**
 * End-to-end Tier 1 + Tier 2 ramdisk preparation for a disguised virtual phone:
 * 1. Reuse cached Tier 1 `ramdisk.magisk.img` for `(imageId, stockRamdiskSha256, MAGISK_PIN.version)`.
 * 2. On Tier 1 miss: ensure pinned Magisk APK, extract arm64 libs, run `magiskboot` in-guest once, cache result.
 * 3. Assemble (or reuse cached) Tier 2 `base || overlay.cpio.gz` ramdisk for `(profile, identity, carrier)`.
 */
export async function prepareDisguiseRamdisk(
  opts: {
    imageId: string;
    stockRamdiskPath: string;
    disguise: PersistedDisguise;
  },
  deps: PrepareDisguiseDeps,
): Promise<PreparedDisguiseRamdisk> {
  const profile = deviceProfileById(opts.disguise.profile);
  if (!profile) {
    throw new PhoneDockError(`Unknown virtual phone profile "${opts.disguise.profile}"`, 'bad_request', 400);
  }
  const carrier = carrierById(opts.disguise.identity.carrier);
  if (!carrier) {
    throw new PhoneDockError(`Unknown carrier "${opts.disguise.identity.carrier}"`, 'bad_request', 400);
  }

  const lookup = findCachedBaseRamdisk(opts.imageId, opts.stockRamdiskPath, deps.home);
  const pin = deps.pin ?? MAGISK_PIN;
  const cachePath = pin.version === MAGISK_PIN.version
    ? lookup.cachePath
    : baseRamdiskCachePath(opts.imageId, lookup.stockSha256, deps.home, pin.version);
  const baseCached = existsSync(cachePath);

  if (!baseCached) {
    const { apkPath } = await ensureMagiskApk({
      home: deps.home,
      download: deps.download,
      onProgress: deps.onProgress,
      pin,
    });
    const extractDir = mkdtempSync(join(tmpdir(), 'pd-magisk-x-'));
    try {
      const extractedLibsDir = await extractMagiskArm64Tools(apkPath, extractDir, {
        runCmd: deps.runCmd,
        unzipBin: deps.unzipBin,
      });
      await deps.withBootstrapSerial(async (serial) => {
        await patchBaseRamdiskInGuest(
          {
            serial,
            adbBin: deps.adbBin,
            stockRamdiskPath: opts.stockRamdiskPath,
            extractedLibsDir,
            outBaseRamdiskPath: cachePath,
            onProgress: deps.onProgress,
          },
          { runCmd: deps.runCmd },
        );
      });
    } finally {
      rmSync(extractDir, { recursive: true, force: true });
    }
  }

  const assembled = assembleDisguisedRamdisk({
    baseRamdiskPath: cachePath,
    profile,
    identity: opts.disguise.identity,
    carrier,
    overlayOptions: { teardownMagisk: opts.disguise.teardownMagisk === true },
    home: deps.home,
  });

  return {
    ramdiskPath: assembled.ramdiskPath,
    baseRamdiskPath: cachePath,
    baseSha256: assembled.baseSha256,
    overlaySha256: assembled.overlaySha256,
    baseCached,
    ramdiskCached: assembled.cached,
  };
}
