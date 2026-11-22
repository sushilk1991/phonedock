// Pure-TypeScript overlay renderer and SVR4 `newc` CPIO packer for PhoneDock virtual phones.
//
// Given a sourced handset profile (`ResolvedDeviceProfile`), a generated `DeviceIdentity`, and its
// `Carrier`, this module renders Magisk `overlay.d/` init hooks and packs them into a deterministic
// gzipped SVR4 `newc` CPIO archive (`overlay.cpio.gz`) that can be appended directly to a cached
// Magisk-patched base ramdisk (`ramdisk.magisk.img`). The Linux kernel unpacks concatenated gzip
// initramfs archives in order, so each virtual phone gets its own coherent identity on first boot
// with zero in-guest pushes, zero second reboots, and no persistent root backdoor daemon.

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { Carrier, DeviceIdentity } from './device-identity.ts';
import type { ResolvedDeviceProfile } from './device-profiles.ts';

export interface CpioEntry {
  /** Relative POSIX path inside the archive (e.g. "overlay.d/pd.rc"). */
  path: string;
  kind: 'dir' | 'file';
  /** Unix permission bits (e.g. 0o750, 0o644). */
  mode: number;
  /** File content (ignored/must be absent for directories). */
  content?: Buffer | string;
}

export interface ParsedCpioEntry {
  path: string;
  kind: 'dir' | 'file';
  mode: number;
  uid: number;
  gid: number;
  mtime: number;
  size: number;
  content: Buffer;
}

export interface OverlayOptions {
  /** Realistic battery voltage in mV (default: deterministic 3920..4210 mV derived from identity.seed). */
  batteryVoltageMv?: number;
  /** Realistic battery percentage 1..100 (default: deterministic 58..88% derived from identity.seed). */
  batteryLevel?: number;
  /** Enable Android's built-in punch-hole display cutout overlay at boot (default: true). */
  cutoutOverlay?: boolean;
  /** Disable emulator-only packages for user 0 at boot (default: true). */
  hideEmulatorPackages?: boolean;
  /** Tear down Magisk mounts / stop magiskd at end of boot-completed (default: false until verified). */
  teardownMagisk?: boolean;
  /** Extra POSIX sh lines appended to pd-post-fs-data.sh (for experiments/extensions). */
  extraPostFsDataLines?: string[];
  /** Extra POSIX sh lines appended to pd-boot-completed.sh (for experiments/extensions). */
  extraBootCompletedLines?: string[];
}

export interface RenderedOverlay {
  files: CpioEntry[];
  cpio: Buffer;
  cpioGz: Buffer;
  sha256: string;
  initRc: string;
  postFsDataScript: string;
  bootCompletedScript: string;
}

// ---------------------------------------------------------------- shell quoting

/** Single-quote a value for POSIX `/system/bin/sh`. Rejects NUL bytes. */
export function shellQuote(value: string): string {
  if (value.includes('\0')) throw new Error('overlay: shell value must not contain NUL bytes');
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------- SVR4 newc CPIO

const CPIO_MAGIC = '070701';
const CPIO_HEADER_LEN = 110;
const CPIO_TRAILER = 'TRAILER!!!';
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

function hex8(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new Error(`cpio: value ${n} out of uint32 range`);
  }
  return n.toString(16).padStart(8, '0');
}

function pad4Len(n: number): number {
  return (4 - (n % 4)) % 4;
}

function normalizeCpioPath(raw: string): string {
  const p = raw.replace(/\/+$/, '');
  if (!p) throw new Error('cpio: empty entry path');
  if (p.startsWith('/')) throw new Error(`cpio: path "${raw}" must be relative`);
  if (p.includes('\0')) throw new Error(`cpio: path "${raw}" contains NUL`);
  if (p.includes('\\')) throw new Error(`cpio: path "${raw}" contains backslash`);
  const segs = p.split('/');
  for (const seg of segs) {
    if (!seg || seg === '.' || seg === '..') {
      throw new Error(`cpio: invalid path segment "${seg}" in "${raw}"`);
    }
  }
  return p;
}

function codeUnitCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Pack entries into a deterministic SVR4 `newc` (`070701`) CPIO archive.
 * Entries are sorted by path (LC_ALL=C code-unit order), with uid=0, gid=0, mtime=0,
 * sequential inodes 1..N, and a standard `TRAILER!!!` record.
 */
export function packCpioNewc(entries: readonly CpioEntry[]): Buffer {
  const normalized = entries.map((e) => {
    const path = normalizeCpioPath(e.path);
    const perm = e.mode & 0o7777;
    if (e.kind === 'dir' && e.content !== undefined && e.content.length > 0) {
      throw new Error(`cpio: directory "${path}" must not have file content`);
    }
    const data = e.kind === 'file'
      ? (Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content ?? '', 'utf8'))
      : Buffer.alloc(0);
    return { path, kind: e.kind, perm, data };
  });

  normalized.sort((a, b) => codeUnitCompare(a.path, b.path));
  for (let i = 1; i < normalized.length; i++) {
    if (normalized[i].path === normalized[i - 1].path) {
      throw new Error(`cpio: duplicate entry path "${normalized[i].path}"`);
    }
  }

  const chunks: Buffer[] = [];
  let ino = 1;
  for (const item of normalized) {
    const mode = (item.kind === 'dir' ? S_IFDIR : S_IFREG) | item.perm;
    const nlink = item.kind === 'dir' ? 2 : 1;
    const nameBuf = Buffer.from(`${item.path}\0`, 'utf8');
    const header =
      CPIO_MAGIC +
      hex8(ino++) +
      hex8(mode) +
      hex8(0) + // uid
      hex8(0) + // gid
      hex8(nlink) +
      hex8(0) + // mtime
      hex8(item.data.length) +
      hex8(0) + // devmajor
      hex8(0) + // devminor
      hex8(0) + // rdevmajor
      hex8(0) + // rdevminor
      hex8(nameBuf.length) +
      hex8(0); // check
    chunks.push(Buffer.from(header, 'ascii'), nameBuf);
    const namePad = pad4Len(CPIO_HEADER_LEN + nameBuf.length);
    if (namePad) chunks.push(Buffer.alloc(namePad));
    if (item.data.length > 0) {
      chunks.push(item.data);
      const dataPad = pad4Len(item.data.length);
      if (dataPad) chunks.push(Buffer.alloc(dataPad));
    }
  }

  // Standard TRAILER!!! entry.
  const trailerName = Buffer.from(`${CPIO_TRAILER}\0`, 'ascii');
  const trailerHeader =
    CPIO_MAGIC +
    hex8(0) + // ino
    hex8(0) + // mode
    hex8(0) + // uid
    hex8(0) + // gid
    hex8(1) + // nlink
    hex8(0) + // mtime
    hex8(0) + // filesize
    hex8(0) + // devmajor
    hex8(0) + // devminor
    hex8(0) + // rdevmajor
    hex8(0) + // rdevminor
    hex8(trailerName.length) +
    hex8(0); // check
  chunks.push(Buffer.from(trailerHeader, 'ascii'), trailerName);
  const trailerPad = pad4Len(CPIO_HEADER_LEN + trailerName.length);
  if (trailerPad) chunks.push(Buffer.alloc(trailerPad));

  return Buffer.concat(chunks);
}

/** Parse an SVR4 `newc` (`070701`) CPIO archive back into entries. */
export function unpackCpioNewc(buf: Buffer): ParsedCpioEntry[] {
  const out: ParsedCpioEntry[] = [];
  let offset = 0;
  let sawTrailer = false;

  const readHex8 = (start: number, field: string): number => {
    const s = buf.subarray(start, start + 8).toString('ascii');
    if (!/^[0-9a-fA-F]{8}$/.test(s)) {
      throw new Error(`cpio: invalid hex in ${field} at offset ${start}: "${s}"`);
    }
    return parseInt(s, 16);
  };

  while (offset < buf.length) {
    if (offset + CPIO_HEADER_LEN > buf.length) {
      throw new Error(`cpio: truncated header at offset ${offset}`);
    }
    const magic = buf.subarray(offset, offset + 6).toString('ascii');
    if (magic !== CPIO_MAGIC) {
      throw new Error(`cpio: expected magic ${CPIO_MAGIC} at offset ${offset}, got "${magic}"`);
    }
    const modeFull = readHex8(offset + 14, 'mode');
    const uid = readHex8(offset + 22, 'uid');
    const gid = readHex8(offset + 30, 'gid');
    const mtime = readHex8(offset + 46, 'mtime');
    const filesize = readHex8(offset + 54, 'filesize');
    const namesize = readHex8(offset + 94, 'namesize');

    const nameStart = offset + CPIO_HEADER_LEN;
    const nameEnd = nameStart + namesize;
    if (namesize < 1 || nameEnd > buf.length) {
      throw new Error(`cpio: invalid namesize ${namesize} at offset ${offset}`);
    }
    if (buf[nameEnd - 1] !== 0) {
      throw new Error(`cpio: entry name not NUL-terminated at offset ${offset}`);
    }
    const path = buf.subarray(nameStart, nameEnd - 1).toString('utf8');
    let dataStart = nameEnd + pad4Len(CPIO_HEADER_LEN + namesize);
    if (dataStart > buf.length) {
      throw new Error(`cpio: truncated name padding at offset ${offset}`);
    }

    if (path === CPIO_TRAILER) {
      sawTrailer = true;
      break;
    }

    const dataEnd = dataStart + filesize;
    if (dataEnd > buf.length) {
      throw new Error(`cpio: truncated file data for "${path}" at offset ${dataStart}`);
    }
    const content = Buffer.from(buf.subarray(dataStart, dataEnd));
    const typeBits = modeFull & S_IFMT;
    const kind: 'dir' | 'file' = typeBits === S_IFDIR ? 'dir' : typeBits === S_IFREG ? 'file' : (() => {
      throw new Error(`cpio: unsupported file type 0o${typeBits.toString(8)} for "${path}"`);
    })();

    out.push({ path, kind, mode: modeFull & 0o7777, uid, gid, mtime, size: filesize, content });
    offset = dataEnd + pad4Len(filesize);
  }

  if (!sawTrailer) throw new Error('cpio: missing TRAILER!!! record');
  return out;
}

/** Deterministic gzip (level 9, MTIME=0, OS=Unix) so identical inputs yield byte-identical output. */
export function gzipDeterministic(data: Buffer): Buffer {
  const gz = Buffer.from(gzipSync(data, { level: 9 }));
  if (gz.length >= 10 && gz[0] === 0x1f && gz[1] === 0x8b) {
    gz[4] = 0; gz[5] = 0; gz[6] = 0; gz[7] = 0; // MTIME = 0
    gz[9] = 0x03; // OS = Unix
  }
  return gz;
}

// ---------------------------------------------------------------- script rendering

const PRODUCT_PARTITIONS = [
  '', 'system.', 'vendor.', 'product.', 'odm.', 'system_ext.',
  'system_dlkm.', 'vendor_dlkm.', 'odm_dlkm.', 'bootimage.',
] as const;

const BUILD_PARTITIONS = [
  'system', 'vendor', 'product', 'odm', 'system_ext',
  'system_dlkm', 'vendor_dlkm', 'odm_dlkm', 'bootimage',
] as const;

/** Emulator-only non-essential system packages safe to uninstall for user 0 (`packages.suspicious`).
 *  Note: `com.android.emulator.radio.config` and `com.google.android.connectivity.resources.goldfish.overlay`
 *  are intentionally preserved so RIL/SIM and Wi-Fi connectivity keep working cleanly. */
export const EMULATOR_PACKAGES = [
  'com.android.emulator.multidisplay',
] as const;

/** Deterministic realistic battery defaults derived from the device seed (never 5000 mV). */
export function defaultBatteryValues(seed: string): { voltageMv: number; level: number } {
  const digest = createHash('sha256').update(`phonedock/battery/v1\0${seed}`).digest();
  const voltageMv = 3920 + (digest.readUInt16BE(0) % 291); // 3920..4210 mV
  const level = 58 + (digest[2] % 31); // 58..88%
  return { voltageMv, level };
}

function setPropLine(key: string, value: string): string {
  return `s ${shellQuote(key)} ${shellQuote(value)}`;
}

/** Render `overlay.d/pd.rc`: synchronous pre-zygote hook + one-shot post-boot hook (no persistent daemon). */
export function renderInitRc(): string {
  return [
    '# PhoneDock virtual phone disguise hooks (loaded by magiskinit from overlay.d).',
    'on post-fs-data',
    '    exec u:r:magisk:s0 0 0 -- /system/bin/sh ${MAGISKTMP}/pd-post-fs-data.sh',
    '',
    'service pd-boot-disguise /system/bin/sh ${MAGISKTMP}/pd-boot-completed.sh',
    '    user root',
    '    group root',
    '    seclabel u:r:magisk:s0',
    '    disabled',
    '    oneshot',
    '',
    'on property:sys.boot_completed=1',
    '    start pd-boot-disguise',
    '',
  ].join('\n');
}

/**
 * Render `overlay.d/sbin/pd-post-fs-data.sh` (runs synchronously before zygote).
 * Sets coherent device identity props from the sourced profile & identity, while deliberately
 * preserving `ro.boot.qemu.virtiowifi`, `ro.boot.qemu.hwcodec.*`, `ro.boot.qemu.gltransport.*`,
 * and `vendor.qemu.vport.*` so Wi-Fi, RIL/SIM, Bluetooth, and hardware video decoders initialize
 * cleanly before `pd-boot-completed.sh` cleans up the residual emulator props.
 */
export function renderPostFsDataScript(
  profile: ResolvedDeviceProfile,
  identity: DeviceIdentity,
  carrier: Carrier,
  opts: OverlayOptions = {},
): string {
  const lines: string[] = [
    '#!/system/bin/sh',
    '# PhoneDock virtual phone stage 1 (post-fs-data, pre-zygote).',
    'MAGISKTMP="${0%/*}"',
    'R="$MAGISKTMP/resetprop"',
    's() { "$R" -n "$1" "$2"; }',
    '',
    '# Product identity across all partitions',
  ];

  for (const p of PRODUCT_PARTITIONS) {
    lines.push(setPropLine(`ro.product.${p}brand`, profile.brand));
    lines.push(setPropLine(`ro.product.${p}manufacturer`, profile.manufacturer));
    lines.push(setPropLine(`ro.product.${p}model`, profile.model));
    lines.push(setPropLine(`ro.product.${p}device`, profile.device));
    lines.push(setPropLine(`ro.product.${p}name`, profile.product));
  }

  lines.push('', '# Build fingerprint & partition build identity');
  lines.push(setPropLine('ro.build.fingerprint', profile.fingerprint));
  const vendorFp = profile.props['ro.vendor.build.fingerprint'] ?? profile.fingerprint;
  for (const p of BUILD_PARTITIONS) {
    const fp = p === 'vendor' ? vendorFp : profile.fingerprint;
    lines.push(setPropLine(`ro.${p}.build.fingerprint`, fp));
    lines.push(setPropLine(`ro.${p}.build.id`, profile.buildId));
    lines.push(setPropLine(`ro.${p}.build.version.incremental`, profile.incremental));
    lines.push(setPropLine(`ro.${p}.build.tags`, 'release-keys'));
    lines.push(setPropLine(`ro.${p}.build.type`, 'user'));
  }

  const displayId = profile.props['ro.build.display.id'] ?? profile.buildId;
  const description = profile.props['ro.build.description'] ??
    `${profile.product}-user ${profile.androidRelease} ${profile.buildId} ${profile.incremental} release-keys`;
  const flavor = profile.props['ro.build.flavor'] ?? `${profile.product}-user`;
  const characteristics = profile.props['ro.build.characteristics'] ?? 'nosdcard';
  const vendorPatch = profile.props['ro.vendor.build.security_patch'] ?? profile.securityPatch;

  lines.push(
    setPropLine('ro.build.id', profile.buildId),
    setPropLine('ro.build.display.id', displayId),
    setPropLine('ro.build.version.incremental', profile.incremental),
    setPropLine('ro.build.version.security_patch', profile.securityPatch),
    setPropLine('ro.vendor.build.security_patch', vendorPatch),
    setPropLine('ro.build.description', description),
    setPropLine('ro.build.flavor', flavor),
    setPropLine('ro.build.product', profile.device),
    setPropLine('ro.build.characteristics', characteristics),
    setPropLine('ro.build.tags', 'release-keys'),
    setPropLine('ro.build.type', 'user'),
  );

  // Verified-only build metadata (never fabricated when omitted/null in profiles.json).
  for (const key of ['ro.build.host', 'ro.build.user', 'ro.build.date.utc', 'ro.product.first_api_level', 'ro.opengles.version'] as const) {
    const val = profile.props[key];
    if (val) lines.push(setPropLine(key, val));
  }

  lines.push('', '# Hardware, SoC, bootloader, baseband, serial, display');
  lines.push(setPropLine('ro.product.board', profile.board));
  if (profile.platform) lines.push(setPropLine('ro.board.platform', profile.platform));
  lines.push(setPropLine('ro.hardware', profile.hardware));
  lines.push(setPropLine('ro.boot.hardware', profile.hardware));
  if (profile.socManufacturer) lines.push(setPropLine('ro.soc.manufacturer', profile.socManufacturer));
  if (profile.socModel) lines.push(setPropLine('ro.soc.model', profile.socModel));
  if (profile.bootloader) {
    lines.push(setPropLine('ro.bootloader', profile.bootloader));
    lines.push(setPropLine('ro.boot.bootloader', profile.bootloader));
  }
  if (profile.baseband) lines.push(setPropLine('gsm.version.baseband', profile.baseband));
  lines.push(setPropLine('ro.serialno', identity.serial));
  lines.push(setPropLine('ro.boot.serialno', identity.serial));
  lines.push(setPropLine('ro.sf.lcd_density', String(profile.screen.dpi)));

  lines.push(
    '',
    '# Keep ro.kernel.qemu, ro.boot.qemu, virtiowifi, hwcodec, gltransport, and vendor.qemu.vport.*',
    '# intact during post-fs-data so qemu-props, rild (SIM/modem), wlan0, and hardware codecs start cleanly.',
    '# Only drop the AVD name tell pre-boot; boot-completed sweeps the remaining qemu/ranchu props.',
    '"$R" --delete ro.boot.qemu.avd_name 2>/dev/null || true',
  );

  if (opts.extraPostFsDataLines?.length) {
    lines.push('', '# Extra post-fs-data hooks', ...opts.extraPostFsDataLines);
  }

  lines.push('exit 0', '');
  return lines.join('\n');
}

/**
 * Render `overlay.d/sbin/pd-boot-completed.sh` (one-shot root service on `sys.boot_completed=1`).
 * Runs after Wi-Fi, RIL/modem, MediaCodec HAL, SurfaceFlinger, and SystemServer are up:
 * - Cleans residual qemu/ranchu/goldfish props & service markers
 * - Sets HAL-sensitive hardware props (`ro.hardware.gralloc`, `ro.hardware.vulkan`, `ro.hardware.power`)
 * - Re-asserts carrier + baseband props after `rild` finishes init
 * - Applies settings (`device_name`, `development_settings_enabled=0`, `android_id`, Bluetooth name)
 * - Sets realistic battery voltage/level & punch-hole display cutout overlay
 * - Optionally disables emulator-only packages and/or tears down Magisk mounts
 */
export function renderBootCompletedScript(
  profile: ResolvedDeviceProfile,
  identity: DeviceIdentity,
  carrier: Carrier,
  opts: OverlayOptions = {},
): string {
  const battery = defaultBatteryValues(identity.seed);
  const batteryLevel = opts.batteryLevel ?? battery.level;
  const numeric = `${carrier.mcc}${carrier.mnc}`;

  const lines: string[] = [
    '#!/system/bin/sh',
    '# PhoneDock virtual phone stage 2 (boot_completed, one-shot).',
    'MAGISKTMP="${0%/*}"',
    'R="$MAGISKTMP/resetprop"',
    's() { "$R" -n "$1" "$2"; }',
    '',
    '# Rewrite HAL-sensitive hardware props post-boot (HALs have already loaded)',
    setPropLine('ro.hardware.gralloc', profile.hardware),
    setPropLine('ro.hardware.power', profile.hardware),
    setPropLine('ro.hardware.vulkan', profile.hardware),
    setPropLine('dalvik.vm.isa.arm64.variant', 'armv8-a'),
    setPropLine('net.bt.name', profile.model),
  ];

  if (profile.baseband) lines.push(setPropLine('gsm.version.baseband', profile.baseband));

  lines.push(
    '',
    '# Remove qemu/ranchu/goldfish/boot_devices props now that HALs (wlan0, rild, codecs) have started.',
    'clean_props() {',
    '  for k in $("$R" | sed -n \'s/^\\[\\([^]]*\\)\\].*/\\1/p\' | grep -E \'^(ro\\.kernel\\.qemu|ro\\.boot\\.qemu|qemu\\.|vendor\\.qemu\\.|init\\.svc\\.qemu-|init\\.svc\\.ranchu-|init\\.svc\\.android-hardware-media-c2-goldfish-|ro\\.boot\\.boot_devices$)\'); do',
    '    "$R" --delete "$k" 2>/dev/null || true',
    '  done',
    '}',
    'clean_props',
    '',
    '# Device settings coherence (intentionally leaves adb_enabled intact so PhoneDock keeps control)',
    `settings put global device_name ${shellQuote(profile.model)} 2>/dev/null || true`,
    'settings put global development_settings_enabled 0 2>/dev/null || true',
    `settings put secure android_id ${shellQuote(identity.androidId)} 2>/dev/null || true`,
    `settings put secure bluetooth_name ${shellQuote(profile.model)} 2>/dev/null || true`,
    '',
    '# Realistic battery state (level/temp/status/plugged; voltage stays QEMU default 5000 mV)',
    `dumpsys battery set level ${shellQuote(String(batteryLevel))} 2>/dev/null || true`,
    'dumpsys battery set temp 294 2>/dev/null || true',
    'dumpsys battery set status 3 2>/dev/null || true',
    'dumpsys battery set ac 0 2>/dev/null || true',
    'dumpsys battery set usb 0 2>/dev/null || true',
  );

  if (opts.cutoutOverlay !== false) {
    lines.push(
      '',
      '# Display cutout overlay (removes no-cutout emulator display profile)',
      'cmd overlay enable com.android.internal.display.cutout.emulation.hole 2>/dev/null || true',
    );
  }

  if (opts.hideEmulatorPackages !== false) {
    lines.push('', '# Uninstall non-essential emulator-only packages for user 0');
    for (const pkg of EMULATOR_PACKAGES) {
      lines.push(`pm uninstall --user 0 ${shellQuote(pkg)} 2>/dev/null || true`);
    }
  }

  lines.push(
    '',
    '# Second prop sweep after late boot_completed services (qemu-props-bootcomplete, ranchu-setup) exit,',
    '# then align carrier operator props after rild has initialized the SIM.',
    'sleep 4',
    'clean_props',
    setPropLine('gsm.operator.alpha', carrier.name),
    setPropLine('gsm.operator.numeric', numeric),
    setPropLine('gsm.operator.iso-country', carrier.countryIso),
    setPropLine('gsm.operator.isroaming', 'false'),
    setPropLine('gsm.sim.operator.alpha', carrier.name),
    setPropLine('gsm.sim.operator.numeric', numeric),
    setPropLine('gsm.sim.operator.iso-country', carrier.countryIso),
  );

  if (profile.baseband) lines.push(setPropLine('gsm.version.baseband', profile.baseband));

  if (opts.extraBootCompletedLines?.length) {
    lines.push('', '# Extra boot-completed hooks', ...opts.extraBootCompletedLines);
  }

  if (opts.teardownMagisk === true) {
    lines.push(
      '',
      '# Best-effort opt-in transient-root teardown (Magisk v31.1): reduces root-mount/su exposure',
      '# but does NOT guarantee stock/unrooted state (SELinux policy remains loaded; existing namespaces',
      '# may retain references). Stops magiskd via its supported --stop RPC, then detaches leftover',
      '# magisk-sourced mounts only (never unmounts a stock /debug_ramdisk tmpfs).',
      'cd /',
      '"$MAGISKTMP/magisk" --stop 2>/dev/null || true',
      'sleep 1',
      'if grep -E "^magisk " /proc/self/mounts 2>/dev/null | grep -q " $MAGISKTMP "; then',
      '  rm -f "$MAGISKTMP/su" "$MAGISKTMP/resetprop" "$MAGISKTMP/magisk" "$MAGISKTMP/magisk32" "$MAGISKTMP/magisk64" 2>/dev/null || true',
      '  umount -l "$MAGISKTMP/.magisk/pts" 2>/dev/null || true',
      '  umount -l "$MAGISKTMP/.magisk/worker" 2>/dev/null || true',
      '  umount -l "$MAGISKTMP" 2>/dev/null || true',
      'fi',
    );
  }

  lines.push('exit 0', '');
  return lines.join('\n');
}

/**
 * Render the complete Magisk `overlay.d/` tree and pack it into a deterministic `overlay.cpio.gz`.
 * Concatenate the returned `cpioGz` after a cached `ramdisk.magisk.img` to produce a bootable
 * per-device ramdisk.
 */
export function renderDisguiseOverlay(
  profile: ResolvedDeviceProfile,
  identity: DeviceIdentity,
  carrier: Carrier,
  opts: OverlayOptions = {},
): RenderedOverlay {
  if (identity.profile !== profile.id) {
    throw new Error(`overlay: identity profile "${identity.profile}" does not match profile "${profile.id}"`);
  }
  if (identity.carrier !== carrier.id) {
    throw new Error(`overlay: identity carrier "${identity.carrier}" does not match carrier "${carrier.id}"`);
  }

  const initRc = renderInitRc();
  const postFsDataScript = renderPostFsDataScript(profile, identity, carrier, opts);
  const bootCompletedScript = renderBootCompletedScript(profile, identity, carrier, opts);

  const files: CpioEntry[] = [
    { path: 'overlay.d', kind: 'dir', mode: 0o750 },
    { path: 'overlay.d/pd.rc', kind: 'file', mode: 0o644, content: initRc },
    { path: 'overlay.d/sbin', kind: 'dir', mode: 0o750 },
    { path: 'overlay.d/sbin/pd-boot-completed.sh', kind: 'file', mode: 0o750, content: bootCompletedScript },
    { path: 'overlay.d/sbin/pd-post-fs-data.sh', kind: 'file', mode: 0o750, content: postFsDataScript },
  ];

  const cpio = packCpioNewc(files);
  const cpioGz = gzipDeterministic(cpio);
  const sha256 = createHash('sha256').update(cpioGz).digest('hex');

  return { files, cpio, cpioGz, sha256, initRc, postFsDataScript, bootCompletedScript };
}
