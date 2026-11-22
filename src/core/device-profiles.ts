// Sourced real-handset profiles for PhoneDock virtual phones.
// Raw data lives verbatim in ./profiles.json (with per-field primary source URLs and an explicit
// `unverified` list). This module validates and adapts those records to `DeviceProfile` without
// fabricating any null/unverified OEM strings.

import rawCatalog from './profiles.json' with { type: 'json' };
import type { DeviceProfile } from './device-identity.ts';

/** Standard AOSP CTS-compliant alphanumeric alphabet (`^[0-9A-Za-z]{6,20}$`), excluding I/O to match
 *  common handset serial labels when an OEM's exact serial alphabet is unverified in profiles.json. */
export const CTS_FALLBACK_SERIAL_ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export interface RawSensorSpec {
  name: string;
  vendor: string | null;
  type: string;
}

export interface RawProfileEntry {
  id: string;
  name: string;
  variant?: string;
  props: Record<string, string | null>;
  screen: { width: number; height: number; dpi: number; refreshHz?: number[] };
  ramMB: number;
  cpu?: { cores: number; hardwareLine: string | null; abis: string[] };
  gl?: { vendor: string; renderer: string; version?: string | null };
  sensors?: RawSensorSpec[];
  tacs: string[];
  serial?: { example_shape?: string | null; length: number | null; alphabet: string | null; prefix?: string | null };
  wifiOuis: string[];
  btOuis?: string[];
  dualSim?: boolean;
  wifiOuisMeta?: { confidence?: string };
  sources?: Record<string, string>;
  unverified?: string[];
}

export interface RawProfileCatalog {
  profiles: RawProfileEntry[];
}

/** A validated, sourced handset profile ready for `generateIdentity()` and boot-time prop rendering. */
export interface ResolvedDeviceProfile extends DeviceProfile {
  variant?: string;
  /** Every non-null verified system property from profiles.json (null/unverified entries are omitted). */
  props: Record<string, string>;
  screen: { width: number; height: number; dpi: number; refreshHz?: number[] };
  cpu?: { cores: number; hardwareLine?: string; abis: string[] };
  sensors?: { name: string; vendor?: string; type: string }[];
  sources: Record<string, string>;
  unverified: string[];
  /** Whether `serial.length` and `serial.alphabet` were both verified in profiles.json or used the CTS fallback. */
  serialRuleSource: 'verified' | 'cts-fallback';
}

const TAC_RE = /^\d{8}$/;
const OUI_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){2}$/i;

function reqProp(props: Record<string, string | null>, key: string, id: string): string {
  const v = props[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`profile "${id}": missing required prop "${key}"`);
  }
  return v;
}

function optProp(props: Record<string, string | null>, key: string): string | undefined {
  const v = props[key];
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function defaultSerialLength(brand: string): number {
  const b = brand.toLowerCase();
  if (b === 'google') return 14;
  if (b === 'samsung') return 11;
  return 12;
}

/** Validate and normalize one raw profile entry from profiles.json into a `ResolvedDeviceProfile`. */
export function resolveRawProfile(raw: RawProfileEntry): ResolvedDeviceProfile {
  if (!raw || typeof raw !== 'object') throw new Error('profile: expected an object');
  if (typeof raw.id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(raw.id)) {
    throw new Error(`profile: invalid id "${String(raw.id)}"`);
  }
  const id = raw.id;
  if (typeof raw.name !== 'string' || raw.name.trim() === '') throw new Error(`profile "${id}": missing name`);
  if (!raw.props || typeof raw.props !== 'object') throw new Error(`profile "${id}": missing props`);

  const brand = reqProp(raw.props, 'ro.product.brand', id);
  const manufacturer = reqProp(raw.props, 'ro.product.manufacturer', id);
  const model = reqProp(raw.props, 'ro.product.model', id);
  const device = reqProp(raw.props, 'ro.product.device', id);
  const product = reqProp(raw.props, 'ro.product.name', id);
  const board = reqProp(raw.props, 'ro.product.board', id);
  const hardware = reqProp(raw.props, 'ro.hardware', id);
  const androidRelease = reqProp(raw.props, 'ro.build.version.release', id);
  const sdkRaw = reqProp(raw.props, 'ro.build.version.sdk', id);
  const sdk = Number(sdkRaw);
  if (!Number.isInteger(sdk) || sdk < 21 || sdk > 99) {
    throw new Error(`profile "${id}": invalid ro.build.version.sdk "${sdkRaw}"`);
  }
  const buildId = reqProp(raw.props, 'ro.build.id', id);
  const incremental = reqProp(raw.props, 'ro.build.version.incremental', id);
  const securityPatch = reqProp(raw.props, 'ro.build.version.security_patch', id);
  const fingerprint = reqProp(raw.props, 'ro.build.fingerprint', id);

  if (!raw.screen || !Number.isInteger(raw.screen.width) || raw.screen.width <= 0 ||
      !Number.isInteger(raw.screen.height) || raw.screen.height <= 0 ||
      !Number.isInteger(raw.screen.dpi) || raw.screen.dpi <= 0) {
    throw new Error(`profile "${id}": invalid screen dimensions`);
  }
  if (!Number.isInteger(raw.ramMB) || raw.ramMB < 512) {
    throw new Error(`profile "${id}": invalid ramMB "${String(raw.ramMB)}"`);
  }
  if (!Array.isArray(raw.tacs) || raw.tacs.length === 0) {
    throw new Error(`profile "${id}": must have at least one TAC`);
  }
  for (const tac of raw.tacs) {
    if (typeof tac !== 'string' || !TAC_RE.test(tac)) {
      throw new Error(`profile "${id}": invalid TAC "${String(tac)}"`);
    }
  }
  if (!Array.isArray(raw.wifiOuis) || raw.wifiOuis.length === 0) {
    throw new Error(`profile "${id}": must have at least one Wi-Fi OUI`);
  }
  for (const oui of [...raw.wifiOuis, ...(raw.btOuis ?? [])]) {
    if (typeof oui !== 'string' || !OUI_RE.test(oui)) {
      throw new Error(`profile "${id}": invalid OUI "${String(oui)}"`);
    }
    const first = parseInt(oui.slice(0, 2), 16);
    if ((first & 1) !== 0) throw new Error(`profile "${id}": OUI "${oui}" is multicast`);
    if ((first & 2) !== 0) throw new Error(`profile "${id}": OUI "${oui}" is locally administered`);
  }

  // Only keep verified (non-null, non-empty) props; never invent missing OEM strings.
  const verifiedProps: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.props)) {
    if (typeof v === 'string' && v.length > 0) verifiedProps[k] = v;
  }

  const rawSerialLen = raw.serial?.length;
  const rawSerialAlpha = raw.serial?.alphabet;
  const serialVerified = typeof rawSerialLen === 'number' && Number.isInteger(rawSerialLen) && rawSerialLen >= 6
    && typeof rawSerialAlpha === 'string' && rawSerialAlpha.length >= 2;
  const serialLength = typeof rawSerialLen === 'number' && Number.isInteger(rawSerialLen) && rawSerialLen >= 6
    ? rawSerialLen
    : defaultSerialLength(brand);
  const serialAlphabet = typeof rawSerialAlpha === 'string' && rawSerialAlpha.length >= 2
    ? rawSerialAlpha
    : CTS_FALLBACK_SERIAL_ALPHABET;
  const serialPrefix = typeof raw.serial?.prefix === 'string' && raw.serial.prefix.length > 0 ? raw.serial.prefix : undefined;

  const platform = optProp(raw.props, 'ro.board.platform');
  const socManufacturer = optProp(raw.props, 'ro.soc.manufacturer');
  const socModel = optProp(raw.props, 'ro.soc.model');
  const bootloader = optProp(raw.props, 'ro.bootloader');
  const baseband = optProp(raw.props, 'gsm.version.baseband');

  return {
    id,
    name: raw.name,
    ...(raw.variant ? { variant: raw.variant } : {}),
    brand,
    manufacturer,
    model,
    device,
    product,
    board,
    hardware,
    ...(platform ? { platform } : {}),
    ...(socManufacturer ? { socManufacturer } : {}),
    ...(socModel ? { socModel } : {}),
    androidRelease,
    sdk,
    buildId,
    incremental,
    securityPatch,
    fingerprint,
    ...(bootloader ? { bootloader } : {}),
    ...(baseband ? { baseband } : {}),
    screen: {
      width: raw.screen.width,
      height: raw.screen.height,
      dpi: raw.screen.dpi,
      ...(Array.isArray(raw.screen.refreshHz) ? { refreshHz: [...raw.screen.refreshHz] } : {}),
    },
    ramMB: raw.ramMB,
    ...(raw.gl ? {
      gl: {
        vendor: raw.gl.vendor,
        renderer: raw.gl.renderer,
        ...(typeof raw.gl.version === 'string' && raw.gl.version.length > 0 ? { version: raw.gl.version } : {}),
      },
    } : {}),
    ...(raw.cpu ? {
      cpu: {
        cores: raw.cpu.cores,
        ...(typeof raw.cpu.hardwareLine === 'string' && raw.cpu.hardwareLine.length > 0 ? { hardwareLine: raw.cpu.hardwareLine } : {}),
        abis: [...raw.cpu.abis],
      },
    } : {}),
    ...(Array.isArray(raw.sensors) ? {
      sensors: raw.sensors.map((s) => ({
        name: s.name,
        ...(typeof s.vendor === 'string' && s.vendor.length > 0 ? { vendor: s.vendor } : {}),
        type: s.type,
      })),
    } : {}),
    tacs: [...raw.tacs],
    serial: {
      length: serialLength,
      alphabet: serialAlphabet,
      ...(serialPrefix ? { prefix: serialPrefix } : {}),
    },
    wifiOuis: [...raw.wifiOuis],
    ...(raw.btOuis?.length ? { btOuis: [...raw.btOuis] } : {}),
    ...(raw.dualSim === true ? { dualSim: true } : {}),
    props: verifiedProps,
    sources: raw.sources ? { ...raw.sources } : {},
    unverified: Array.isArray(raw.unverified) ? [...raw.unverified] : [],
    serialRuleSource: serialVerified ? 'verified' : 'cts-fallback',
  };
}

/** Validate and load a full catalog JSON object (`{ profiles: [...] }`). */
export function loadProfilesFromRaw(raw: unknown): ResolvedDeviceProfile[] {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as RawProfileCatalog).profiles)) {
    throw new Error('profiles catalog: expected { profiles: [...] }');
  }
  const seen = new Set<string>();
  const out: ResolvedDeviceProfile[] = [];
  for (const entry of (raw as RawProfileCatalog).profiles) {
    const p = resolveRawProfile(entry);
    if (seen.has(p.id)) throw new Error(`profiles catalog: duplicate profile id "${p.id}"`);
    seen.add(p.id);
    out.push(p);
  }
  if (out.length === 0) throw new Error('profiles catalog: empty profile list');
  return out;
}

export const DEVICE_PROFILES: readonly ResolvedDeviceProfile[] = Object.freeze(loadProfilesFromRaw(rawCatalog));
export const DEFAULT_DEVICE_PROFILE_ID = 'pixel_8';

const BY_ID = new Map<string, ResolvedDeviceProfile>(DEVICE_PROFILES.map((p) => [p.id, p]));

export function listDeviceProfiles(opts?: { sdk?: number }): ResolvedDeviceProfile[] {
  if (opts?.sdk !== undefined) return DEVICE_PROFILES.filter((p) => p.sdk === opts.sdk);
  return [...DEVICE_PROFILES];
}

export function deviceProfileById(id: string): ResolvedDeviceProfile | undefined {
  return BY_ID.get(id);
}

/** Match a profile by exact id or case-insensitive display name / model. */
export function findDeviceProfile(query: string): ResolvedDeviceProfile | undefined {
  const exact = BY_ID.get(query);
  if (exact) return exact;
  const q = query.trim().toLowerCase();
  return DEVICE_PROFILES.find((p) => p.id.toLowerCase() === q || p.name.toLowerCase() === q || p.model.toLowerCase() === q);
}

/** Pick the default real-phone profile, preferring one matching `sdk` when given. */
export function defaultDeviceProfile(sdk?: number): ResolvedDeviceProfile {
  if (sdk !== undefined) {
    const preferred = BY_ID.get(DEFAULT_DEVICE_PROFILE_ID);
    if (preferred && preferred.sdk === sdk) return preferred;
    const match = DEVICE_PROFILES.find((p) => p.sdk === sdk);
    if (match) return match;
  }
  return BY_ID.get(DEFAULT_DEVICE_PROFILE_ID) ?? DEVICE_PROFILES[0];
}
