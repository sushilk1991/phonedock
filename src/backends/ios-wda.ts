// WebDriverAgent for iPhones on iOS 26 and older (iOS 27+ is controlled natively: ios-hid.ts, ios-native.ts).
//
// PhoneDock builds the pinned appium/WebDriverAgent source (component 'wda') once per Mac, signing team, Xcode build
// and runner bundle id with `xcodebuild build-for-testing`, then starts it on the phone with
// `xcodebuild test-without-building -xctestrun <file>`. By default WebDriverAgent listens only on the phone's end of
// this Mac's paired CoreDevice tunnel (TEST_RUNNER_USE_IP), so nothing else on the network can reach it; sharing it on
// the Wi-Fi is a per-phone opt-in. WdaSupervisor keeps it running (daemon start, the phone reappearing, /status going
// quiet, the tunnel address changing) with bounded backoff and from the existing build only (only a person's setup
// signs), one owner per phone on this Mac (WdaLedger: a kernel lock), and ends it on the phone too whenever it stops
// one (the runner app can outlive xcodebuild); a cleanup it couldn't confirm is recorded and finished later.
//
// Everything that touches the system arrives through injected functions, so this file is unit-tested with fakes
// (ios-wda.test.ts). ios-device.ts wires in devicectl, the component manager, ios-device.json and real processes.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { RunOptions } from '../core/exec.ts';
import { PhoneDockError, type ExecResult } from '../core/types.ts';

export type Exec = (cmd: string, args: string[], opts?: RunOptions) => Promise<ExecResult>;

const TEAM_RE = /^[A-Z0-9]{10}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;

/** macOS asks before an app may reach devices on the local network; PhoneDock's service talks to WebDriverAgent at
 *  the phone's Wi-Fi address, so a missing grant looks exactly like "not on the same Wi-Fi". */
export const LOCAL_NETWORK_HINT = 'Allow PhoneDock in System Settings › Privacy & Security › Local Network (macOS blocks Wi-Fi devices until you do).';

// ── signing teams (Xcode › Settings › Accounts) ─────────────────────────────

export interface XcodeTeam { id: string; name: string; type?: string; free: boolean }

/** `IDEProvisioningTeamByIdentifier` in the com.apple.dt.Xcode defaults: account id → [{ teamID, teamName, teamType,
 *  isFreeProvisioningTeam }]. The same team can appear under several accounts; each is listed once. */
export function parseXcodeTeams(raw: unknown): XcodeTeam[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const byId = new Map<string, XcodeTeam>();
  for (const list of Object.values(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    for (const t of list as Record<string, unknown>[]) {
      if (!t || typeof t !== 'object') continue;
      const id = typeof t.teamID === 'string' ? t.teamID.trim() : '';
      if (!TEAM_RE.test(id)) continue;
      const f = t.isFreeProvisioningTeam;
      const free = f === true || f === 1 || f === '1' || f === 'true' || f === 'YES';
      const team: XcodeTeam = { id, name: typeof t.teamName === 'string' && t.teamName.trim() ? t.teamName.trim() : id, free };
      if (typeof t.teamType === 'string' && t.teamType) team.type = t.teamType;
      // Listed paid under any account: it can do what a paid team can.
      const prev = byId.get(id);
      byId.set(id, prev ? { ...prev, free: prev.free && free } : team);
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** The teams Xcode is signed in to on this Mac (empty when Xcode has no account, or was never opened). */
export async function readXcodeTeams(exec: Exec): Promise<XcodeTeam[]> {
  const dir = mkdtempSync(join(tmpdir(), 'pd-xcode-teams-'));
  try {
    const plist = join(dir, 'xcode.plist');
    const ex = await exec('/usr/bin/defaults', ['export', 'com.apple.dt.Xcode', plist], { allowFail: true, timeoutMs: 15_000 });
    if (ex.code !== 0 || !existsSync(plist)) return [];
    const r = await exec('/usr/bin/plutil', ['-extract', 'IDEProvisioningTeamByIdentifier', 'json', '-o', '-', plist], { allowFail: true, timeoutMs: 15_000 });
    if (r.code !== 0) return [];
    try { return parseXcodeTeams(JSON.parse(r.stdout)); } catch { return []; }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** An App Store Connect API key, the alternative to an Apple ID in Xcode. Only its path and ids are stored. */
export interface WdaApiKey { path: string; keyId: string; issuerId: string }

export function parseApiKey(k: { path?: string; keyId?: string; issuerId?: string }, exists: (p: string) => boolean = existsSync): WdaApiKey | undefined {
  const set = [k.path, k.keyId, k.issuerId].filter((v) => v !== undefined && v !== '');
  if (set.length === 0) return undefined;
  if (set.length !== 3) {
    throw new PhoneDockError('An App Store Connect API key needs its file, key ID and issuer ID', 'bad_request', 400,
      ['Pass all three: --api-key-path <AuthKey_XXXXXXXXXX.p8> --api-key-id <KEY ID> --api-key-issuer <ISSUER ID>.']);
  }
  const path = String(k.path), keyId = String(k.keyId).trim(), issuerId = String(k.issuerId).trim();
  if (!path.startsWith('/') || !/\.p8$/i.test(path) || !exists(path)) {
    throw new PhoneDockError('Couldn’t find the App Store Connect API key file', 'bad_request', 400,
      ['Pass the full path of the .p8 file you downloaded from App Store Connect › Users and Access › Integrations.']);
  }
  if (!TEAM_RE.test(keyId)) throw new PhoneDockError('The App Store Connect key ID must have 10 letters and digits', 'bad_request', 400);
  if (!UUID_RE.test(issuerId)) throw new PhoneDockError('The App Store Connect issuer ID must be a UUID', 'bad_request', 400);
  return { path, keyId, issuerId };
}

export function noAccountError(udid = '<udid>'): PhoneDockError {
  return new PhoneDockError('Sign in to Xcode to set up this iPhone', 'xcode_account_missing', 409, [
    'Open Xcode › Settings › Accounts and add your Apple ID (a free one works), then try again.',
    `Or use an App Store Connect API key: phonedock ios wda-setup --udid ${udid} --team <TEAMID> --api-key-path <AuthKey.p8> --api-key-id <KEY ID> --api-key-issuer <ISSUER ID>`,
  ], 'WebDriverAgent has to be signed for your phone, by a team Xcode is signed in to (or with an App Store Connect API key).');
}

/** Which team signs WebDriverAgent: the one asked for, else the only one Xcode is signed in to. */
export function chooseTeam(teams: XcodeTeam[], opts: { team?: string; apiKey?: WdaApiKey; udid?: string; remembered?: string }): { id: string; free: boolean; name?: string } {
  const listed = teams.map((t) => `${t.name} (${t.id}${t.free ? ', personal' : t.type ? `, ${t.type}` : ''})`).join('; ');
  if (opts.team !== undefined) {
    const id = opts.team.trim();
    if (!TEAM_RE.test(id)) throw new PhoneDockError('The Apple Developer Team ID must have 10 characters', 'bad_request', 400);
    const hit = teams.find((t) => t.id === id);
    if (hit) return { id, free: hit.free, name: hit.name };
    if (opts.apiKey) return { id, free: false };   // App Store Connect keys exist only for paid memberships
    if (!teams.length) throw noAccountError(opts.udid);
    throw new PhoneDockError(`Xcode isn’t signed in to team ${id}`, 'team_unknown', 400,
      ['Add that team’s Apple ID in Xcode › Settings › Accounts, or pick one of the teams below.'], `Xcode is signed in to: ${listed}`);
  }
  if (teams.length === 1) return { id: teams[0].id, free: teams[0].free, name: teams[0].name };
  // The team this phone used last (set up before, or stopped): its build is still there, so no new choice is needed.
  const last = opts.remembered ? teams.find((t) => t.id === opts.remembered) : undefined;
  if (last) return { id: last.id, free: last.free, name: last.name };
  if (!teams.length) {
    if (opts.apiKey) {
      throw new PhoneDockError('Choose the team your App Store Connect key belongs to', 'team_required', 409,
        ['Pass --team <TEAMID> (developer.apple.com › Account › Membership details).']);
    }
    throw noAccountError(opts.udid);
  }
  throw new PhoneDockError('Choose which team signs WebDriverAgent', 'team_required', 409,
    ['Pick a team in PhoneDock, or pass --team <TEAMID> (the `team` field).'], `Xcode is signed in to ${teams.length} teams: ${listed}`);
}

/** Upstream's runner id signs with a paid team's wildcard profile (verified on a phone). A personal (free) team can't
 *  use an id another team registered, so it gets its own; a paid team whose profile can't cover upstream's id falls
 *  back to the same team-scoped id (setupPhone). UNVERIFIED on a free team. */
export const UPSTREAM_RUNNER_BUNDLE_ID = 'com.facebook.WebDriverAgentRunner';
export const teamScopedBundleId = (team: string) => `dev.phonedock.wda.${team.toLowerCase()}`;
export function runnerBundleId(team: string, free: boolean): string {
  return free ? teamScopedBundleId(team) : UPSTREAM_RUNNER_BUNDLE_ID;
}
/** A simulator destination builds unsigned: no team. */
export const UNSIGNED_TEAM = 'unsigned';

// ── preflight: plain errors before any build ────────────────────────────────

export interface PhoneFacts {
  found: boolean;
  name?: string;
  paired?: boolean;
  /** false: devicectl lists it but can't reach it now (unplugged, asleep off Wi-Fi). */
  reachable?: boolean;
  osVersion?: string;
  developerMode?: boolean | null;
  /** null: unknown (the lock probe isn't verified on every iOS); a launch classifies it then. */
  locked?: boolean | null;
}

export interface XcodeInfo { version?: string; build: string; /** lowest iOS this Xcode's XCTest runs on ("17.0") */ minIos?: string }

const verNum = (v?: string): number => {
  const m = /^(\d+)(?:\.(\d+))?/.exec(v ?? '');
  return m ? Number(m[1]) * 1000 + Number(m[2] ?? 0) : NaN;
};

/** The pinned WebDriverAgent's own deployment target. */
export const WDA_MIN_IOS = '15.0';

export function preflight(xcode: XcodeInfo | undefined, phone: PhoneFacts | undefined, udid: string): PhoneDockError | undefined {
  if (!xcode) {
    return new PhoneDockError('Install Xcode to set up this iPhone', 'xcode_missing', 409,
      ['Install Xcode from the App Store, open it once, then try again.'], 'xcodebuild -version failed: WebDriverAgent is built with Xcode on this Mac.');
  }
  if (!phone?.found) {
    return new PhoneDockError('Could not find the iPhone', 'not_found', 404,
      ['Plug the iPhone in by USB, unlock it and tap Trust.'], `No connected iOS device ${udid} (xcrun devicectl list devices)`);
  }
  if (phone.paired === false) {
    return new PhoneDockError('Trust this Mac on the iPhone', 'not_paired', 409, ['Plug the iPhone in by USB, unlock it and tap Trust.']);
  }
  if (phone.reachable === false) {
    return new PhoneDockError('The iPhone can’t be reached', 'no_device', 409,
      ['Plug it in by USB, or wake it on the same Wi-Fi as this Mac.']);
  }
  const min = Math.max(verNum(WDA_MIN_IOS), verNum(xcode.minIos) || 0);
  if (phone.osVersion && verNum(phone.osVersion) < min) {
    const minText = `${Math.floor(min / 1000)}${min % 1000 ? `.${min % 1000}` : ''}`;
    return new PhoneDockError(`This iPhone’s iOS ${phone.osVersion} is too old for WebDriverAgent`, 'ios_unsupported', 409,
      [`Update the iPhone to iOS ${minText} or later${xcode.minIos && verNum(xcode.minIos) === min ? `, or use an Xcode that still tests iOS ${phone.osVersion}` : ''}.`],
      `WebDriverAgent ${xcode.minIos && verNum(xcode.minIos) === min ? `built with Xcode ${xcode.version ?? xcode.build} (its XCTest needs iOS ${xcode.minIos})` : `needs iOS ${WDA_MIN_IOS}`}`);
  }
  if (phone.developerMode === false) {
    return new PhoneDockError('Turn on Developer Mode on the iPhone', 'developer_mode_off', 409,
      ['On the iPhone open Settings › Privacy & Security › Developer Mode, turn it on and let it restart.']);
  }
  if (phone.locked === true) {
    return new PhoneDockError('Unlock the iPhone', 'device_locked', 409,
      ['Unlock it and keep it unlocked while PhoneDock sets it up (a few minutes the first time).']);
  }
  return undefined;
}

/** `xcodebuild -version` and the minimum iOS of the XCTest framework Xcode installs on the phone. */
export async function readXcodeInfo(exec: Exec, developerDir: string | undefined): Promise<XcodeInfo | undefined> {
  const r = await exec('xcrun', ['xcodebuild', '-version'], { allowFail: true, timeoutMs: 30_000 }).catch(() => undefined);
  if (!r || r.code !== 0) return undefined;
  const build = /Build version\s+(\S+)/.exec(r.stdout)?.[1];
  if (!build) return undefined;
  const info: XcodeInfo = { build, version: /Xcode\s+(\S+)/.exec(r.stdout)?.[1] };
  const xctest = developerDir && join(developerDir, 'Platforms', 'iPhoneOS.platform', 'Developer', 'Library', 'Frameworks', 'XCTest.framework', 'XCTest');
  if (xctest && existsSync(xctest)) {
    const v = await exec('xcrun', ['vtool', '-show-build', xctest], { allowFail: true, timeoutMs: 15_000 }).catch(() => undefined);
    const minos = v?.code === 0 ? /^\s*minos\s+(\d+(?:\.\d+)*)/m.exec(v.stdout)?.[1] : undefined;
    if (minos) info.minIos = minos;
  }
  return info;
}

// ── xcodebuild ─────────────────────────────────────────────────────────────

export interface BuildPlan {
  project: string; derivedData: string; destination: string;
  team: string; bundleId: string; apiKey?: WdaApiKey;
}

export const isDeviceDestination = (dest: string) => !/simulator/i.test(dest);
/** The SDK a destination builds for, as xcodebuild names its products (WebDriverAgentRunner_iphoneos27.2-arm64.xctestrun). */
export const platformOf = (dest: string) => isDeviceDestination(dest) ? 'iphoneos' : 'iphonesimulator';

/** build-for-testing, signed for the phone. Registering the phone with the team needs both provisioning flags;
 *  the two build settings at the end are what appium passes too (survive Xcode's new warnings, skip indexing).
 *  A simulator build is unsigned: no team, no provisioning. */
export function buildArgv(p: BuildPlan): string[] {
  const device = isDeviceDestination(p.destination);
  return [
    'build-for-testing',
    '-project', p.project, '-scheme', 'WebDriverAgentRunner',
    '-destination', p.destination, '-derivedDataPath', p.derivedData,
    ...(device ? ['-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration'] : []),
    ...(device && p.apiKey ? ['-authenticationKeyPath', p.apiKey.path, '-authenticationKeyID', p.apiKey.keyId, '-authenticationKeyIssuerID', p.apiKey.issuerId] : []),
    ...(device ? [`DEVELOPMENT_TEAM=${p.team}`, 'CODE_SIGN_STYLE=Automatic'] : []),
    ...(p.bundleId !== UPSTREAM_RUNNER_BUNDLE_ID ? [`PRODUCT_BUNDLE_IDENTIFIER=${p.bundleId}`] : []),
    'GCC_TREAT_WARNINGS_AS_ERRORS=0', 'COMPILER_INDEX_STORE_ENABLE=NO',
  ];
}

/** Signing details never leave the process: an API key's path and IDs are replaced in anything stored or shown
 *  (progress lines, error tails). */
export function redact(text: string, key?: WdaApiKey): string {
  let t = text;
  // The known values first, as they are and with spaces escaped: a flag pattern alone stops at a path's first space.
  if (key) {
    for (const [v, label] of [[key.path, '<api-key-path>'], [key.keyId, '<api-key-id>'], [key.issuerId, '<api-key-issuer>']] as const) {
      if (v) for (const form of new Set([v, v.replace(/ /g, '\\ ')])) t = t.split(form).join(label);
    }
  }
  // Then any value after the flags (another key's): double- or single-quoted, or up to the first unescaped space.
  return t.replace(/(-authenticationKey(?:Path|ID|IssuerID))(\s+|=)("(?:[^"\\]|\\.)*"|'[^']*'|(?:\\.|[^\s\\])+)/g, '$1$2<redacted>');
}

/** Start the built runner without building anything. */
export function launchArgv(xctestrun: string, destination: string): string[] {
  return ['test-without-building', '-xctestrun', xctestrun, '-destination', destination];
}

/** One directory per (WebDriverAgent artifact, platform, team, Xcode build, runner bundle id): a change to any
 *  rebuilds. The artifact is the installed component's key (version plus checksum), so a re-pinned source with the
 *  same version still gets a fresh copy. The sharing mode is not in the key: turning it on or off only relaunches. */
export function buildKey(o: { wdaVersion: string; artifact?: string; platform?: string; team: string; xcodeBuild: string; bundleId: string }): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_');
  const hash = createHash('sha256').update(`${o.bundleId}\n${o.artifact ?? ''}\n${o.platform ?? 'iphoneos'}`).digest('hex').slice(0, 8);
  return `${safe(o.wdaVersion)}-${o.platform === 'iphonesimulator' ? 'sim-' : ''}${safe(o.team)}-${safe(o.xcodeBuild)}-${hash}`;
}

/** The newest .xctestrun build-for-testing wrote for `platform` (its name carries the SDK: WebDriverAgentRunner_iphoneos27.2-arm64.xctestrun). */
export function findXctestrun(derivedData: string, platform = 'iphoneos'): string | undefined {
  const dir = join(derivedData, 'Build', 'Products');
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.startsWith(`WebDriverAgentRunner_${platform}`) && n.endsWith('.xctestrun')); } catch { return undefined; }
  return names.map((n) => join(dir, n)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

export const runnerApp = (derivedData: string, platform = 'iphoneos') => join(derivedData, 'Build', 'Products', `Debug-${platform}`, 'WebDriverAgentRunner-Runner.app');

export interface ProfileInfo { expiresAt?: number; devices?: string[]; allDevices: boolean }

/** The provisioning profile embedded in the built runner: when its signing expires, and which phones it covers. */
export async function readProfile(appDir: string, exec: Exec): Promise<ProfileInfo | undefined> {
  const file = join(appDir, 'embedded.mobileprovision');
  if (!existsSync(file)) return undefined;
  const dir = mkdtempSync(join(tmpdir(), 'pd-wda-profile-'));
  try {
    const plist = join(dir, 'profile.plist');
    const d = await exec('/usr/bin/security', ['cms', '-D', '-i', file, '-o', plist], { allowFail: true, timeoutMs: 15_000 });
    if (d.code !== 0 || !existsSync(plist)) return undefined;
    const get = (key: string, fmt: 'raw' | 'json') => exec('/usr/bin/plutil', ['-extract', key, fmt, '-o', '-', plist], { allowFail: true, timeoutMs: 15_000 });
    const [exp, devs, all] = await Promise.all([get('ExpirationDate', 'raw'), get('ProvisionedDevices', 'json'), get('ProvisionsAllDevices', 'raw')]);
    const info: ProfileInfo = { allDevices: all.code === 0 && all.stdout.trim() === 'true' };
    const t = exp.code === 0 ? Date.parse(exp.stdout.trim()) : NaN;
    if (Number.isFinite(t)) info.expiresAt = t;
    if (devs.code === 0) { try { const a = JSON.parse(devs.stdout); if (Array.isArray(a)) info.devices = a.map(String); } catch { /* none */ } }
    return info;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Rebuild a day before signing runs out (free Apple IDs sign for 7 days), so a relaunch never meets a dead runner. */
export const EXPIRY_MARGIN_MS = DAY_MS;

/** Why the build in hand can't be launched on this phone, or undefined when it can. */
export function rebuildReason(o: { xctestrun?: string; profile?: ProfileInfo; udid?: string; now: number; device: boolean; marginMs?: number }): string | undefined {
  if (!o.xctestrun) return 'not built for this team and Xcode yet';
  if (!o.device) return undefined;    // a simulator destination: no profile
  if (!o.profile) return 'the build has no provisioning profile';
  if (o.profile.expiresAt !== undefined && o.profile.expiresAt - o.now < (o.marginMs ?? EXPIRY_MARGIN_MS)) {
    return o.profile.expiresAt <= o.now ? 'its signing expired' : 'its signing expires within a day';
  }
  const want = o.udid?.toLowerCase().replace(/-/g, '');
  if (want && !o.profile.allDevices && o.profile.devices && !o.profile.devices.some((d) => d.toLowerCase().replace(/-/g, '') === want)) {
    return 'this iPhone isn’t in its provisioning profile yet';
  }
  return undefined;
}

/** xcodebuild's wall of text → one plain error. The defaults domain can be stale, so a missing account is also
 *  caught here. `fallback` keeps the old job code ('wda_setup_failed') for anything unrecognised. */
export function classifyXcodebuild(text: string, phase: 'build' | 'launch', ctx: { team?: string; udid?: string } = {}): PhoneDockError {
  const all = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const tail = all.slice(-12).join('\n').slice(-2000);
  // Match on the end of the output only: earlier lines can mention words like "expired" or "locked" in passing.
  text = all.slice(-60).join('\n');
  const team = ctx.team ? ` ${ctx.team}` : '';
  if (/No Accounts|No account for team|no accounts registered|not signed in to (an|any) (Apple ID|account)/i.test(text)) {
    const e = noAccountError(ctx.udid); e.detail = tail; return e;
  }
  // Apple's quota first: the same output also says the bundle id couldn't be registered, and taking that for an
  // unavailable id would ask Apple again under another id.
  if (/maximum (number of )?App ID|App ID limit|maximum number of (registered|apps)/i.test(text)) {
    return new PhoneDockError(`Team${team} reached Apple’s limit for new apps this week`, 'signing_limit', 409,
      ['A free Apple ID can register 10 app IDs every 7 days: try again later, or use a paid team.'], tail);
  }
  if (/Failed to register bundle identifier|bundle identifier .*(cannot be registered|is not available)/i.test(text)) {
    return new PhoneDockError(`Team${team} can’t register WebDriverAgent’s app ID`, 'bundle_id_unavailable', 409,
      ['Sign in with the Apple ID of a paid developer team in Xcode › Settings › Accounts, or try another team.'], tail);
  }
  if (/doesn['’]t include the currently selected device|does not include the currently selected device|device .* is not registered/i.test(text)) {
    return new PhoneDockError(`This iPhone isn’t registered with team${team}`, 'device_not_registered', 409,
      ['Sign in to Xcode with an account that may register devices for that team (Admin or Account Holder), then try again.'], tail);
  }
  // The specific causes first: iOS words an expired or revoked signature with the same generic sentence it uses for
  // an untrusted developer ("invalid code signature, inadequate entitlements or its profile has not been explicitly
  // trusted"), so that sentence alone proves nothing.
  if (/profile has expired|certificate has expired|provisioning profile .*expired|signature .*expired|certificate (has been|was) revoked/i.test(text)) {
    return new PhoneDockError('WebDriverAgent’s signing expired', 'signing_expired', 409, ['Press Set Up Control (or run `phonedock ios wda-setup`): PhoneDock signs it again. A personal team’s signing lasts 7 days.'], tail);
  }
  if (/Untrusted Developer|Verify the Developer App certificate|developer (app )?certificate is not trusted|has not been trusted by the user/i.test(text)) {
    return new PhoneDockError('Trust the developer on the iPhone', 'wda_untrusted', 409,
      ['On the iPhone open Settings › General › VPN & Device Management, tap your Apple ID and tap Trust, then press Retry in PhoneDock (or run setup again).'], tail);
  }
  if (/invalid code signature|inadequate entitlements|has not been explicitly trusted/i.test(text)) {
    return new PhoneDockError('The iPhone refused WebDriverAgent’s signature', 'signature_invalid', 409,
      ['If the iPhone asks you to trust the developer (Settings › General › VPN & Device Management), do that and retry. Otherwise set up control again: PhoneDock rebuilds it.'], tail);
  }
  if (/Unlock .* to Continue|device is locked|passcode protected|is passcode locked|device was locked|could not be,? unlocked/i.test(text)) {
    return new PhoneDockError('Unlock the iPhone', 'device_locked', 409, ['Unlock it; PhoneDock starts WebDriverAgent once it is.'], tail);
  }
  if (/Developer Mode (is )?(disabled|off|not enabled)|enable Developer Mode/i.test(text)) {
    return new PhoneDockError('Turn on Developer Mode on the iPhone', 'developer_mode_off', 409,
      ['On the iPhone open Settings › Privacy & Security › Developer Mode, turn it on and let it restart.'], tail);
  }
  if (/Unable to find a destination matching|device is not available|is not connected|Timed out waiting for the device|Could not locate device|device .* (unavailable|disconnected)/i.test(text)) {
    return new PhoneDockError('The iPhone can’t be reached', 'no_device', 409, ['Plug it in by USB, or wake it on the same Wi-Fi as this Mac.'], tail);
  }
  return phase === 'build'
    ? new PhoneDockError('Couldn’t build WebDriverAgent', 'wda_setup_failed', 502, ['Open the details below; Xcode says what’s wrong in its last lines.'], tail)
    : new PhoneDockError('Couldn’t start WebDriverAgent on the iPhone', 'wda_setup_failed', 502, ['Unlock the iPhone and try again.'], tail);
}

// ── running xcodebuild ────────────────────────────────────────────────────

/** A long-running child as far as this file needs it (node's ChildProcess satisfies it). */
export interface ChildLike {
  pid?: number;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'close', cb: (code: number | null) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
}
export type Spawn = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) => ChildLike;
/** Called as soon as an xcodebuild exists (build or launch), with the promise of its exit. */
export type Spawned = (pid: number | undefined, info: { phase: 'build' | 'launch'; destination: string; exited: Promise<unknown>; xctestrun?: string }) => void;

/** Every xcodebuild this process started that may still run. However the process ends, they end with it: an
 *  xcodebuild left behind would keep a WebDriverAgent nobody watches. */
const liveChildren = new Set<ChildLike>();
let exitHook = false;
function track(child: ChildLike): void {
  liveChildren.add(child);
  child.on('close', () => { liveChildren.delete(child); });
  if (!exitHook) {
    exitHook = true;
    process.once('exit', () => { for (const c of liveChildren) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });
  }
}

interface Ended { code: number | null; spawnError?: string }

/** Feed a child's stdout+stderr to onLine, a line at a time; resolve with the exit code (or why it never ran). */
function lines(child: ChildLike, onLine: (l: string) => void): Promise<Ended> {
  let buf = '';
  const onData = (d: Buffer | string) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) onLine(l); }
    if (buf.length > 64 * 1024) { onLine(buf); buf = ''; }
  };
  child.stdout?.on('data', onData); child.stderr?.on('data', onData);
  return new Promise((resolve) => {
    let done = false;
    child.on('error', (e) => { if (!done) { done = true; resolve({ code: -1, spawnError: e.message }); } });
    child.on('close', (code) => { if (!done) { done = true; if (buf.trim()) onLine(buf); resolve({ code }); } });
  });
}

/** xcodebuild couldn't be started at all (the contract's code since before WebDriverAgent setup existed). */
function execFailed(message: string): PhoneDockError {
  return new PhoneDockError('Couldn’t start the iPhone service', 'exec_failed', 500, undefined, `xcodebuild: ${message}`);
}

/** xcodebuild progress worth a person's attention, in words; everything else only feeds the error tail. */
export function progressFor(line: string, state: { compiled: number }): string | undefined {
  const t = line.trim();
  if (/^(CompileC|SwiftCompile|CompileSwift)\s/.test(t)) { state.compiled++; return state.compiled % 25 === 0 ? `Building WebDriverAgent… (${state.compiled} files compiled)` : undefined; }
  if (/^Signing Identity:/.test(t)) return 'Signing WebDriverAgent…';
  if (/^Provisioning Profile:/.test(t)) return 'Provisioning profile ready';
  if (/\*\* TEST BUILD SUCCEEDED \*\*/.test(t)) return 'WebDriverAgent built';
  if (/\*\* (TEST )?BUILD FAILED \*\*|\*\* TEST EXECUTE FAILED \*\*|xcodebuild: error:|: error: /.test(t)) return t.slice(0, 300);
  if (/^Testing started|Test Suite .* started|Running tests/.test(t)) return 'Starting WebDriverAgent on the iPhone…';
  return undefined;
}

/** SIGINT first (xcodebuild ends its test run cleanly), SIGKILL if it is still there after `graceMs`. */
export function stopChild(child: ChildLike, isAlive: () => boolean, graceMs = 10_000): void {
  if (!isAlive()) return;
  child.kill('SIGINT');
  const t = setTimeout(() => { if (isAlive()) child.kill('SIGKILL'); }, graceMs);
  t.unref?.();
}

export interface Runner {
  pid?: number;
  /** When xcodebuild was started (ms). */
  startedAt: number;
  /** When WebDriverAgent printed its address (ms): uptime counts from here. */
  readyAt?: number;
  alive(): boolean;
  /** SIGINT, then SIGKILL after `graceMs`. */
  kill(graceMs?: number): void;
  /** Resolves when xcodebuild exits. On a phone the runner app can outlive it: stop that with devicectl too. */
  exited: Promise<number | null>;
}

/** Stop a runner (SIGINT, SIGKILL after `graceMs`) and wait until xcodebuild has exited; resolves with whether it has
 *  (false only if even SIGKILL didn't end it within `waitMs`). */
export async function stopRunner(r: Runner, graceMs = 1_000, waitMs = 15_000): Promise<boolean> {
  if (r.alive()) r.kill(graceMs);
  let t: NodeJS.Timeout | undefined;
  await Promise.race([r.exited, new Promise<void>((res) => { t = setTimeout(res, waitMs); t.unref?.(); })]);
  if (t) clearTimeout(t);
  return !r.alive();
}

export function cancelledError(): PhoneDockError {
  return new PhoneDockError('Setup was stopped', 'cancelled', 409, ['Control was stopped, or the iPhone disconnected in PhoneDock, while it was being set up.']);
}

/** Run build-for-testing to completion; reject with a classified error. A first signing can stop at a macOS prompt
 *  ("codesign wants to use a key in your keychain") that nobody sees from a service, so it has a time limit; a stop
 *  (time limit or `signal`) escalates to SIGKILL and never waits forever for the exit. */
export async function runBuild(spawn: Spawn, plan: BuildPlan, env: NodeJS.ProcessEnv, onProgress: (l: string) => void,
  ctx: { udid?: string; timeoutMs?: number; signal?: AbortSignal; graceMs?: number; onSpawn?: Spawned } = {}): Promise<void> {
  if (ctx.signal?.aborted) throw cancelledError();
  const child = spawn('xcodebuild', buildArgv(plan), { env: { ...env, WDA_PRODUCT_BUNDLE_IDENTIFIER: plan.bundleId } });
  track(child);
  ctx.onSpawn?.(child.pid, { phase: 'build', destination: plan.destination, exited: new Promise((r) => child.on('close', r)) });
  let alive = true;
  const tail: string[] = []; const st = { compiled: 0 };
  let stopped: 'timeout' | 'cancelled' | undefined;
  let giveUp!: () => void;
  const gaveUp = new Promise<Ended>((res) => { giveUp = () => res({ code: null }); });
  const stop = (why: 'timeout' | 'cancelled') => {
    if (stopped) return;
    stopped = why;
    stopChild(child, () => alive, ctx.graceMs);
    const t = setTimeout(giveUp, (ctx.graceMs ?? 10_000) + 5_000); t.unref?.();
  };
  const timer = setTimeout(() => stop('timeout'), ctx.timeoutMs ?? 1_200_000);
  timer.unref?.();
  const onAbort = () => stop('cancelled');
  ctx.signal?.addEventListener('abort', onAbort, { once: true });
  const seen = new Set<string>();
  const exited = lines(child, (raw) => {
    const l = redact(raw, plan.apiKey);
    tail.push(l); if (tail.length > 400) tail.shift();
    const p = progressFor(l, st); if (p && !seen.has(p)) { seen.add(p); onProgress(p); }   // each target signs: say it once
  }).then((c) => { alive = false; return c; });
  const end = await Promise.race([exited, gaveUp]).finally(() => { clearTimeout(timer); ctx.signal?.removeEventListener('abort', onAbort); });
  if (end.spawnError !== undefined) throw execFailed(end.spawnError);
  if (stopped === 'cancelled') throw cancelledError();
  if (stopped === 'timeout') {
    throw new PhoneDockError('Building WebDriverAgent took too long', 'wda_setup_failed', 504,
      ['If macOS asked whether codesign may use a key in your keychain, click Always Allow, then try again.'], tail.slice(-12).join('\n'));
  }
  if (end.code !== 0) throw classifyXcodebuild(tail.join('\n'), 'build', { team: plan.team, udid: ctx.udid });
}

/** Start the runner and resolve once WebDriverAgent prints its address (`url` is what it printed; the caller decides
 *  how this Mac reaches it). xcodebuild keeps running to host it. */
export function startRunner(spawn: Spawn,
  o: { xctestrun: string; destination: string; env: NodeJS.ProcessEnv; now: () => number; timeoutMs?: number; udid?: string; team?: string; signal?: AbortSignal; graceMs?: number; apiKey?: WdaApiKey; onSpawn?: Spawned },
  onProgress: (l: string) => void): Promise<{ runner: Runner; url: string }> {
  if (o.signal?.aborted) return Promise.reject(cancelledError());
  const child = spawn('xcodebuild', launchArgv(o.xctestrun, o.destination), { env: o.env });
  track(child);
  o.onSpawn?.(child.pid, { phase: 'launch', destination: o.destination, xctestrun: o.xctestrun, exited: new Promise((r) => child.on('close', r)) });
  let alive = true;
  const tail: string[] = []; const st = { compiled: 0 };
  // Each progress line once per launch (xcodebuild reports several test suites starting).
  const starting = 'Starting WebDriverAgent on the iPhone…';
  const seen = new Set<string>([starting]);
  onProgress(starting);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => { settled = true; clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort); };
    const runner: Runner = {
      pid: child.pid, startedAt: o.now(), alive: () => alive,
      kill: (graceMs) => stopChild(child, () => alive, graceMs ?? o.graceMs),
      exited: lines(child, (raw) => {
        const l = redact(raw, o.apiKey);
        if (!settled) { tail.push(l); if (tail.length > 300) tail.shift(); }
        const m = /ServerURLHere->(\S+?)<-ServerURLHere/.exec(l);
        if (m && !settled) {
          finish();
          runner.readyAt = o.now();
          resolve({ runner, url: m[1].replace(/\/+$/, '') });
          return;
        }
        if (!settled) { const p = progressFor(l, st); if (p && !seen.has(p)) { seen.add(p); onProgress(p); } }
      }).then((end) => {
        alive = false;
        if (!settled) {
          finish();
          reject(end.spawnError !== undefined ? execFailed(end.spawnError) : classifyXcodebuild(tail.join('\n'), 'launch', { team: o.team, udid: o.udid }));
        }
        return end.code;
      }),
    };
    // Given up (Stop, Disconnect, daemon exit, a time limit): the caller hears only once xcodebuild has exited, so
    // nothing it started outlives what the caller reports.
    const giveUp = (err: PhoneDockError) => { finish(); runner.kill(Math.min(o.graceMs ?? 1_000, 1_000)); void runner.exited.then(() => reject(err)); };
    const onAbort = () => { if (!settled) giveUp(cancelledError()); };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      if (settled) return;
      giveUp(new PhoneDockError('WebDriverAgent didn’t start in time', 'wda_setup_failed', 504,
        ['Unlock the iPhone, keep it unlocked, and try again.'], tail.slice(-12).join('\n')));
    }, o.timeoutMs ?? 240_000);
    timer.unref?.();
  });
}

// ── where WebDriverAgent listens ───────────────────────────────────────────

/** WebDriverAgent's HTTP and MJPEG ports, fixed so a shared phone's address stays the same. */
export const WDA_PORT = 8100;
export const MJPEG_PORT = 9100;

/** "http://fd00::1:8100" (WebDriverAgent prints an IPv6 binding unbracketed), "http://[fd00::1]:8100" or
 *  "http://192.0.2.10:8100" → host and port. */
export function parsePrinted(url: string): { host: string; port: number } | undefined {
  const m = /^https?:\/\/(.+):(\d+)\/?$/.exec(url.trim());
  if (!m) return undefined;
  const host = m[1].startsWith('[') && m[1].endsWith(']') ? m[1].slice(1, -1) : m[1];
  return { host, port: Number(m[2]) };
}
export const urlFor = (host: string, port: number) => `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
/** One spelling per address: IPv6 compressed and lower-case the way URL writes it ("FD00:0:0:1:0:0:0:1" → "fd00:0:0:1::1"),
 *  so devicectl's text and a saved URL compare equal. */
export function canonHost(h: string): string {
  const bare = h.trim().replace(/^\[|\]$/g, '');
  if (!bare.includes(':')) return bare.toLowerCase();
  try { return new URL(`http://[${bare}]/`).hostname.replace(/^\[|\]$/g, ''); } catch { return bare.toLowerCase(); }
}
export const sameHost = (a: string, b: string) => canonHost(a) === canonHost(b);
export const hostOf = (url: string) => { try { return canonHost(new URL(url).hostname); } catch { return undefined; } };

/** Where this Mac reaches a phone's WebDriverAgent. By default it is bound to that address only: the phone's end of
 *  this Mac's paired CoreDevice tunnel (USB or Wi-Fi), so nothing else on the network reaches it. */
export interface WdaEndpoint {
  /** The phone's tunnel address (a simulator: 127.0.0.1). */
  host: string;
}

/** What a TCP connect found: something listens, the host said no, or nothing conclusive (unreachable, timed out,
 *  or macOS Local Network privacy stopped it). */
export type ProbeResult = 'open' | 'refused' | 'unknown';

// ── build once, launch many times ──────────────────────────────────────────

/** How PhoneDock signs and runs WebDriverAgent for one phone (stored in ios-device.json; the key file's path, never
 *  its contents). `share`: also listen on the phone's Wi-Fi address, for other Macs (off unless the person turns it on). */
export interface WdaConfig { team: string; free: boolean; bundleId: string; apiKey?: WdaApiKey; destination?: string; share?: boolean }

export interface WdaBuildDeps {
  exec: Exec;
  spawn: Spawn;
  now(): number;
  env: NodeJS.ProcessEnv;
  /** <state>/wda-builds: one directory per build key. */
  buildsDir: string;
  /** The pinned WebDriverAgent source (installs the 'wda' component when it's missing). `key` names the exact
   *  artifact (version and checksum), so a re-pinned source never reuses an older copy. */
  source(onProgress: (l: string) => void): Promise<{ path: string; version: string; key?: string }>;
  xcode(): Promise<XcodeInfo | undefined>;
  /** Copy a directory's contents into a new directory. */
  copyTree(from: string, to: string): Promise<void>;
  /** Write/read small files (build.json, .last-used). */
  writeFile(path: string, text: string): void;
  mkdir(path: string): void;
  remove(path: string): void;
  /** The phone's private address right now, bringing its developer connection up when devicectl can. */
  endpoint(udid: string, cfg: WdaConfig): Promise<WdaEndpoint>;
  /** GET a WebDriverAgent JSON route with a short timeout; undefined when nothing answers. */
  getJson(url: string): Promise<any>;
  probe(host: string, port: number): Promise<ProbeResult>;
}

const BUILD_KEEP_MS = 30 * DAY_MS;

/** A phone is launched by its hardware UDID only (a destination saved by an earlier version is ignored); a simulator
 *  (never managed) by the destination its setup was given. */
export const destinationFor = (udid: string, cfg: WdaConfig) => cfg.destination && !isDeviceDestination(cfg.destination) ? cfg.destination : `id=${udid}`;

// ── one owner's bookkeeping ────────────────────────────────────────────────

/** One build at a time per build key in this process (the Mac's one WebDriverAgent owner): two phones on one team
 *  share a build directory, and two xcodebuilds in one DerivedData fight over its build database. */
const buildTurns = new Map<string, Promise<unknown>>();
async function withBuildTurn<T>(key: string, onWait: () => void, fn: () => Promise<T>): Promise<T> {
  const before = buildTurns.get(key);
  if (before) onWait();
  const run = (before ?? Promise.resolve()).catch(() => undefined).then(fn);
  const settled = run.catch(() => undefined);
  buildTurns.set(key, settled);
  try { return await run; } finally { if (buildTurns.get(key) === settled) buildTurns.delete(key); }
}

/** What may still run on a phone because of this service: 'pending' from the moment its xcodebuild starts until that
 *  xcodebuild has exited and devicectl shows its runner gone; 'clean' after. `phonePids`: the runner app's pids on the
 *  phone (the only ones PhoneDock ends, except on Stop). `stop` (ms): a person's Stop asked to end every runner on the
 *  phone and that isn't confirmed yet; it is finished when the phone is back, for a day. */
export interface CleanupRecord { udid: string; state: 'clean' | 'pending'; phonePids?: number[]; stop?: number }
/** An xcodebuild this service started (build or launch), recorded at spawn so a later start can end it if this one
 *  died hard: identified by pid, start time and destination, never by pid alone. */
export interface HostRecord { pid: number; lstart: string; destination: string; phase: 'build' | 'launch'; udid: string }

/** The owner's ledger, one JSON file in its state directory. */
export class WdaLedger {
  private readonly file: string;
  constructor(file: string) { this.file = file; }

  private read(): { phones: Record<string, CleanupRecord>; hosts: HostRecord[] } {
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8'));
      return { phones: j?.phones && typeof j.phones === 'object' ? j.phones : {}, hosts: Array.isArray(j?.hosts) ? j.hosts : [] };
    } catch { return { phones: {}, hosts: [] }; }
  }
  private write(v: { phones: Record<string, CleanupRecord>; hosts: HostRecord[] }): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(v, null, 1) + '\n', { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  mark(udid: string, r: Partial<Omit<CleanupRecord, 'udid' | 'state'>> = {}): void {
    const v = this.read();
    v.phones[udid] = { ...(v.phones[udid] ?? {}), ...r, udid, state: 'pending' };
    this.write(v);
  }
  clean(udid: string): void {
    const v = this.read();
    v.phones[udid] = { udid, state: 'clean' };
    this.write(v);
  }
  record(udid: string): CleanupRecord | undefined { return this.read().phones[udid]; }
  state(udid: string): CleanupRecord['state'] | undefined { return this.record(udid)?.state; }
  pending(): CleanupRecord[] { return Object.values(this.read().phones).filter((r) => r.state === 'pending'); }

  addHost(h: HostRecord): void { const v = this.read(); v.hosts = [...v.hosts.filter((x) => x.pid !== h.pid), h]; this.write(v); }
  removeHost(pid: number): void { const v = this.read(); if (v.hosts.some((x) => x.pid === pid)) { v.hosts = v.hosts.filter((x) => x.pid !== pid); this.write(v); } }
  hosts(): HostRecord[] { return this.read().hosts; }
}

/** A person's Stop is finished on reconnect for a day; after that a runner found on the phone is somebody else's again. */
const STOP_INTENT_MS = DAY_MS;

/** Make sure a signed build that this phone can run exists. `mayBuild` (a person's Set Up or Retry): build when the
 *  key changed, the signing expires within a day, or the phone isn't in the profile yet. Without it (anything
 *  automatic) only an existing build that still works is used; otherwise a person has to set up again, because only
 *  they may ask Apple to sign anything. */
export async function ensureBuild(d: WdaBuildDeps, udid: string, cfg: WdaConfig, onProgress: (l: string) => void,
  opts: { force?: string; signal?: AbortSignal; mayBuild?: boolean; onSpawn?: Spawned } = {}): Promise<{ dir: string; xctestrun: string; built: boolean; reason?: string }> {
  const mayBuild = opts.mayBuild ?? true;
  const xcode = await d.xcode();
  if (!xcode) throw preflight(undefined, undefined, udid)!;
  const src = await d.source(onProgress);
  const destination = destinationFor(udid, cfg);
  const platform = platformOf(destination);
  const device = platform === 'iphoneos';
  const key = buildKey({ wdaVersion: src.version, artifact: src.key, platform, team: cfg.team, xcodeBuild: xcode.build, bundleId: cfg.bundleId });
  const dir = join(d.buildsDir, key);
  const derivedData = join(dir, 'DerivedData');
  d.mkdir(d.buildsDir);
  return withBuildTurn(key, () => onProgress('Waiting for another build of WebDriverAgent to finish…'), async () => {
    if (opts.signal?.aborted) throw cancelledError();
    // Checked inside the lock: another phone's build may have just made what this one needs.
    let xctestrun = findXctestrun(derivedData, platform);
    const profile = xctestrun && device ? await readProfile(runnerApp(derivedData, platform), d.exec) : undefined;
    const facts = { xctestrun, profile, udid, now: d.now(), device };
    const reason = opts.force ?? rebuildReason(mayBuild ? facts : { ...facts, marginMs: 0 });
    if (!reason && xctestrun) {
      d.writeFile(join(dir, '.last-used'), new Date(d.now()).toISOString() + '\n');
      return { dir, xctestrun, built: false };
    }
    if (!mayBuild) {
      throw new PhoneDockError('WebDriverAgent needs to be built and signed again', 'wda_rebuild_needed', 409,
        [`PhoneDock only signs when you ask (${reason}). Press Set Up Control in PhoneDock, or run \`phonedock ios wda-setup --udid ${udid}\`.`]);
    }
    onProgress(`Building WebDriverAgent ${src.version} ${device ? `for team ${cfg.team}` : 'for the simulator'} (${reason}). The first build takes a few minutes…`);
    d.mkdir(dir);
    const project = join(dir, 'src');
    // Build a private copy: xcodebuild may write next to the project, and the verified component stays as downloaded.
    if (!existsSync(join(project, 'WebDriverAgent.xcodeproj'))) {
      d.remove(project);
      await d.copyTree(src.path, project);
    }
    await runBuild(d.spawn, { project: join(project, 'WebDriverAgent.xcodeproj'), derivedData, destination, team: cfg.team, bundleId: cfg.bundleId, apiKey: cfg.apiKey },
      d.env, onProgress, { udid, signal: opts.signal, onSpawn: opts.onSpawn });
    xctestrun = findXctestrun(derivedData, platform);
    if (!xctestrun) throw new PhoneDockError('Couldn’t build WebDriverAgent', 'wda_setup_failed', 502, undefined, `xcodebuild build-for-testing wrote no ${platform} .xctestrun under ${derivedData}`);
    const at = new Date(d.now()).toISOString();
    d.writeFile(join(dir, 'build.json'), JSON.stringify({ key, wdaVersion: src.version, artifact: src.key, platform, team: cfg.team, bundleId: cfg.bundleId, xcode: xcode.build, builtAt: at, reason }, null, 2) + '\n');
    d.writeFile(join(dir, '.last-used'), at + '\n');
    pruneBuilds(d, key);
    return { dir, xctestrun, built: true, reason };
  });
}

/** Builds nobody launched for 30 days (an old Xcode, an old WebDriverAgent pin, another team) are deleted, unless a
 *  build of that key is running. */
export function pruneBuilds(d: Pick<WdaBuildDeps, 'buildsDir' | 'now' | 'remove'>, keep: string, read: (p: string) => string | undefined = readText): string[] {
  const removed: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(d.buildsDir); } catch { return removed; }
  for (const n of names) {
    if (n === keep || n.startsWith('.') || buildTurns.has(n)) continue;
    const used = Date.parse(read(join(d.buildsDir, n, '.last-used'))?.trim() ?? '');
    if (Number.isFinite(used) && d.now() - used < BUILD_KEEP_MS) continue;
    if (!Number.isFinite(used) && !existsSync(join(d.buildsDir, n, 'build.json'))) continue;   // not ours, or mid-build
    d.remove(join(d.buildsDir, n)); removed.push(n);
  }
  return removed;
}

function readText(p: string): string | undefined {
  try { return statSync(p).isFile() ? readFileSync(p, 'utf8') : undefined; } catch { return undefined; }
}

export interface Launched {
  runner: Runner;
  /** How this Mac reaches it: the phone's tunnel address and the port it printed. */
  url: string;
  /** Sharing on: what other Macs connect to (the Wi-Fi address WebDriverAgent reports). */
  sharedUrl?: string;
  /** Private mode: the phone's Wi-Fi address refused WebDriverAgent's ports ('refused'), or the phone reports no
   *  Wi-Fi address ('none': the bind to the tunnel address is the evidence). */
  lanCheck?: 'refused' | 'none';
  /** The Wi-Fi address WebDriverAgent reported (null: none). */
  wifi?: string | null;
  built: boolean;
}

/** Private control needs positive evidence; without it the runner is stopped and the launch fails (retried later). */
function unverified(why: string): PhoneDockError {
  return new PhoneDockError('PhoneDock couldn’t confirm WebDriverAgent is reachable only from this Mac, so it stopped it', 'wda_unverified', 502,
    [`Keep the iPhone connected and awake; PhoneDock tries again. ${LOCAL_NETWORK_HINT}`], why);
}

/** Build if needed (and allowed), then start the runner bound to the phone's private address (or every address when
 *  sharing is on), and fail closed. A private launch passes only when WebDriverAgent printed the tunnel address,
 *  answers /status through it, and, when it reports a Wi-Fi address, that address refuses both of its ports; one
 *  that answers there is stopped and reported (`wda_exposed`), one that can't be checked is stopped and retried
 *  (`wda_unverified`). `beforeStart` runs between build and start (the supervisor ends the old runner there, so a
 *  failed build leaves a working one alone); `onSpawn` as soon as xcodebuild exists. Only `mayBuild` (a person's
 *  setup) rebuilds, once, when the phone says the signing expired or refuses the signature of an older build. */
export async function launchWda(d: WdaBuildDeps, udid: string, cfg: WdaConfig, onProgress: (l: string) => void,
  opts: { timeoutMs?: number; signal?: AbortSignal; mayBuild?: boolean; beforeStart?: () => Promise<void>;
    onSpawn?: Spawned; onStep?: (step: string, ms: number) => void } = {}): Promise<Launched> {
  const mayBuild = opts.mayBuild ?? true;
  const destination = destinationFor(udid, cfg);
  const device = isDeviceDestination(destination);
  const timed = async <T>(step: string, p: Promise<T>): Promise<T> => { const t = d.now(); try { return await p; } finally { opts.onStep?.(step, d.now() - t); } };
  // The address lookup (devicectl) runs while the build is checked.
  const endpoint = d.endpoint(udid, cfg);
  endpoint.catch(() => undefined);
  let b = await timed('build check', ensureBuild(d, udid, cfg, onProgress, { signal: opts.signal, mayBuild, onSpawn: opts.onSpawn }));
  await timed('ending the previous runner', opts.beforeStart?.() ?? Promise.resolve());
  const start = async (): Promise<Launched> => {
    if (opts.signal?.aborted) throw cancelledError();
    const ep = await endpoint;
    const t0 = d.now();
    const env: NodeJS.ProcessEnv = {
      ...d.env,
      // Passed to the runner without the prefix (man xcodebuild); FBWebServer binds HTTP and MJPEG to USE_IP.
      TEST_RUNNER_USE_PORT: String(WDA_PORT), TEST_RUNNER_MJPEG_SERVER_PORT: String(MJPEG_PORT),
      ...(cfg.share ? {} : { TEST_RUNNER_USE_IP: ep.host }),
    };
    const r = await startRunner(d.spawn, { xctestrun: b.xctestrun, destination, env, now: () => d.now(), timeoutMs: opts.timeoutMs, udid, team: cfg.team,
      signal: opts.signal, apiKey: cfg.apiKey, onSpawn: opts.onSpawn }, onProgress);
    opts.onStep?.('xcodebuild starting WebDriverAgent', d.now() - t0);
    const t1 = d.now();
    try {
      const printed = parsePrinted(r.url);
      // FBWebServer prints the address it bound: proof the private binding took effect.
      if (!cfg.share && (!printed || !sameHost(printed.host, ep.host))) {
        throw new PhoneDockError('WebDriverAgent didn’t bind to the iPhone’s private address', 'wda_exposed', 502,
          ['PhoneDock stopped it. Set up control again; if it happens again, report it.'], `asked it to bind ${ep.host}; it printed ${r.url}`);
      }
      const port = printed?.port ?? WDA_PORT;
      const url = urlFor(ep.host, port);
      const status = await d.getJson(`${url}/status`);
      if (!status?.value) throw unverified(`WebDriverAgent didn’t answer ${url}/status`);
      const out: Launched = { runner: r.runner, url, built: b.built };
      if (device) {
        // The pinned WebDriverAgent reports `ios.ip`: its Wi-Fi address, or JSON null when it has none. Anything else
        // (missing, another type, not an address) proves nothing, so it doesn't count as private.
        const ios = status.value.ios;
        if (!ios || typeof ios !== 'object' || !('ip' in ios)) throw unverified('WebDriverAgent’s /status didn’t say whether the iPhone has a Wi-Fi address');
        if (ios.ip !== null && (typeof ios.ip !== 'string' || !isIP(canonHost(ios.ip)))) throw unverified(`WebDriverAgent’s /status reported a Wi-Fi address that isn’t one (${JSON.stringify(ios.ip).slice(0, 60)})`);
        const wifi = ios.ip !== null && !sameHost(ios.ip, ep.host) ? ios.ip as string : null;
        out.wifi = wifi;
        if (cfg.share) out.sharedUrl = wifi ? urlFor(wifi, port) : undefined;
        else if (!wifi) out.lanCheck = 'none';
        else {
          const [http, mjpeg] = await Promise.all([d.probe(wifi, port), d.probe(wifi, MJPEG_PORT)]);
          if (http === 'open' || mjpeg === 'open') {
            throw new PhoneDockError('WebDriverAgent answered on the iPhone’s Wi-Fi address', 'wda_exposed', 502,
              ['PhoneDock stopped it, so nobody on this network can control the iPhone. Set up control again; if it happens again, report it.'],
              `${http === 'open' ? port : MJPEG_PORT} answered at the iPhone’s Wi-Fi address`);
          }
          if (http !== 'refused' || mjpeg !== 'refused') throw unverified(`the iPhone’s Wi-Fi address didn’t refuse ${http !== 'refused' ? port : MJPEG_PORT} (no answer either way)`);
          out.lanCheck = 'refused';
        }
      }
      opts.onStep?.(cfg.share ? 'checking it answers' : 'checking it is private', d.now() - t1);
      onProgress(cfg.share
        ? `WebDriverAgent is running; other Macs on this Wi-Fi can reach it${out.sharedUrl ? ` at ${out.sharedUrl}` : ''}`
        : 'WebDriverAgent is running, reachable only from this Mac');
      return out;
    } catch (e) { await stopRunner(r.runner); throw e; }
  };
  try { return await start(); }
  catch (e) {
    if (!mayBuild || b.built || !(e instanceof PhoneDockError) || (e.code !== 'signing_expired' && e.code !== 'signature_invalid')) throw e;
    b = await ensureBuild(d, udid, cfg, onProgress, { force: e.code === 'signing_expired' ? 'its signing expired' : 'the iPhone refused its signature', signal: opts.signal, onSpawn: opts.onSpawn });
    await opts.beforeStart?.();
    return { ...(await start()), built: true };
  }
}

// ── supervision ───────────────────────────────────────────────────────────

/** What the daemon reports for a phone whose WebDriverAgent PhoneDock manages (Device.meta.wdaControl). */
export type WdaState = 'starting' | 'running' | 'unreachable' | 'waiting_unlock' | 'waiting_phone' | 'waiting_trust' | 'retrying' | 'failed';
export interface WdaControl {
  managed: true;
  state: WdaState;
  /** One plain sentence for the person. */
  message: string;
  /** What they can do about it, when anything. */
  hint?: string;
  wdaUrl?: string;
  /** Failed launches and unexpected stops since the last healthy run (waits for a person don't count). */
  attempts: number;
  nextRetryAt?: string;
  updatedAt: string;
  /** Other Macs on the Wi-Fi may control it too (the person turned sharing on). */
  shared: boolean;
  /** Sharing on: what another Mac passes to `phonedock connect --ios` (follows the phone's Wi-Fi address). */
  sharedUrl?: string;
  /** Sharing off: what the check of the phone's Wi-Fi address after launch found. */
  lanCheck?: 'refused' | 'none';
}

export interface SupervisorDeps {
  now(): number;
  /** udids PhoneDock manages WebDriverAgent for (ios-device.json). */
  managed(): string[];
  /** GET /status (fresh, short timeout): whether it answered, and the Wi-Fi address WebDriverAgent reports. */
  status(url: string): Promise<{ ok: boolean; ip?: string | null } | false>;
  phone(udid: string): Promise<PhoneFacts>;
  /** Start the runner from the existing build (`mayBuild`: a person asked, so it may build and sign); resolves once it
   *  is verified. `beforeStart` runs after the build, before the new runner starts; `onSpawn` as soon as an xcodebuild
   *  exists (build or launch); `signal` aborts the build or the launch (Stop, Disconnect, daemon exit). */
  launch(udid: string, onProgress: (l: string) => void,
    ctl: { signal: AbortSignal; mayBuild: boolean; beforeStart: () => Promise<void>; onSpawn: Spawned }): Promise<Omit<Launched, 'built'>>;
  /** The pids of the WebDriverAgent runner apps on the phone now (devicectl); rejects when devicectl can't say. */
  runners?(udid: string): Promise<number[]>;
  /** End runners on the phone and confirm, within `withinMs` (each devicectl call gets only what is left): `pids`
   *  only those (PhoneDock's own), else every WebDriverAgent runner on it (a person's Stop). Resolves with how many of
   *  them are left. */
  stopOnPhone(udid: string, o?: { pids?: number[]; withinMs?: number }): Promise<number>;
  ledger?: Pick<WdaLedger, 'mark' | 'clean' | 'record' | 'state' | 'pending'> & Partial<Pick<WdaLedger, 'addHost' | 'removeHost' | 'hosts'>>;
  /** What tells a process just started from a later one with the same pid: its start time (ps). */
  processStart?(pid: number): string | undefined;
  /** End this phone's xcodebuilds that outlived their PhoneDock (recorded ones whose pid, start time and destination
   *  still match, and any other started from PhoneDock's builds for this phone), forget the ones that are gone, and
   *  resolve with whether none is left. */
  reapHosts?(udid: string, hosts: HostRecord[]): Promise<boolean>;
  /** The person turned sharing on for this phone. */
  shared?(udid: string): boolean;
  log(msg: string): void;
  changed?(udid: string): void;
}

export interface SuperviseOptions {
  tickMs: number;
  /** /status may be quiet this long before the runner counts as stuck. */
  graceMs: number;
  backoffMs: readonly number[];
  /** Failed launches and unexpected stops before giving up until the phone reconnects or setup runs again. */
  maxAttempts: number;
  /** How often to look again (with devicectl only, no launch) while waiting for a person or the phone. */
  personPollMs: number;
  /** Waits that only a launch revealed (xcodebuild said locked, unreachable): longer each time, then give up. */
  personBackoffMs: readonly number[];
  maxPersonAttempts: number;
  /** A runner counts as healthy, and earlier failures are forgiven, once it has been up this long and answers. */
  minUptimeMs: number;
  /** How long ending the runner on the phone may take (devicectl over Wi-Fi is slow); xcodebuild is always waited for. */
  stopWaitMs: number;
  /** Run tick() on a timer once started (tests drive tick() themselves). */
  autoTick: boolean;
}
export const SUPERVISE_DEFAULTS: SuperviseOptions = {
  tickMs: 15_000, graceMs: 45_000, backoffMs: [5_000, 15_000, 60_000, 300_000, 900_000], maxAttempts: 6, personPollMs: 30_000,
  personBackoffMs: [30_000, 60_000, 300_000, 900_000], maxPersonAttempts: 8, minUptimeMs: 60_000, stopWaitMs: 60_000, autoTick: true,
};

interface Entry {
  state: WdaState; message: string; hint?: string; nextAt?: number; updatedAt: number;
  url?: string; runner?: Runner;
  /** the tunnel address the runner is bound to */
  boundHost?: string;
  sharedUrl?: string;
  wifi?: string | null;
  lanCheck?: WdaControl['lanCheck'];
  attempts: number;
  personAttempts: number;
  /** last time /status answered (a launch counts: it checked /status) */
  okAt?: number;
  /** devicectl reported the phone locked while waiting (so "unlocked" now means something) */
  sawLocked: boolean;
  /** gave up on something only a person can change (signing, an account, a team, the binding): no restart on reconnect */
  needsPerson?: boolean;
  /** when a changed tunnel address last caused a relaunch */
  tunnelAt?: number;
  reachable?: boolean;
  /** aborted by Stop, Disconnect and daemon exit: a build or launch in flight stops */
  abort: AbortController;
  gone?: boolean;
  /** the pids the running runner has on the phone (found after its launch), and that lookup while it runs */
  own?: number[];
  learning?: Promise<void>;
  learnBusy?: boolean;
}

/** Waits for the person that only a launch revealed: retried with backoff. */
const PERSON_CODES = new Set(['device_locked', 'no_device', 'not_found', 'not_paired', 'developer_mode_off']);
/** Failures only a person can fix (signing, an account, a team, Apple's quota, the binding): no automatic retry. */
const AUTHORITY_CODES = new Set(['xcode_account_missing', 'bundle_id_unavailable', 'device_not_registered', 'team_unknown', 'team_required',
  'xcode_missing', 'ios_unsupported', 'signing_limit', 'signing_expired', 'signature_invalid', 'wda_rebuild_needed', 'wda_exposed', 'wda_foreign_runner', 'exec_failed']);

/** A runner PhoneDock didn't start already runs on the phone (another Mac's, another tool's, an earlier setup's). */
export function foreignRunnerError(): PhoneDockError {
  return new PhoneDockError('WebDriverAgent is already running on this iPhone from somewhere else; Stop Control ends it', 'wda_foreign_runner', 409,
    ['PhoneDock leaves a runner it didn’t start alone. Stop Control ends it (also another Mac’s); then Set Up Control starts PhoneDock’s own.']);
}

/** Keeps WebDriverAgent running on the phones PhoneDock manages. Everything that touches a phone (launch, Stop,
 *  Disconnect, the cleanup after an exit, daemon exit) runs in that phone's lane, one at a time. */
export class WdaSupervisor {
  private readonly deps: SupervisorDeps;
  private readonly o: SuperviseOptions;
  private readonly entries = new Map<string, Entry>();
  private readonly lanes = new Map<string, { tail: Promise<unknown>; busy: number }>();
  private timer?: NodeJS.Timeout;
  private ticking?: Promise<void>;
  /** Only a started supervisor (the daemon's, unfiltered) launches anything on its own; setup() always may. */
  private started = false;
  /** stop() ran: nothing starts again in this process. */
  private closing = false;

  constructor(deps: SupervisorDeps, opts: Partial<SuperviseOptions> = {}) {
    this.deps = deps;
    this.o = { ...SUPERVISE_DEFAULTS, ...opts };
  }

  get isStarted(): boolean { return this.started; }

  info(udid: string): WdaControl | undefined {
    const e = this.entries.get(udid);
    if (!e || !this.deps.managed().includes(udid)) return undefined;
    const shared = !!this.deps.shared?.(udid);
    return {
      managed: true, state: e.state, message: e.message, ...(e.hint ? { hint: e.hint } : {}),
      ...(e.url && e.runner ? { wdaUrl: e.url } : {}), attempts: e.attempts,
      ...(e.nextAt && e.state === 'retrying' ? { nextRetryAt: new Date(e.nextAt).toISOString() } : {}),
      updatedAt: new Date(e.updatedAt).toISOString(),
      shared, ...(shared && e.sharedUrl && e.runner ? { sharedUrl: e.sharedUrl } : {}),
      ...(!shared && e.lanCheck && e.runner ? { lanCheck: e.lanCheck } : {}),
    };
  }

  /** The address a running runner is bound to (input goes there only while devicectl reports it for this phone). */
  boundUrl(udid: string): { url: string; host: string } | undefined {
    const e = this.entries.get(udid);
    return e?.runner?.alive() && e.state === 'running' && e.url && e.boundHost ? { url: e.url, host: e.boundHost } : undefined;
  }

  /** Daemon start: finish cleanups this service owed from before (a Stop the phone didn't confirm, an xcodebuild left
   *  by a PhoneDock that died), start WebDriverAgent on each managed phone, then watch. */
  start(): void {
    if (this.started || this.closing) return;
    this.started = true;
    const managed = new Set(this.deps.managed());
    const owed = new Set([...(this.deps.ledger?.pending() ?? []).map((r) => r.udid), ...(this.deps.ledger?.hosts?.() ?? []).map((h) => h.udid)]);
    for (const udid of owed) if (!managed.has(udid)) void this.cleanUp(udid);
    for (const udid of managed) void this.ensure(udid, 'PhoneDock started');
    if (this.o.autoTick && !this.timer) { this.timer = setInterval(() => { void this.tick(); }, this.o.tickMs); this.timer.unref(); }
  }

  /** Daemon exit: cancel builds and launches, end every runner this process started (on the Mac, and on the phone
   *  within stopWaitMs), and wait for that. An unconfirmed cleanup stays recorded for the next start. */
  async stop(): Promise<void> {
    this.closing = true;
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const all = [...this.entries];
    this.entries.clear();
    for (const [, e] of all) { e.gone = true; e.abort.abort(); }
    await Promise.all([
      ...all.map(([udid, e]) => this.lane(udid, () => this.teardown(udid, e, { ownOnly: true }))),
      ...[...this.lanes.values()].map((l) => l.tail.catch(() => undefined)),
    ]);
  }

  /** The phones devicectl lists right now. A managed phone that comes back (USB or Wi-Fi) gets a start; one that
   *  was given up on gets a fresh count, unless only a person can fix why. A changed tunnel address relaunches in
   *  any state (the runner listens on the old one), bounded. A cleanup owed for a phone that is back is finished. */
  observe(phones: { udid: string; reachable: boolean; tunnelIp?: string }[]): void {
    if (!this.started) return;
    const seen = new Map(phones.map((p) => [p.udid, p]));
    const managed = new Set(this.deps.managed());
    for (const udid of managed) {
      const e = this.entry(udid);
      const p = seen.get(udid);
      const now = p?.reachable ?? false;
      const was = e.reachable;
      e.reachable = now;
      if (!now || this.busy(udid)) continue;
      if (e.runner && e.boundHost && p?.tunnelIp && !sameHost(p.tunnelIp, e.boundHost)) {
        // Not the runner's fault, so not counted, unless it keeps happening (a flapping tunnel mustn't relaunch forever).
        const t = this.deps.now();
        if (e.tunnelAt !== undefined && t - e.tunnelAt < 120_000 && ++e.attempts >= this.o.maxAttempts) {
          this.giveUp(e, 'the iPhone’s developer connection keeps changing');
          void this.lane(udid, () => this.teardown(udid, e, {}));
          continue;
        }
        e.tunnelAt = t;
        void this.ensure(udid, 'the iPhone’s developer connection changed');
        continue;
      }
      const back = was === false ? ['waiting_phone', 'waiting_trust', 'failed', 'retrying'].includes(e.state) : was === undefined && e.state === 'waiting_phone';
      if (!back || (e.state === 'failed' && e.needsPerson)) continue;
      if (e.state === 'failed') { e.attempts = 0; e.personAttempts = 0; }
      void this.ensure(udid, 'the iPhone reconnected');
    }
    for (const r of this.deps.ledger?.pending() ?? []) {
      if (!managed.has(r.udid) && seen.get(r.udid)?.reachable && !this.busy(r.udid)) void this.cleanUp(r.udid);
    }
  }

  /** Set up (or redo) WebDriverAgent now, for a person who asked: may build and sign. Waits for whatever the phone's
   *  lane is doing, builds, and only then replaces the running WebDriverAgent (so a failed build leaves a working
   *  one alone). */
  async setup(udid: string, onProgress: (l: string) => void): Promise<{ url: string; pid?: number }> {
    const wanted = () => !this.closing && this.deps.managed().includes(udid);
    if (!wanted()) throw cancelledError();
    return this.lane(udid, async () => {
      // Stop, Disconnect or daemon exit while this setup waited its turn: it starts nothing.
      if (!wanted()) throw cancelledError();
      const e = this.entry(udid);
      e.attempts = 0; e.personAttempts = 0; e.needsPerson = false;
      this.set(e, 'starting', 'Setting up WebDriverAgent…');
      try { await this.launchNow(udid, e, true, onProgress); }
      catch (err) {
        if (e.runner?.alive()) this.set(e, 'running', 'WebDriverAgent is running');   // the old one still serves
        else this.failed(udid, e, err, true);
        throw err;
      } finally { this.deps.changed?.(udid); }
      if (e.gone || !e.url) throw cancelledError();
      return { url: e.url, ...(e.runner?.pid ? { pid: e.runner.pid } : {}) };
    });
  }

  /** Stop the runner (on the Mac and the phone) but keep managing the phone: sharing is being turned off, and nothing
   *  may keep serving the Wi-Fi meanwhile. Resolves with how many runners are left on the phone. */
  halt(udid: string, why: string): Promise<number> {
    const e = this.entry(udid);
    e.abort.abort(); e.abort = new AbortController();
    return this.lane(udid, async () => {
      const left = await this.teardown(udid, e, {});
      this.set(e, 'failed', `WebDriverAgent stopped: ${why}`, 'Set Up Control starts it again.');
      this.deps.changed?.(udid);
      return left;
    });
  }

  /** Try again now with a fresh count (setup failed and the previous configuration was put back). */
  resume(udid: string, why: string): void {
    if (!this.started || !this.deps.managed().includes(udid)) return;
    const e = this.entry(udid);
    e.attempts = 0; e.personAttempts = 0; e.needsPerson = false;
    if (!this.busy(udid) && e.state !== 'running') void this.ensure(udid, why);
  }

  /** Stop Control and Disconnect: cancel a build or launch in flight, end WebDriverAgent on the Mac and every runner on
   *  the phone (PhoneDock's or not: the person asked), and stop managing it. The Stop is recorded before the phone is
   *  asked, so one it can't confirm now is finished when the phone is back (for a day). Resolves with how many
   *  runners are left on the phone (0: confirmed none; -1: couldn't confirm). */
  unmanage(udid: string): Promise<number> {
    this.deps.ledger?.mark(udid, { stop: this.deps.now() });
    const e = this.entries.get(udid);
    if (e) { this.entries.delete(udid); e.gone = true; e.abort.abort(); this.deps.changed?.(udid); }
    return this.lane(udid, () => this.teardown(udid, e, { all: true }));
  }

  /** One supervision pass (the timer calls it; tests call it directly). */
  tick(): Promise<void> {
    this.ticking ??= this.tickOnce().finally(() => { this.ticking = undefined; });
    return this.ticking;
  }

  private async tickOnce(): Promise<void> {
    if (!this.started) return;
    // Phones no longer in the configuration are only skipped: Stop and Disconnect stop them explicitly, and an
    // unreadable configuration file must not stop every runner.
    await Promise.all(this.deps.managed().map(async (udid) => {
      const e = this.entry(udid);
      if (this.busy(udid) || e.gone) return;
      const now = this.deps.now();
      switch (e.state) {
        case 'running':
        case 'unreachable': {
          const st = e.url ? await this.deps.status(e.url).catch(() => false as const) : false;
          if (e.gone || this.busy(udid)) return;
          const t = this.deps.now();
          if (st && st.ok) {
            e.okAt = t;
            // Sharing on: the address other Macs use follows the phone's Wi-Fi address.
            if (st.ip !== undefined && st.ip !== e.wifi) {
              e.wifi = st.ip;
              const port = parsePrinted(e.url!)?.port ?? WDA_PORT;
              e.sharedUrl = st.ip ? urlFor(st.ip, port) : undefined;
            }
            // Forgive earlier failures only once this runner has stayed up a while: one that answers and then dies
            // keeps counting toward giving up.
            const up = e.runner ? t - (e.runner.readyAt ?? e.runner.startedAt) : 0;
            if (up >= this.o.minUptimeMs) { e.attempts = 0; e.personAttempts = 0; }
            if (e.runner && e.own === undefined) this.learn(udid, e);
            if (e.state !== 'running') this.set(e, 'running', 'WebDriverAgent is running');
            return;
          }
          if (e.runner && !e.runner.alive()) return;    // its exit handler takes over
          const since = e.okAt ?? e.runner?.readyAt ?? e.runner?.startedAt ?? 0;
          if (t - since < this.o.graceMs) return;
          // Quiet while the phone is away (asleep on Wi-Fi, unplugged): nothing is wrong with the runner. Wait, without
          // counting; the phone coming back with a new tunnel address relaunches it (observe).
          const f = await this.deps.phone(udid).catch(() => undefined);
          if (e.gone || this.busy(udid)) return;
          if (!f?.found || f.reachable === false) {
            if (e.state !== 'unreachable') {
              this.set(e, 'unreachable', `PhoneDock can’t reach WebDriverAgent at ${e.url}`,
                'Keep the iPhone connected (USB, or awake on the same Wi-Fi); PhoneDock picks it up again when it’s back.');
            }
            return;
          }
          // It answered before and is quiet now (hung, or its tunnel went away): replace it, and count it.
          if (++e.attempts >= this.o.maxAttempts) {
            this.giveUp(e, 'WebDriverAgent keeps hanging');
            void this.lane(udid, () => this.teardown(udid, e, {}));
            this.deps.changed?.(udid);
            return;
          }
          void this.ensure(udid, 'WebDriverAgent stopped answering');
          return;
        }
        case 'waiting_unlock': {
          const f = await this.deps.phone(udid).catch(() => undefined);
          if (e.gone || this.busy(udid)) return;
          if (f?.locked === true) { e.sawLocked = true; return; }
          // Seen locked and now unlocked: go. Otherwise (lock state unknown, or devicectl disagrees with xcodebuild)
          // only at the waiting pace, so a lock nobody can read never relaunches xcodebuild every tick.
          if (f?.found && ((f.locked === false && e.sawLocked) || (e.nextAt !== undefined && this.deps.now() >= e.nextAt))) void this.ensure(udid, 'the iPhone was unlocked');
          return;
        }
        case 'starting':     // nothing in flight: an entry nobody started yet
          void this.ensure(udid, 'PhoneDock manages this iPhone');
          return;
        case 'waiting_phone':
        case 'retrying':
          if (e.nextAt !== undefined && now >= e.nextAt) void this.ensure(udid, e.state === 'retrying' ? 'retrying' : 'checking again');
          return;
        case 'waiting_trust':    // only a Retry (setup) or the phone reconnecting: a launch would ask again
        case 'failed':
          return;
      }
    }));
  }

  private entry(udid: string): Entry {
    let e = this.entries.get(udid);
    if (!e) {
      e = { state: 'starting', message: 'Starting WebDriverAgent…', attempts: 0, personAttempts: 0, sawLocked: false, abort: new AbortController(), updatedAt: this.deps.now() };
      this.entries.set(udid, e);
    }
    return e;
  }

  private busy(udid: string): boolean { return (this.lanes.get(udid)?.busy ?? 0) > 0; }

  /** Run `fn` after everything already queued for this phone. */
  private lane<T>(udid: string, fn: () => Promise<T>): Promise<T> {
    let l = this.lanes.get(udid);
    if (!l) { l = { tail: Promise.resolve(), busy: 0 }; this.lanes.set(udid, l); }
    const lane = l;
    lane.busy++;
    // Not busy any more by the time the caller resumes.
    const step = async () => { try { return await fn(); } finally { if (--lane.busy === 0 && this.lanes.get(udid) === lane) this.lanes.delete(udid); } };
    const run = lane.tail.then(step, step);
    lane.tail = run.catch(() => undefined);
    return run;
  }

  private set(e: Entry, state: WdaState, message: string, hint?: string, nextAt?: number): void {
    e.state = state; e.message = message; e.hint = hint; e.nextAt = nextAt; e.updatedAt = this.deps.now();
    // A retry is due before the next tick (a restart after 5 s, say): look then, not up to tickMs later.
    if (nextAt !== undefined && this.o.autoTick && this.started) {
      const t = setTimeout(() => { void this.tick(); }, Math.max(0, nextAt - this.deps.now()) + 50);
      t.unref?.();
    }
  }

  /** One automatic attempt at a time per phone. */
  private ensure(udid: string, why: string): Promise<void> {
    if (!this.started || this.busy(udid)) return Promise.resolve();
    const e = this.entry(udid);
    return this.lane(udid, () => this.attempt(udid, e, why))
      .catch((err) => { this.deps.log(`wda ${udid}: ${(err as Error).message}`); })
      .finally(() => { this.deps.changed?.(udid); });
  }

  private async attempt(udid: string, e: Entry, why: string): Promise<void> {
    if (e.gone || !this.started) return;
    // Waits devicectl can see cost no launch: look again at the waiting pace.
    const f = await this.deps.phone(udid).catch(() => undefined);
    if (e.gone) return;
    // A runner of this service's not confirmed gone (this daemon died, a Stop the phone didn't confirm) may listen on
    // the Wi-Fi: end it as soon as the phone can be reached, also while it waits for an unlock.
    if (!e.runner && this.owed(udid) && f?.found && f.reachable !== false) {
      if ((await this.teardown(udid, e, {})) !== 0) {
        this.set(e, 'retrying', 'PhoneDock couldn’t confirm an earlier WebDriverAgent stopped on the iPhone; it tries again', undefined,
          this.deps.now() + this.backoff(++e.personAttempts));
        return;
      }
      if (e.gone) return;
    }
    const person = this.personWait(f);
    if (person) {
      if (person.state === 'waiting_unlock') e.sawLocked = true;
      this.set(e, person.state, person.message, person.hint, this.deps.now() + this.o.personPollMs);
      return;
    }
    this.set(e, 'starting', `Starting WebDriverAgent (${why})…`);
    this.deps.log(`wda ${udid}: starting (${why})`);
    try { await this.launchNow(udid, e, false, (l) => { if (!e.gone) { e.message = l; e.updatedAt = this.deps.now(); } }); }
    catch (err) { this.failed(udid, e, err, false); }
  }

  private personWait(f: PhoneFacts | undefined): { state: WdaState; message: string; hint?: string } | undefined {
    if (!f?.found || f.reachable === false) {
      return { state: 'waiting_phone', message: 'The iPhone isn’t connected', hint: 'PhoneDock starts WebDriverAgent when it’s back (plugged in, or on the same Wi-Fi and awake).' };
    }
    if (f.paired === false) return { state: 'waiting_phone', message: 'The iPhone doesn’t trust this Mac', hint: 'Plug it in by USB, unlock it and tap Trust.' };
    if (f.developerMode === false) return { state: 'waiting_phone', message: 'Developer Mode is off on the iPhone', hint: 'Settings › Privacy & Security › Developer Mode.' };
    if (f.locked === true) return { state: 'waiting_unlock', message: 'Unlock the iPhone so PhoneDock can start WebDriverAgent', hint: 'After a restart an iPhone stays locked until you enter its passcode.' };
    return undefined;
  }

  /** A person's Stop that isn't confirmed yet (and not older than a day): every runner on the phone is to end. */
  private stopOwed(rec: CleanupRecord | undefined): boolean {
    return rec?.state === 'pending' && rec.stop !== undefined && this.deps.now() - rec.stop < STOP_INTENT_MS;
  }

  /** Something of this service's may still run for the phone: a runner, an xcodebuild, or a Stop not confirmed yet. */
  private owed(udid: string): boolean {
    return this.deps.ledger?.state(udid) === 'pending' || (this.deps.ledger?.hosts?.() ?? []).some((h) => h.udid === udid);
  }

  /** End what this service runs for the phone: its xcodebuild (always waited for: SIGINT, then SIGKILL) and, at the
   *  same time, its runner app on the phone (which can outlive xcodebuild), by the pid it had there; `all` (a person's
   *  Stop, or one still owed): every WebDriverAgent runner on the phone. Then any xcodebuild of this service's for the
   *  phone that outlived its process. Nothing PhoneDock didn't start is touched otherwise. The cleanup record is
   *  cleared only once all of that is confirmed. Resolves with how many runners are left (-1: couldn't confirm).
   *  `ownOnly` (daemon exit): only what this process runs; anything older waits for the next start. */
  private async teardown(udid: string, e: Entry | undefined, o: { all?: boolean; ownOnly?: boolean }): Promise<number> {
    const t0 = this.deps.now();
    const r = e?.runner;
    if (e) e.runner = undefined;
    // Which runner on the phone is this one, if that was still being found out (or failed: ask now). Whatever runs
    // there now started after this launch's check found nothing but PhoneDock's own, which it ended.
    if (e && r && e.own === undefined) this.learn(udid, e);
    await e?.learning;
    const rec = this.deps.ledger?.record(udid);
    const owedStop = this.stopOwed(rec);
    const all = !!o.all || (owedStop && !o.ownOnly);
    const pids = all ? undefined : [...new Set([...(rec?.phonePids ?? []), ...(e?.own ?? [])])];
    const onPhone = all || (pids!.length > 0 && (!o.ownOnly || !!r));
    if (e) e.own = undefined;
    let macMs = 0, phoneMs = 0;
    const [macGone, left] = await Promise.all([
      r ? stopRunner(r).finally(() => { macMs = this.deps.now() - t0; }) : Promise.resolve(true),
      onPhone
        ? this.deps.stopOnPhone(udid, { ...(pids ? { pids } : {}), withinMs: this.o.stopWaitMs }).catch(() => -1).finally(() => { phoneMs = this.deps.now() - t0; })
        : Promise.resolve(0),
    ]);
    const hosts = (this.deps.ledger?.hosts?.() ?? []).filter((h) => h.udid === udid);
    const hostsGone = this.deps.reapHosts ? await this.deps.reapHosts(udid, hosts).catch(() => false) : macGone;
    // Recorded runners this call didn't ask about (daemon exit) stay owed.
    const handled = onPhone || (!all && pids!.length === 0);
    const done = handled && left === 0 && macGone && hostsGone && (all || !owedStop);
    if (done) this.deps.ledger?.clean(udid);
    else this.deps.ledger?.mark(udid);
    if (r || onPhone) {
      const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
      this.deps.log(`wda ${udid}: ${done ? 'WebDriverAgent stopped' : 'couldn’t confirm WebDriverAgent stopped on the iPhone'} in ${s(this.deps.now() - t0)}`
        + `${r ? ` (xcodebuild ${s(macMs)}${macGone ? '' : ', still running'}` : ' ('}${r && onPhone ? ', ' : ''}`
        + `${onPhone ? `${all ? 'every runner' : `runner ${pids!.join(', ')}`} on the iPhone ${s(phoneMs)}${left === 0 ? '' : left === -1 ? ', no answer' : `, ${left} left`}` : ''})`
        + `${hostsGone ? '' : '; an earlier xcodebuild is still running'}`);
    }
    return macGone && hostsGone ? left : (left === 0 ? -1 : left);
  }

  /** The runners on the phone (none known when nothing can list them); devicectl failing is a wait for the phone. */
  private listRunners(udid: string): Promise<number[]> {
    const p = this.deps.runners ? this.deps.runners(udid) : Promise.resolve([]);
    const out = p.catch((err: unknown) => {
      throw new PhoneDockError('PhoneDock couldn’t see what runs on the iPhone', 'no_device', 409,
        ['Keep the iPhone connected and awake; PhoneDock tries again.'], (err as Error)?.message);
    });
    out.catch(() => undefined);           // awaited later (beforeStart); not an unhandled rejection meanwhile
    return out;
  }

  /** The pids the runner this launch started has on the phone: the WebDriverAgent runners there now (beforeStart saw
   *  none but PhoneDock's own, which it ended). Found after the launch, off its critical path; teardown waits for it,
   *  and a tick tries again when devicectl couldn't say. */
  private learn(udid: string, e: Entry): void {
    if (!this.deps.runners || e.learnBusy) return;
    e.learnBusy = true;
    e.learning = this.deps.runners(udid).then((pids) => {
      e.own = pids;
      this.deps.ledger?.mark(udid, { phonePids: pids });
    }, () => undefined).finally(() => { e.learnBusy = false; });
  }

  /** Build (if `mayBuild`), then replace the current runner (if any) with a new one, which starts only once the old
   *  one is gone on the Mac and on the phone. The current runner keeps serving until the build is done. A runner on
   *  the phone that PhoneDock didn't start is left alone and the launch refused (Stop Control ends it). */
  private async launchNow(udid: string, e: Entry, mayBuild: boolean, onProgress: (l: string) => void): Promise<void> {
    let spawned = false;
    const t0 = this.deps.now();
    // What runs on the phone is listed while the build is checked and the address looked up.
    let listing = this.listRunners(udid);
    let r: Omit<Launched, 'built'>;
    try {
      r = await this.deps.launch(udid, onProgress, {
        signal: e.abort.signal, mayBuild,
        beforeStart: async () => {
          if (this.deps.now() - t0 > 10_000) listing = this.listRunners(udid);   // a build ran meanwhile: look again
          const onPhone = await listing;
          const rec = this.deps.ledger?.record(udid);
          const ours = new Set([...(rec?.phonePids ?? []), ...(e.own ?? [])]);
          if (!this.stopOwed(rec) && onPhone.some((p) => !ours.has(p))) throw foreignRunnerError();
          if (e.runner || onPhone.length || this.owed(udid)) {
            const left = await this.teardown(udid, e, {});
            if (left !== 0) {
              throw new PhoneDockError('PhoneDock couldn’t confirm the previous WebDriverAgent stopped on the iPhone', 'wda_stop_unconfirmed', 502,
                ['Keep the iPhone connected and awake; PhoneDock tries again.']);
            }
          }
          if (e.gone) throw cancelledError();
        },
        onSpawn: (pid, info) => {
          spawned = true;
          // From now on something may run: whatever happens to this process, the next start knows to look.
          this.deps.ledger?.mark(udid);
          if (!pid || !this.deps.ledger?.addHost) return;
          this.deps.ledger.addHost({ pid, lstart: this.deps.processStart?.(pid) ?? '', destination: info?.destination ?? `id=${udid}`, phase: info?.phase ?? 'launch', udid });
          void info?.exited?.then(() => this.deps.ledger?.removeHost?.(pid));
        },
      });
    } catch (err) {
      // A launch that got as far as starting leaves nothing behind on the phone either.
      if (spawned) await this.teardown(udid, e, {});
      throw err;
    }
    if (e.gone) { e.runner = r.runner; await this.teardown(udid, e, {}); throw cancelledError(); }
    e.runner = r.runner; e.url = r.url; e.boundHost = hostOf(r.url); e.sharedUrl = r.sharedUrl; e.lanCheck = r.lanCheck; e.wifi = r.wifi;
    e.okAt = this.deps.now(); e.sawLocked = false;
    this.set(e, 'running', 'WebDriverAgent is running');
    this.deps.log(`wda ${udid}: running at ${r.url} (xcodebuild pid ${r.runner.pid ?? '?'}${r.lanCheck ? `, Wi-Fi address ${r.lanCheck}` : ''}${r.sharedUrl ? `, shared at ${r.sharedUrl}` : ''})`);
    this.learn(udid, e);
    const runner = r.runner;
    void runner.exited.then(() => this.onExit(udid, e, runner));
  }

  /** The runner's xcodebuild ended without anyone asking. Every such exit counts toward giving up, also one right
   *  after its launch; the runner app may live on on the phone, so it is ended there before anything starts again. */
  private onExit(udid: string, e: Entry, runner: Runner): void {
    if (e.gone || e.runner !== runner || this.entries.get(udid) !== e) return;
    e.runner = undefined;
    const up = this.deps.now() - (runner.readyAt ?? runner.startedAt);
    e.attempts++;
    this.deps.log(`wda ${udid}: WebDriverAgent stopped after ${Math.round(up / 1000)} s (${e.attempts}/${this.o.maxAttempts})`);
    if (e.attempts >= this.o.maxAttempts) {
      this.giveUp(e, up < this.o.minUptimeMs ? 'WebDriverAgent keeps stopping right after it starts' : 'WebDriverAgent keeps stopping');
    } else {
      this.set(e, 'retrying', 'WebDriverAgent stopped; PhoneDock is restarting it', undefined, this.deps.now() + this.backoff(e.attempts));
    }
    void this.lane(udid, () => this.teardown(udid, e, {})).catch(() => undefined);
    this.deps.changed?.(udid);
  }

  /** A launch failed: wait for a person, retry with backoff, or give up. */
  private failed(udid: string, e: Entry, err: unknown, manual: boolean): void {
    if (e.gone) return;
    const pe = err instanceof PhoneDockError ? err : new PhoneDockError((err as Error)?.message ?? String(err), 'wda_setup_failed', 502);
    if (pe.code === 'cancelled') return;
    this.deps.log(`wda ${udid}: ${pe.code}: ${pe.message}`);
    const hint = pe.hints?.[0];
    if (pe.code === 'wda_untrusted') {
      // Each launch would show the trust prompt again: wait for the person's Retry, or the phone reconnecting.
      this.set(e, 'waiting_trust', pe.message, hint);
      return;
    }
    if (PERSON_CODES.has(pe.code)) {
      // Found only by launching (devicectl saw nothing wrong): wait longer each time, and give up after a while.
      e.personAttempts++;
      if (e.personAttempts > this.o.maxPersonAttempts) { this.giveUp(e, pe.message, hint); return; }
      const delay = this.o.personBackoffMs[Math.min(e.personAttempts - 1, this.o.personBackoffMs.length - 1)];
      const state: WdaState = pe.code === 'device_locked' ? 'waiting_unlock' : 'waiting_phone';
      this.set(e, state, pe.code === 'device_locked' ? 'Unlock the iPhone so PhoneDock can start WebDriverAgent' : pe.message, hint, this.deps.now() + delay);
      return;
    }
    if (AUTHORITY_CODES.has(pe.code)) {
      // Retrying can't help (and must not sign anything): wait for the person to set up again.
      e.needsPerson = true;
      this.giveUp(e, pe.message, hint);
      return;
    }
    if (manual) { this.giveUp(e, pe.message, hint); return; }
    if (++e.attempts >= this.o.maxAttempts) { this.giveUp(e, pe.message, hint); return; }
    this.set(e, 'retrying', `${pe.message}; PhoneDock tries again`, hint, this.deps.now() + this.backoff(e.attempts));
  }

  private giveUp(e: Entry, why: string, hint?: string): void {
    this.set(e, 'failed', `Couldn’t start WebDriverAgent: ${why}`, hint ?? 'Set Up Control again in PhoneDock, or run `phonedock ios wda-setup`.');
  }

  private backoff(attempts: number): number {
    return this.o.backoffMs[Math.min(Math.max(attempts, 1) - 1, this.o.backoffMs.length - 1)];
  }

  /** Finish a cleanup owed for a phone this service doesn't manage (Stopped or Disconnected unconfirmed, or a
   *  PhoneDock that died). */
  private cleanUp(udid: string): Promise<void> {
    return this.lane(udid, async () => {
      if (this.deps.managed().includes(udid)) return;
      await this.teardown(udid, undefined, {});
    }).then(() => undefined, () => undefined);
  }
}

// ── one-step setup ─────────────────────────────────────────────────────────

/** A phone's entry in ios-device.json, as far as setup reads and writes it. */
export interface SetupEntry {
  udid?: string; name?: string;
  wda?: WdaConfig & { since: string };
  wdaStopped?: WdaConfig & { stoppedAt: string };
  [k: string]: unknown;
}
export interface SetupRequest { team?: string; destination?: string; name?: string; apiKey?: WdaApiKey; share?: boolean }
/** `udid` is the identifier the caller passed; `hardwareUdid` the phone's UDID, which ios-device.json and the
 *  supervisor use. */
export interface WdaSetupResult { udid: string; hardwareUdid: string; wdaUrl: string; pid?: number; team: string; managed: true; shared: boolean; sharedUrl?: string }
/** A simulator, as before 0.7.0: WebDriverAgent started with the destination as given, saved under `udid`, not kept
 *  running. Its address is now this Mac's 127.0.0.1 only. */
export interface SimSetupResult { udid: string; wdaUrl: string; pid?: number; managed: false }
/** What a `-destination` names: a phone (its hardware UDID), a simulator, several devices, or nothing PhoneDock sees. */
export interface DestinationFacts { udid?: string; simulator?: boolean; ambiguous?: boolean }

export interface SetupDeps {
  xcode(): Promise<XcodeInfo | undefined>;
  teams(): Promise<XcodeTeam[]>;
  /** devicectl's facts for a phone found by its UDID or its CoreDevice identifier; `udid` is the hardware UDID. */
  phone(id: string): Promise<PhoneFacts & { udid?: string }>;
  developerMode(udid: string): Promise<boolean | null | undefined>;
  exists(path: string): boolean;
  /** Stop Control and Disconnect mark a phone (by every name it has); a setup that began before the mark changes
   *  nothing and starts nothing. */
  marks: { now(): number; since(udid: string, t: number): boolean };
  store: { get(udid: string): SetupEntry | undefined; set(udid: string, entry: SetupEntry | undefined): void };
  sup: Pick<WdaSupervisor, 'setup' | 'info' | 'unmanage' | 'resume' | 'halt'>;
  changed(): void;
  /** Whether this service is the Mac's one WebDriverAgent owner (absent: it is). */
  owner?(): boolean;
  /** Resolve a `-destination` against devicectl and the simulators (absent: only `id=`/`name=` of this phone pass). */
  resolveDestination?(dest: string): Promise<DestinationFacts>;
  /** Start WebDriverAgent on a simulator the way setup did before 0.7.0 (bound to 127.0.0.1). */
  simulator?(dest: string, udid: string, onProgress: (l: string) => void): Promise<{ url: string; pid?: number; deviceId?: string }>;
}

/** WebDriverAgent on a phone is set up, launched, relaunched and stopped by one service per Mac. */
export function notOwnerError(): PhoneDockError {
  return new PhoneDockError('PhoneDock’s own service manages WebDriverAgent on this Mac, not this one', 'wda_not_owner', 409,
    ['Use the PhoneDock app (its service on port 47420). A service for tests or proofs opts in with PHONEDOCK_WDA_OWNER=1.']);
}

/** `-destination` names this phone: `id=` one of its identifiers, or `name=` its name. Nothing else is accepted: a
 *  destination without either could pick any device. */
export function destinationNames(dest: string, ids: string[], name?: string): boolean {
  const kv = new Map(dest.split(',').map((p) => { const i = p.indexOf('='); return [p.slice(0, i).trim().toLowerCase(), p.slice(i + 1).trim()] as const; }));
  const id = kv.get('id'), nm = kv.get('name');
  if (id === undefined && nm === undefined) return false;
  return (id === undefined || ids.some((x) => x.toLowerCase() === id.toLowerCase())) && (nm === undefined || (!!name && nm === name));
}

/** Codes a wda-setup job failed with before this version, kept as they were; every other failure keeps the old
 *  catch-all code `wda_setup_failed` and names the specific one in `cause`. Getting WebDriverAgent's source was a
 *  `git clone` before (`exec_failed` when it failed): a failed download keeps that code. */
const SETUP_KEEPS = new Set(['bad_request', 'exec_failed']);
const SOURCE_CODES = new Set(['download_failed', 'install_failed', 'self_check_failed']);
function asSetupError(e: unknown): unknown {
  if (!(e instanceof PhoneDockError) || SETUP_KEEPS.has(e.code) || e.code === 'wda_setup_failed') return e;
  const out = new PhoneDockError(e.message, SOURCE_CODES.has(e.code) ? 'exec_failed' : 'wda_setup_failed', e.status, e.hints, e.detail);
  out.cause = e.code;
  return out;
}

/** A simulator: as before 0.7.0 (the destination passed through, saved under the caller's udid, not supervised, so
 *  any service may do it), except that WebDriverAgent listens on this Mac's 127.0.0.1 only. */
async function setupSimulator(d: SetupDeps, id: string, req: SetupRequest, onProgress: (l: string) => void,
  stoppedMeanwhile: (...ids: string[]) => boolean): Promise<SimSetupResult> {
  if (!d.simulator) throw new PhoneDockError('Simulators aren’t set up here', 'not_supported', 501);
  const r = await d.simulator(req.destination!, id, onProgress);
  if (stoppedMeanwhile(id)) throw cancelledError();
  const cur = d.store.get(id);
  d.store.set(id, {
    ...(cur && !cur.wda ? cur : {}), udid: id, wdaUrl: r.url, address: hostOf(r.url), ...(req.name ? { name: req.name } : {}),
    ...(r.deviceId ? { wdaDeviceId: r.deviceId } : {}), savedAt: new Date().toISOString(),
  });
  d.changed();
  onProgress(`WebDriverAgent is running at ${r.url} (saved for ${id}; reachable only from this Mac)`);
  return { udid: id, wdaUrl: r.url, ...(r.pid ? { pid: r.pid } : {}), managed: false };
}

/** One-step setup: preflight with plain errors, pick the team, build the pinned WebDriverAgent if needed, start it,
 *  and from then on keep it running. Turning sharing off takes effect first, durably; otherwise nothing is written
 *  before preflight passes. Stop or Disconnect during setup wins; a failure puts the phone's whole entry back. */
export async function setupPhone(d: SetupDeps, id: string, req: SetupRequest, progress: (l: string) => void): Promise<WdaSetupResult | SimSetupResult> {
  try { return await setupSteps(d, id, req, progress); } catch (e) { throw asSetupError(e); }
}

async function setupSteps(d: SetupDeps, id: string, req: SetupRequest, progress: (l: string) => void): Promise<WdaSetupResult | SimSetupResult> {
  // The generation when the request arrived (the caller takes it before its first await): a Stop after it wins.
  const t0 = d.marks.now();
  let last = '';
  const onProgress = (l: string) => { if (l !== last) { last = l; progress(l); } };
  const stoppedMeanwhile = (...ids: string[]) => ids.some((u) => d.marks.since(u, t0));
  if (stoppedMeanwhile(id)) throw cancelledError();
  // What the destination names. A simulator keeps the setup it had before 0.7.0; a phone is launched by its
  // hardware UDID, whatever the destination called it.
  const named = req.destination && d.resolveDestination ? await d.resolveDestination(req.destination) : undefined;
  if (named?.ambiguous) {
    throw new PhoneDockError('The destination names more than one device', 'bad_request', 400,
      ['Pass `id=<the iPhone’s udid>` (or leave destination out).'], `destination ${req.destination}`);
  }
  const sim = named ? !!named.simulator : !!req.destination && !isDeviceDestination(req.destination);
  if (sim) return setupSimulator(d, id, req, onProgress, stoppedMeanwhile);
  if (d.owner && !d.owner()) throw notOwnerError();
  // Sharing off: nobody on the Wi-Fi keeps control while the rest runs, or after it fails. Saved in the running and
  // the stopped setup alike (a later plain setup inherits neither), then the shared runner is stopped, before
  // anything that can fail. A stop the phone doesn't confirm stays owed: the next launch ends it first, or fails.
  const before = d.store.get(id);
  const optOut = req.share === false && (!!before?.wda?.share || !!before?.wdaStopped?.share);
  if (optOut && before) {
    const next: SetupEntry = { ...before };
    if (before.wda) { const { share: _s, ...wda } = before.wda; next.wda = wda; }
    if (before.wdaStopped) { const { share: _s, ...stopped } = before.wdaStopped; next.wdaStopped = stopped; }
    const key = before.udid ?? id;
    d.store.set(key, next);
    if (before.wda?.share) {
      onProgress('Turning sharing off…');
      if ((await d.sup.halt(key, 'sharing was turned off')) !== 0) onProgress('PhoneDock couldn’t confirm the shared WebDriverAgent stopped; it ends it before starting another');
    }
    d.changed();
  }
  onProgress('Checking Xcode and the iPhone…');
  const [xcode, teams, facts] = await Promise.all([
    d.xcode(), d.teams(), d.phone(id).catch((): PhoneFacts & { udid?: string } => ({ found: false })),
  ]);
  const udid = facts.udid ?? id;
  if (stoppedMeanwhile(id, udid)) throw cancelledError();
  // One phone, one name: the CoreDevice identifier and the UDID are the same iPhone, and the destination must be it.
  if (req.destination && (named ? named.udid !== udid : !destinationNames(req.destination, [id, udid], facts.name))) {
    throw new PhoneDockError('The destination names a different device', 'bad_request', 400,
      ['Pass `id=<this iPhone’s udid>` or `name=<its name>` (or leave destination out).'], `destination ${req.destination}, udid ${udid}`);
  }
  if (facts.found && facts.developerMode == null) {
    facts.developerMode = (await d.developerMode(udid).catch(() => null)) ?? null;
    if (stoppedMeanwhile(id, udid)) throw cancelledError();
  }
  const err = preflight(xcode, facts, udid);
  if (err) throw err;

  const cur = d.store.get(udid);
  const prior = cur?.wda ?? cur?.wdaStopped;
  // Nothing asked for: reuse this phone's last setup (running, or stopped with Stop Control), and so its build.
  const reuse = req.team === undefined && !req.apiKey ? prior : undefined;
  const reuseKey = reuse?.apiKey && d.exists(reuse.apiKey.path) ? reuse.apiKey : undefined;
  const apiKey = req.apiKey ?? reuseKey;
  const team = chooseTeam(teams, { team: req.team ?? (reuseKey ? reuse?.team : undefined), apiKey, udid, remembered: reuse?.team });
  onProgress(`Signing with team ${team.id}${team.free ? ' (a personal team: its signing lasts 7 days; set up again to renew it)' : ''}`);
  const share = req.share ?? prior?.share ?? false;
  // No destination is saved: the phone is launched by its hardware UDID only.
  const { destination: _dest, ...priorCfg } = prior ?? ({} as Partial<WdaConfig>);
  let cfg: WdaConfig = {
    team: team.id, free: team.free,
    // A team that fell back to its own runner id before keeps it.
    bundleId: priorCfg.team === team.id && priorCfg.bundleId ? priorCfg.bundleId : runnerBundleId(team.id, team.free),
    ...(apiKey ? { apiKey } : {}), ...(share ? { share: true } : {}),
  };
  const snapshot = cur ? structuredClone(cur) : undefined;
  const since = cur?.wda?.since ?? new Date().toISOString();
  const commit = (c: WdaConfig) => {
    if (stoppedMeanwhile(id, udid)) throw cancelledError();
    d.store.set(udid, { ...(d.store.get(udid) ?? {}), udid, ...(req.name ? { name: req.name } : {}), wda: { ...c, since } });
  };
  commit(cfg);
  try {
    let r: { url: string; pid?: number };
    try { r = await d.sup.setup(udid, onProgress); }
    catch (e) {
      // A paid team whose profile can't cover upstream's runner id: its own id, once.
      if (!(e instanceof PhoneDockError) || e.code !== 'bundle_id_unavailable' || cfg.bundleId !== UPSTREAM_RUNNER_BUNDLE_ID) throw e;
      cfg = { ...cfg, bundleId: teamScopedBundleId(cfg.team) };
      onProgress(`Team ${cfg.team} can’t sign WebDriverAgent’s usual app ID; trying its own (${cfg.bundleId})…`);
      commit(cfg);
      r = await d.sup.setup(udid, onProgress);
    }
    // Done only while it still runs (one that dies right after printing its address is a failed setup).
    const info = d.sup.info(udid);
    if (info && info.state !== 'running') {
      throw new PhoneDockError('WebDriverAgent stopped right after it started', 'wda_stopped', 502, [info.message, ...(info.hint ? [info.hint] : [])]);
    }
    const done = d.store.get(udid);
    if (done?.wda && done.wdaStopped) { const next = { ...done }; delete next.wdaStopped; d.store.set(udid, next); }
    d.changed();
    return {
      udid: id, hardwareUdid: udid, wdaUrl: r.url, ...(r.pid ? { pid: r.pid } : {}), team: cfg.team, managed: true,
      shared: !!cfg.share, ...(info?.sharedUrl ? { sharedUrl: info.sharedUrl } : {}),
    };
  } catch (e) {
    if ((e instanceof PhoneDockError && e.code === 'cancelled') || stoppedMeanwhile(id, udid)) { d.changed(); throw e instanceof PhoneDockError && e.code === 'cancelled' ? e : cancelledError(); }
    const info = d.sup.info(udid);
    if (info?.state === 'waiting_unlock' || info?.state === 'waiting_phone') {
      // The service took it on: it starts WebDriverAgent once the person has done their part.
      if (e instanceof PhoneDockError) e.hints = [...(e.hints ?? []), 'PhoneDock keeps trying: it starts WebDriverAgent as soon as that’s done.'];
    } else if (info?.state !== 'waiting_trust') {
      // Nothing to wait for: put the phone's entry back as it was (a new name too), and with it the previous
      // setup and its WebDriverAgent, or stop managing the phone. Sharing that was turned off stays off, and stays
      // stopped: never shared again by a rollback.
      d.store.set(udid, snapshot);
      if (snapshot?.wda && !optOut) d.sup.resume(udid, 'setup failed; back to the previous setup');
      else if (!snapshot?.wda) await d.sup.unmanage(udid);
    }
    d.changed();
    throw e;
  }
}
