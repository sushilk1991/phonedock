// Device identity for virtual phones: the identifiers one virtual phone presents to Android and to
// the network for its whole life. Pure data derivation — no device access, no I/O.
//
// Every value comes from an HMAC-SHA256 byte stream keyed by the identity's seed and labelled with
// the field name, so (profile, carrier, seed) always produces the same identity. Hardware
// identifiers are labelled with the profile only and SIM identifiers with profile + carrier, which
// is what makes hardware independent of the SIM's carrier. Byte-to-value mapping always goes through
// rejection sampling, never `bytes % n`.

import { createHmac, randomBytes } from 'node:crypto';

/** A real phone model a virtual phone presents itself as. Data only; the lead maintains the list elsewhere. */
export interface DeviceProfile {
  id: string; // 'pixel_8'
  name: string; // 'Google Pixel 8'
  brand: string; manufacturer: string; model: string; device: string; product: string; board: string;
  hardware: string; // ro.hardware
  platform?: string; // ro.board.platform
  socManufacturer?: string; socModel?: string;
  androidRelease: string; // '14'
  sdk: number; // 34
  buildId: string; incremental: string; securityPatch: string; // 'AP2A.240805.005', '12025142', '2024-08-05'
  fingerprint: string; // brand/product/device:release/buildId/incremental:user/release-keys
  bootloader?: string; baseband?: string;
  screen: { width: number; height: number; dpi: number };
  ramMB: number;
  gl?: { vendor: string; renderer: string; version?: string };
  tacs: string[]; // 8-digit Type Allocation Codes for this model (the first 8 digits of its IMEIs)
  serial: { length: number; alphabet: string; prefix?: string }; // how this maker's serial numbers look
  wifiOuis: string[]; // 'AA:BB:CC' manufacturer prefixes for the Wi-Fi MAC
  btOuis?: string[]; // Bluetooth MAC prefixes (default: wifiOuis)
  dualSim?: boolean; // true: generate imei2
}

/** A mobile network a virtual phone's SIM belongs to. */
export interface Carrier {
  id: string; // 'tmobile_us'
  name: string; // 'T-Mobile' (what the status bar shows)
  mcc: string; mnc: string; // '310', '260'
  countryIso: string; // 'us'
  countryCallingCode: string; // '1'
  iccidIssuer: string; // digits after '89' + country calling code that identify the issuer, e.g. '260'
  nationalNumberLength: number; // digits after the calling code, e.g. 10
}

/** One virtual phone's identifiers. Stored as JSON next to the VM; every field is a plain string. */
export interface DeviceIdentity {
  v: 1;
  profile: string; // DeviceProfile.id
  seed: string; // hex; the same profile + carrier + seed always gives the same identity
  imei: string; // 15 digits, valid Luhn, starts with one of the profile's TACs
  imei2?: string; // only for dualSim profiles; same TAC, different serial part
  serial: string; // per profile.serial
  androidId: string; // 16 lower-case hex digits, not all zeros
  wifiMac: string; // 'aa:bb:cc:dd:ee:ff' lower-case; unicast, globally administered, profile OUI
  btMac: string; // same rules, different from wifiMac
  carrier: string; // Carrier.id
  imsi: string; // mcc + mnc + MSIN, 15 digits total
  iccid: string; // '89' + countryCallingCode + iccidIssuer + account digits + Luhn digit; 19 or 20 digits
  phoneNumber: string; // E.164: '+' + countryCallingCode + nationalNumberLength digits (first digit 2-9)
  bootId: string; // UUID v4 shape, lower-case
  createdAt: string; // ISO 8601
}

/** Real MCC/MNC pairs and ICCID issuer prefixes. */
export const CARRIERS: Carrier[] = [
  { id: 'tmobile_us', name: 'T-Mobile', mcc: '310', mnc: '260', countryIso: 'us', countryCallingCode: '1', iccidIssuer: '260', nationalNumberLength: 10 },
  { id: 'att_us', name: 'AT&T', mcc: '310', mnc: '410', countryIso: 'us', countryCallingCode: '1', iccidIssuer: '410', nationalNumberLength: 10 },
  { id: 'verizon_us', name: 'Verizon', mcc: '311', mnc: '480', countryIso: 'us', countryCallingCode: '1', iccidIssuer: '480', nationalNumberLength: 10 },
  { id: 'ee_uk', name: 'EE', mcc: '234', mnc: '30', countryIso: 'gb', countryCallingCode: '44', iccidIssuer: '30', nationalNumberLength: 10 },
  { id: 'vodafone_uk', name: 'Vodafone', mcc: '234', mnc: '15', countryIso: 'gb', countryCallingCode: '44', iccidIssuer: '15', nationalNumberLength: 10 },
  { id: 'jio_in', name: 'Jio', mcc: '405', mnc: '857', countryIso: 'in', countryCallingCode: '91', iccidIssuer: '857', nationalNumberLength: 10 },
  { id: 'airtel_in', name: 'Airtel', mcc: '404', mnc: '10', countryIso: 'in', countryCallingCode: '91', iccidIssuer: '10', nationalNumberLength: 10 },
  { id: 'telekom_de', name: 'Telekom', mcc: '262', mnc: '01', countryIso: 'de', countryCallingCode: '49', iccidIssuer: '01', nationalNumberLength: 10 },
];

const CARRIERS_BY_ID = new Map<string, Carrier>(CARRIERS.map((c) => [c.id, c]));

export function carrierById(id: string): Carrier | undefined {
  return CARRIERS_BY_ID.get(id);
}

const DEFAULT_CARRIER = 'tmobile_us';
/** Salt for the derivation labels; bump only if every existing identity is meant to change. */
const DERIVATION_SALT = 'phonedock/identity/v1';
const IMSI_LENGTH = 15;
const ICCID_LENGTH = 19;
const ICCID_MAX_LENGTH = 20;

const TAC_RE = /^\d{8}$/;
const OUI_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){2}$/i;
const HEX_RE = /^[0-9a-f]+$/i;
const HEX16_RE = /^[0-9a-f]{16}$/;
const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const UUID4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ANDROID_ID_HEX = '0123456789abcdef';

// ---------------------------------------------------------------- checksums

/**
 * The digit that makes `digits + d` pass Luhn. The appended digit sits at position 1 counted from
 * the right, so the rightmost digit of `digits` is the first one doubled.
 */
export function luhnCheckDigit(digits: string): string {
  if (!/^\d*$/.test(digits)) throw new Error(`luhn: expected digits only, got "${digits}"`);
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return String((10 - (sum % 10)) % 10);
}

/** Luhn over a complete number (check digit included). */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

export function isValidImei(imei: string): boolean {
  return /^\d{15}$/.test(imei) && luhnValid(imei);
}

// ---------------------------------------------------------------- derivation

/** Unbiased bytes and values from HMAC-SHA256(seed, salt + label + counter), consumed as a stream. */
interface ByteSource {
  below(n: number): number;
  digits(count: number): string;
  byte(): number;
}

function byteSource(seed: string, label: string): ByteSource {
  const key = Buffer.from(seed, 'utf8');
  const prefix = `${DERIVATION_SALT}\u0000${label}\u0000`;
  let block = Buffer.alloc(0);
  let offset = 0;
  let counter = 0;
  const nextByte = (): number => {
    if (offset >= block.length) {
      block = createHmac('sha256', key).update(`${prefix}${counter}`).digest();
      counter += 1;
      offset = 0;
    }
    const value = block[offset];
    offset += 1;
    return value;
  };
  // Rejection sampling: draw from the largest multiple of n below the range so every value is equally likely.
  const below = (n: number): number => {
    if (!Number.isSafeInteger(n) || n < 1 || n > 0x100000000) throw new Error(`identity: cannot draw below ${n}`);
    if (n === 1) return 0;
    if (n <= 0x100) {
      const limit = 0x100 - (0x100 % n);
      for (;;) { const b = nextByte(); if (b < limit) return b % n; }
    }
    const limit = 0x100000000 - (0x100000000 % n);
    for (;;) {
      const v = (nextByte() * 0x1000000 + (nextByte() << 16) + (nextByte() << 8) + nextByte()) >>> 0;
      if (v < limit) return v % n;
    }
  };
  const digits = (count: number): string => {
    let out = '';
    for (let i = 0; i < count; i++) out += String(below(10));
    return out;
  };
  return { below, digits, byte: nextByte };
}

function imeiFrom(tac: string, serial: string): string {
  const body = tac + serial; // 14 digits; the 15th is the check digit
  return body + luhnCheckDigit(body);
}

function serialFrom(profile: DeviceProfile, source: ByteSource): string {
  const { length, alphabet } = profile.serial;
  let out = profile.serial.prefix ?? '';
  while (out.length < length) out += alphabet[source.below(alphabet.length)];
  return out;
}

function androidIdFrom(source: ByteSource): string {
  let id = '';
  for (let i = 0; i < 16; i++) id += ANDROID_ID_HEX[source.below(16)];
  // 2^-64 of draws are all zeros; force the invariant instead of re-drawing (which would shift the stream).
  return /^0+$/.test(id) ? `1${id.slice(1)}` : id;
}

function macFrom(oui: string, source: ByteSource): string {
  const octets = oui.toLowerCase().split(':');
  for (let i = 0; i < 3; i++) octets.push(source.byte().toString(16).padStart(2, '0'));
  return octets.join(':');
}

function macFor(seed: string, label: string, ouis: readonly string[]): string {
  const source = byteSource(seed, label);
  return macFrom(ouis[source.below(ouis.length)], source);
}

function uuidV4From(source: ByteSource): string {
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) bytes[i] = source.byte();
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function btOuisOf(profile: DeviceProfile): string[] {
  return profile.btOuis?.length ? profile.btOuis : profile.wifiOuis;
}

// ---------------------------------------------------------------- validation

/** First reason the profile cannot produce an identity, if any. */
function profileProblem(profile: DeviceProfile): string | undefined {
  if (!profile || typeof profile !== 'object') return 'invalid profile: expected an object';
  if (typeof profile.id !== 'string' || profile.id === '') return 'invalid profile: missing id';
  const who = `invalid profile "${profile.id}"`;
  if (!Array.isArray(profile.tacs) || profile.tacs.length === 0) return `${who}: no TACs`;
  for (const tac of profile.tacs) if (typeof tac !== 'string' || !TAC_RE.test(tac)) return `${who}: TAC "${String(tac)}" is not 8 digits`;
  const serial = profile.serial;
  if (!serial || !Number.isInteger(serial.length) || serial.length < 6) return `${who}: serial length must be at least 6`;
  if (typeof serial.alphabet !== 'string' || serial.alphabet.length < 2) return `${who}: serial alphabet needs at least two characters`;
  if (serial.prefix !== undefined && typeof serial.prefix !== 'string') return `${who}: serial prefix must be a string`;
  if (serial.prefix && serial.prefix.length >= serial.length) return `${who}: serial prefix must be shorter than the serial length`;
  if (serial.prefix) for (const ch of serial.prefix) if (!serial.alphabet.includes(ch)) return `${who}: serial prefix character "${ch}" is not in the alphabet`;
  if (!Array.isArray(profile.wifiOuis) || profile.wifiOuis.length === 0) return `${who}: no Wi-Fi OUIs`;
  for (const oui of [...profile.wifiOuis, ...(profile.btOuis ?? [])]) {
    if (typeof oui !== 'string' || !OUI_RE.test(oui)) return `${who}: OUI "${String(oui)}" is not AA:BB:CC`;
    const first = parseInt(oui.slice(0, 2), 16);
    if ((first & 1) !== 0) return `${who}: OUI "${oui}" is multicast (bit 0 of the first octet is set)`;
    if ((first & 2) !== 0) return `${who}: OUI "${oui}" is locally administered (bit 1 of the first octet is set)`;
  }
  return undefined;
}

function carrierProblem(carrier: Carrier): string | undefined {
  const who = `invalid carrier "${carrier.id}"`;
  if (!/^\d{1,3}$/.test(carrier.mcc)) return `${who}: MCC "${carrier.mcc}" is not 1-3 digits`;
  if (!/^\d{1,3}$/.test(carrier.mnc)) return `${who}: MNC "${carrier.mnc}" is not 1-3 digits`;
  if (carrier.mcc.length + carrier.mnc.length >= IMSI_LENGTH) return `${who}: MCC+MNC is too long for a ${IMSI_LENGTH}-digit IMSI`;
  if (!/^\d+$/.test(carrier.countryCallingCode)) return `${who}: country calling code "${carrier.countryCallingCode}" is not digits`;
  if (!/^\d+$/.test(carrier.iccidIssuer)) return `${who}: ICCID issuer "${carrier.iccidIssuer}" is not digits`;
  if (!Number.isInteger(carrier.nationalNumberLength) || carrier.nationalNumberLength < 1) return `${who}: national number length must be at least 1`;
  const prefix = iccidPrefix(carrier);
  if (prefix.length + 2 > ICCID_MAX_LENGTH) return `${who}: ICCID prefix "${prefix}" is too long`;
  return undefined;
}

function iccidPrefix(carrier: Carrier): string {
  return `89${carrier.countryCallingCode}${carrier.iccidIssuer}`;
}

/** Every way `identity` breaks the rules above for `profile` (empty array: valid). Messages name the field. */
export function validateIdentity(identity: DeviceIdentity, profile: DeviceProfile): string[] {
  const problems: string[] = [];
  const profileIssue = profileProblem(profile);
  if (profileIssue) problems.push(profileIssue);

  if (!identity || typeof identity !== 'object') return [...problems, 'identity: expected an object'];
  if (identity.v !== 1) problems.push(`v: expected 1, got ${String(identity.v)}`);
  if (identity.profile !== profile?.id) problems.push(`profile: "${String(identity.profile)}" is not "${String(profile?.id)}"`);
  if (typeof identity.seed !== 'string' || !HEX_RE.test(identity.seed)) problems.push(`seed: "${String(identity.seed)}" is not hex`);
  if (typeof identity.createdAt !== 'string' || Number.isNaN(Date.parse(identity.createdAt))) problems.push('createdAt: expected an ISO 8601 timestamp');

  // IMEI and its optional second slot.
  const tacs = Array.isArray(profile?.tacs) ? profile.tacs.filter((tac) => TAC_RE.test(tac)) : [];
  const imeiOk = typeof identity.imei === 'string' && /^\d{15}$/.test(identity.imei);
  if (!imeiOk) problems.push(`imei: "${String(identity.imei)}" is not 15 digits`);
  else {
    if (!luhnValid(identity.imei)) problems.push(`imei: "${identity.imei}" fails the Luhn check`);
    if (!tacs.some((tac) => identity.imei.startsWith(tac))) {
      problems.push(`imei: "${identity.imei}" does not start with one of the profile's TACs (${tacs.join(', ') || 'none'})`);
    }
  }
  if (profile?.dualSim === true) {
    const imei2 = identity.imei2;
    if (typeof imei2 !== 'string') problems.push('imei2: missing on a dual-SIM profile');
    else if (!/^\d{15}$/.test(imei2)) problems.push(`imei2: "${imei2}" is not 15 digits`);
    else {
      if (!luhnValid(imei2)) problems.push(`imei2: "${imei2}" fails the Luhn check`);
      if (imeiOk && imei2.slice(0, 8) !== identity.imei.slice(0, 8)) problems.push(`imei2: TAC "${imei2.slice(0, 8)}" differs from imei TAC "${identity.imei.slice(0, 8)}"`);
      if (imeiOk && imei2.slice(0, 14) === identity.imei.slice(0, 14)) problems.push('imei2: serial part matches imei');
    }
  } else if (identity.imei2 !== undefined) {
    problems.push('imei2: present on a single-SIM profile');
  }

  // Serial number.
  const serial = profile?.serial;
  if (typeof identity.serial !== 'string') problems.push(`serial: "${String(identity.serial)}" is not a string`);
  else if (serial) {
    if (identity.serial.length !== serial.length) problems.push(`serial: "${identity.serial}" is ${identity.serial.length} characters, expected ${serial.length}`);
    if (serial.prefix && !identity.serial.startsWith(serial.prefix)) problems.push(`serial: "${identity.serial}" does not start with "${serial.prefix}"`);
    const strays = [...new Set([...identity.serial].filter((ch) => !serial.alphabet.includes(ch)))];
    if (strays.length) problems.push(`serial: characters "${strays.join('')}" are not in the profile's serial alphabet`);
  }

  // Android ID.
  if (typeof identity.androidId !== 'string' || !HEX16_RE.test(identity.androidId)) problems.push(`androidId: "${String(identity.androidId)}" is not 16 lower-case hex digits`);
  else if (/^0+$/.test(identity.androidId)) problems.push('androidId: must not be all zeros');

  // MAC addresses.
  if (typeof identity.wifiMac !== 'string' || !MAC_RE.test(identity.wifiMac)) problems.push(`wifiMac: "${String(identity.wifiMac)}" is not a lower-case aa:bb:cc:dd:ee:ff address`);
  else {
    const firstOctet = parseInt(identity.wifiMac.slice(0, 2), 16);
    if ((firstOctet & 1) !== 0) problems.push(`wifiMac: first octet 0x${identity.wifiMac.slice(0, 2)} is multicast, expected unicast`);
    if ((firstOctet & 2) !== 0) problems.push(`wifiMac: first octet 0x${identity.wifiMac.slice(0, 2)} is locally administered`);
    const ouis = (profile?.wifiOuis ?? []).map((oui) => oui.toLowerCase());
    if (!ouis.includes(identity.wifiMac.slice(0, 8))) problems.push(`wifiMac: OUI "${identity.wifiMac.slice(0, 8)}" is not one of the profile's Wi-Fi OUIs`);
  }
  const btOuis = profile ? btOuisOf(profile).map((oui) => oui.toLowerCase()) : [];
  if (typeof identity.btMac !== 'string' || !MAC_RE.test(identity.btMac)) problems.push(`btMac: "${String(identity.btMac)}" is not a lower-case aa:bb:cc:dd:ee:ff address`);
  else {
    const firstOctet = parseInt(identity.btMac.slice(0, 2), 16);
    if ((firstOctet & 1) !== 0) problems.push(`btMac: first octet 0x${identity.btMac.slice(0, 2)} is multicast, expected unicast`);
    if ((firstOctet & 2) !== 0) problems.push(`btMac: first octet 0x${identity.btMac.slice(0, 2)} is locally administered`);
    if (!btOuis.includes(identity.btMac.slice(0, 8))) problems.push(`btMac: OUI "${identity.btMac.slice(0, 8)}" is not one of the profile's Bluetooth OUIs`);
    if (identity.btMac === identity.wifiMac) problems.push('btMac: must differ from wifiMac');
  }

  // SIM identifiers, all read against the carrier they claim.
  const carrier = typeof identity.carrier === 'string' ? carrierById(identity.carrier) : undefined;
  if (!carrier) {
    problems.push(`carrier: unknown carrier "${String(identity.carrier)}"`);
  } else {
    const issue = carrierProblem(carrier);
    if (issue) problems.push(issue);
    const imsi = identity.imsi;
    if (typeof imsi !== 'string' || !/^\d+$/.test(imsi)) problems.push(`imsi: "${String(imsi)}" is not digits`);
    else if (imsi.length !== IMSI_LENGTH) problems.push(`imsi: "${imsi}" is ${imsi.length} digits, expected ${IMSI_LENGTH}`);
    else if (!imsi.startsWith(carrier.mcc + carrier.mnc)) problems.push(`imsi: "${imsi}" does not start with the carrier's MCC+MNC "${carrier.mcc}${carrier.mnc}"`);

    const iccid = identity.iccid;
    if (typeof iccid !== 'string' || !/^89\d+$/.test(iccid)) problems.push(`iccid: "${String(iccid)}" is not digits starting with 89`);
    else if (iccid.length < ICCID_LENGTH || iccid.length > ICCID_MAX_LENGTH) problems.push(`iccid: "${iccid}" is ${iccid.length} digits, expected ${ICCID_LENGTH} or ${ICCID_MAX_LENGTH}`);
    else {
      if (!iccid.startsWith(iccidPrefix(carrier))) problems.push(`iccid: "${iccid}" does not start with the carrier's prefix "${iccidPrefix(carrier)}"`);
      if (!luhnValid(iccid)) problems.push(`iccid: "${iccid}" fails the Luhn check`);
    }

    const phoneNumber = identity.phoneNumber;
    const dial = `+${carrier.countryCallingCode}`;
    const phoneRe = new RegExp(`^\\+${carrier.countryCallingCode}[2-9]\\d{${carrier.nationalNumberLength - 1}}$`);
    if (typeof phoneNumber !== 'string' || !phoneRe.test(phoneNumber)) {
      problems.push(`phoneNumber: "${String(phoneNumber)}" is not ${dial} plus ${carrier.nationalNumberLength} digits starting with 2-9`);
    }
  }

  if (typeof identity.bootId !== 'string' || !UUID4_RE.test(identity.bootId)) problems.push(`bootId: "${String(identity.bootId)}" is not a lower-case UUID v4`);
  return problems;
}

// ---------------------------------------------------------------- generation

export interface GenerateOptions { seed?: string; carrier?: string; now?: Date }

/** Deterministic for a given (profile, carrier, seed). Without a seed, a random 16-byte hex seed is created. */
export function generateIdentity(profile: DeviceProfile, opts: GenerateOptions = {}): DeviceIdentity {
  const profileIssue = profileProblem(profile);
  if (profileIssue) throw new Error(profileIssue);
  const carrierId = opts.carrier ?? DEFAULT_CARRIER;
  const carrier = carrierById(carrierId);
  if (!carrier) throw new Error(`unknown carrier id "${carrierId}"`);
  const carrierIssue = carrierProblem(carrier);
  if (carrierIssue) throw new Error(carrierIssue);
  const seed = opts.seed ?? randomBytes(16).toString('hex');
  if (typeof seed !== 'string' || !HEX_RE.test(seed)) throw new Error(`seed: expected a hex string, got "${String(seed)}"`);

  // Hardware labels carry the profile only: the carrier must not move any hardware identifier.
  const hardware = (field: string) => `${field}@${profile.id}`;
  const sim = (field: string) => `${field}@${profile.id}/${carrier.id}`;

  const tac = profile.tacs[byteSource(seed, hardware('tac')).below(profile.tacs.length)];
  const imei = imeiFrom(tac, byteSource(seed, hardware('imei')).digits(6));
  let imei2: string | undefined;
  if (profile.dualSim === true) {
    for (let attempt = 1; imei2 === undefined && attempt <= 8; attempt++) {
      const candidate = imeiFrom(tac, byteSource(seed, hardware(`imei2#${attempt}`)).digits(6));
      if (candidate !== imei) imei2 = candidate;
    }
    if (imei2 === undefined) throw new Error(`identity: could not derive a second IMEI for "${profile.id}"`);
  }

  const wifiMac = macFor(seed, hardware('wifiMac'), profile.wifiOuis);
  let btMac: string | undefined;
  for (let attempt = 1; btMac === undefined && attempt <= 8; attempt++) {
    const candidate = macFor(seed, hardware(`btMac#${attempt}`), btOuisOf(profile));
    if (candidate !== wifiMac) btMac = candidate;
  }
  if (btMac === undefined) throw new Error(`identity: could not derive a Bluetooth MAC distinct from the Wi-Fi MAC for "${profile.id}"`);

  const msinLength = IMSI_LENGTH - carrier.mcc.length - carrier.mnc.length;
  const imsi = `${carrier.mcc}${carrier.mnc}${byteSource(seed, sim('imsi')).digits(msinLength)}`;

  const prefix = iccidPrefix(carrier);
  // 19 digits (the usual ICCID length) unless the carrier prefix leaves no room for an account.
  const totalLength = prefix.length + 2 <= ICCID_LENGTH ? ICCID_LENGTH : ICCID_MAX_LENGTH;
  const accountLength = totalLength - prefix.length - 1;
  const iccidBody = prefix + byteSource(seed, sim('iccid')).digits(accountLength);
  const iccid = iccidBody + luhnCheckDigit(iccidBody);

  const phone = byteSource(seed, sim('phoneNumber'));
  const national = String(2 + phone.below(8)) + phone.digits(carrier.nationalNumberLength - 1);

  const identity: DeviceIdentity = {
    v: 1,
    profile: profile.id,
    seed,
    imei,
    ...(imei2 === undefined ? {} : { imei2 }),
    serial: serialFrom(profile, byteSource(seed, hardware('serial'))),
    androidId: androidIdFrom(byteSource(seed, hardware('androidId'))),
    wifiMac,
    btMac,
    carrier: carrier.id,
    imsi,
    iccid,
    phoneNumber: `+${carrier.countryCallingCode}${national}`,
    bootId: uuidV4From(byteSource(seed, hardware('bootId'))),
    createdAt: (opts.now ?? new Date()).toISOString(),
  };
  return identity;
}
