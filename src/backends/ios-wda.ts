// WebDriverAgent for iPhones on iOS 26 and older (iOS 27+ is controlled natively: ios-hid.ts, ios-native.ts).
//
// PhoneDock builds the pinned appium/WebDriverAgent source (component 'wda') once per Mac, signing team, Xcode build
// and runner bundle id with `xcodebuild build-for-testing`, then starts it on the phone with
// `xcodebuild test-without-building -xctestrun <file>`. By default WebDriverAgent listens only on the phone's end of
// this Mac's paired CoreDevice tunnel (TEST_RUNNER_USE_IP), so nothing else on the network can reach it; sharing it on
// the Wi-Fi is a per-phone opt-in. WdaSupervisor keeps it running (daemon start, the phone reappearing, /status going
// quiet, the tunnel address changing) with bounded backoff, one launcher per phone on this Mac (HostClaims), and ends
// it on the phone too whenever it stops one (the runner app can outlive xcodebuild).
//
// Everything that touches the system arrives through injected functions, so this file is unit-tested with fakes
// (ios-wda.test.ts). ios-device.ts wires in devicectl, the component manager, ios-device.json and real processes.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  let t = text.replace(/(-authenticationKey(?:Path|ID|IssuerID))(\s+|=)("[^"]*"|\S+)/g, '$1$2<redacted>');
  if (key) {
    for (const [v, label] of [[key.path, '<api-key-path>'], [key.keyId, '<api-key-id>'], [key.issuerId, '<api-key-issuer>']] as const) {
      if (v) t = t.split(v).join(label);
    }
  }
  return t;
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
export function rebuildReason(o: { xctestrun?: string; profile?: ProfileInfo; udid?: string; now: number; device: boolean }): string | undefined {
  if (!o.xctestrun) return 'not built for this team and Xcode yet';
  if (!o.device) return undefined;    // a simulator destination: no profile
  if (!o.profile) return 'the build has no provisioning profile';
  if (o.profile.expiresAt !== undefined && o.profile.expiresAt - o.now < EXPIRY_MARGIN_MS) {
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
  if (/Failed to register bundle identifier|bundle identifier .*(cannot be registered|is not available)/i.test(text)) {
    return new PhoneDockError(`Team${team} can’t register WebDriverAgent’s app ID`, 'bundle_id_unavailable', 409,
      ['Sign in with the Apple ID of a paid developer team in Xcode › Settings › Accounts, or try another team.'], tail);
  }
  if (/maximum (number of )?App ID|App ID limit|maximum number of (registered|apps)/i.test(text)) {
    return new PhoneDockError(`Team${team} reached Apple’s limit for new apps this week`, 'signing_limit', 409,
      ['A free Apple ID can register 10 app IDs every 7 days: try again later, or use a paid team.'], tail);
  }
  if (/doesn['’]t include the currently selected device|does not include the currently selected device|device .* is not registered/i.test(text)) {
    return new PhoneDockError(`This iPhone isn’t registered with team${team}`, 'device_not_registered', 409,
      ['Sign in to Xcode with an account that may register devices for that team (Admin or Account Holder), then try again.'], tail);
  }
  // The specific causes first: iOS words an expired or revoked signature with the same generic sentence it uses for
  // an untrusted developer ("invalid code signature, inadequate entitlements or its profile has not been explicitly
  // trusted"), so that sentence alone proves nothing.
  if (/profile has expired|certificate has expired|provisioning profile .*expired|signature .*expired|certificate (has been|was) revoked/i.test(text)) {
    return new PhoneDockError('WebDriverAgent’s signing expired', 'signing_expired', 409, ['PhoneDock rebuilds it; try again if this persists.'], tail);
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
  /** SIGINT, then SIGKILL after a grace period. */
  kill(): void;
  /** Resolves when xcodebuild exits. On a phone the runner app can outlive it: stop that with devicectl too. */
  exited: Promise<number | null>;
}

/** Stop a runner and wait (bounded) until it has exited, so its replacement never overlaps it. */
export async function stopRunner(r: Runner, waitMs = 15_000): Promise<void> {
  if (!r.alive()) return;
  r.kill();
  await Promise.race([r.exited, new Promise<void>((res) => { const t = setTimeout(res, waitMs); t.unref?.(); })]);
}

export function cancelledError(): PhoneDockError {
  return new PhoneDockError('Setup was stopped', 'cancelled', 409, ['Control was stopped, or the iPhone disconnected in PhoneDock, while it was being set up.']);
}

/** Run build-for-testing to completion; reject with a classified error. A first signing can stop at a macOS prompt
 *  ("codesign wants to use a key in your keychain") that nobody sees from a service, so it has a time limit; a stop
 *  (time limit or `signal`) escalates to SIGKILL and never waits forever for the exit. */
export async function runBuild(spawn: Spawn, plan: BuildPlan, env: NodeJS.ProcessEnv, onProgress: (l: string) => void,
  ctx: { udid?: string; timeoutMs?: number; signal?: AbortSignal; graceMs?: number } = {}): Promise<void> {
  if (ctx.signal?.aborted) throw cancelledError();
  const child = spawn('xcodebuild', buildArgv(plan), { env: { ...env, WDA_PRODUCT_BUNDLE_IDENTIFIER: plan.bundleId } });
  track(child);
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
  o: { xctestrun: string; destination: string; env: NodeJS.ProcessEnv; now: () => number; timeoutMs?: number; udid?: string; team?: string; signal?: AbortSignal; graceMs?: number; apiKey?: WdaApiKey },
  onProgress: (l: string) => void): Promise<{ runner: Runner; url: string }> {
  if (o.signal?.aborted) return Promise.reject(cancelledError());
  const child = spawn('xcodebuild', launchArgv(o.xctestrun, o.destination), { env: o.env });
  track(child);
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
      kill: () => stopChild(child, () => alive, o.graceMs),
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
    const onAbort = () => { if (settled) return; finish(); runner.kill(); reject(cancelledError()); };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      if (settled) return;
      finish(); runner.kill();
      reject(new PhoneDockError('WebDriverAgent didn’t start in time', 'wda_setup_failed', 504,
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
export const sameHost = (a: string, b: string) => a.replace(/^\[|\]$/g, '').toLowerCase() === b.replace(/^\[|\]$/g, '').toLowerCase();
export const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^\[|\]$/g, ''); } catch { return undefined; } };

/** Where this Mac reaches a phone's WebDriverAgent. By default it is bound to that address only: the phone's end of
 *  this Mac's paired CoreDevice tunnel (USB or Wi-Fi), so nothing else on the network reaches it. */
export interface WdaEndpoint {
  /** The phone's tunnel address (a simulator: 127.0.0.1). */
  host: string;
  /** The phone's name on the local network, for other Macs when sharing is on (devicectl's localHostnames). */
  lanName?: string;
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
  /** Cross-process build lock: this process's pid, and whether another one still runs. */
  pid?: number;
  alive?(pid: number): boolean;
  lockPollMs?: number;
}

const BUILD_KEEP_MS = 30 * DAY_MS;
/** After Apple refuses a new app ID or certificate for quota, that team isn't asked again for this long. */
export const SIGNING_COOLDOWN_MS = DAY_MS;

export const destinationFor = (udid: string, cfg: WdaConfig) => cfg.destination ?? `id=${udid}`;

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** One build at a time per build directory: two phones on one team share it, and two xcodebuilds in one
 *  DerivedData fight over its build database. In this process (a promise chain), and across processes that share
 *  the state directory (a lock file holding the builder's pid; a dead holder's lock is taken over). */
const buildLocks = new Map<string, Promise<void>>();
async function withBuildLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const before = buildLocks.get(key) ?? Promise.resolve();
  const run = before.then(fn);
  const settled = run.then(() => undefined, () => undefined);
  buildLocks.set(key, settled);
  try { return await run; } finally { if (buildLocks.get(key) === settled) buildLocks.delete(key); }
}
async function withFileLock<T>(d: Pick<WdaBuildDeps, 'pid' | 'alive' | 'lockPollMs' | 'now'>, path: string, signal: AbortSignal | undefined,
  onWait: () => void, fn: () => Promise<T>): Promise<T> {
  const pid = d.pid ?? process.pid;
  const alive = d.alive ?? pidAlive;
  let waited = false;
  for (;;) {
    try { writeFileSync(path, JSON.stringify({ pid, at: new Date(d.now()).toISOString() }), { flag: 'wx' }); break; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    let holder: number | undefined;
    try { holder = Number(JSON.parse(readFileSync(path, 'utf8')).pid) || undefined; } catch { holder = undefined; }
    if (holder === undefined || holder === pid || !alive(holder)) { rmSync(path, { force: true }); continue; }
    if (signal?.aborted) throw cancelledError();
    if (!waited) { waited = true; onWait(); }
    await new Promise((r) => setTimeout(r, d.lockPollMs ?? 2_000));
  }
  try { return await fn(); }
  finally {
    try { if (Number(JSON.parse(readFileSync(path, 'utf8')).pid) === pid) rmSync(path, { force: true }); } catch { /* gone */ }
  }
}

function readCooldowns(buildsDir: string): Record<string, number> {
  try { const j = JSON.parse(readFileSync(join(buildsDir, '.signing-cooldown.json'), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
}

/** Make sure a signed build that this phone can run exists, building it when the key changed, the signing is about
 *  to expire, or the phone isn't in the profile yet. */
export async function ensureBuild(d: WdaBuildDeps, udid: string, cfg: WdaConfig, onProgress: (l: string) => void,
  opts: { force?: string; signal?: AbortSignal } = {}): Promise<{ dir: string; xctestrun: string; built: boolean; reason?: string; builtAt?: number }> {
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
  return withBuildLock(key, () => withFileLock(d, join(d.buildsDir, `.${key}.lock`), opts.signal,
    () => onProgress('Waiting for another PhoneDock build of WebDriverAgent to finish…'), async () => {
      if (opts.signal?.aborted) throw cancelledError();
      // Checked inside the lock: another phone's build may have just made what this one needs.
      let xctestrun = findXctestrun(derivedData, platform);
      const profile = xctestrun && device ? await readProfile(runnerApp(derivedData, platform), d.exec) : undefined;
      const reason = opts.force ?? rebuildReason({ xctestrun, profile, udid, now: d.now(), device });
      if (!reason && xctestrun) {
        d.writeFile(join(dir, '.last-used'), new Date(d.now()).toISOString() + '\n');
        return { dir, xctestrun, built: false, builtAt: builtAtOf(dir) };
      }
      // Apple refused this team a new app ID or certificate lately: don't ask again (and again) until it may work.
      const until = readCooldowns(d.buildsDir)[cfg.team];
      if (device && typeof until === 'number' && until > d.now()) {
        throw new PhoneDockError(`Team ${cfg.team} reached Apple’s limit for new apps; PhoneDock waits before asking again`, 'signing_limit', 409,
          [`Try again after ${new Date(until).toISOString().slice(0, 16).replace('T', ' ')} UTC, or use another team.`]);
      }
      onProgress(`Building WebDriverAgent ${src.version} ${device ? `for team ${cfg.team}` : 'for the simulator'} (${reason}). The first build takes a few minutes…`);
      d.mkdir(dir);
      const project = join(dir, 'src');
      // Build a private copy: xcodebuild may write next to the project, and the verified component stays as downloaded.
      if (!existsSync(join(project, 'WebDriverAgent.xcodeproj'))) {
        d.remove(project);
        await d.copyTree(src.path, project);
      }
      try {
        await runBuild(d.spawn, { project: join(project, 'WebDriverAgent.xcodeproj'), derivedData, destination, team: cfg.team, bundleId: cfg.bundleId, apiKey: cfg.apiKey },
          d.env, onProgress, { udid, signal: opts.signal });
      } catch (e) {
        if (e instanceof PhoneDockError && e.code === 'signing_limit') {
          const all = readCooldowns(d.buildsDir);
          all[cfg.team] = d.now() + SIGNING_COOLDOWN_MS;
          d.writeFile(join(d.buildsDir, '.signing-cooldown.json'), JSON.stringify(all) + '\n');
        }
        throw e;
      }
      xctestrun = findXctestrun(derivedData, platform);
      if (!xctestrun) throw new PhoneDockError('Couldn’t build WebDriverAgent', 'wda_setup_failed', 502, undefined, `xcodebuild build-for-testing wrote no ${platform} .xctestrun under ${derivedData}`);
      const now = d.now(), at = new Date(now).toISOString();
      d.writeFile(join(dir, 'build.json'), JSON.stringify({ key, wdaVersion: src.version, artifact: src.key, platform, team: cfg.team, bundleId: cfg.bundleId, xcode: xcode.build, builtAt: at, reason }, null, 2) + '\n');
      d.writeFile(join(dir, '.last-used'), at + '\n');
      pruneBuilds(d, key);
      return { dir, xctestrun, built: true, reason, builtAt: now };
    }));
}

function builtAtOf(dir: string): number | undefined {
  try { const t = Date.parse(JSON.parse(readText(join(dir, 'build.json')) ?? '{}').builtAt); return Number.isFinite(t) ? t : undefined; } catch { return undefined; }
}

/** Builds nobody launched for 30 days (an old Xcode, an old WebDriverAgent pin, another team) are deleted. */
export function pruneBuilds(d: Pick<WdaBuildDeps, 'buildsDir' | 'now' | 'remove'>, keep: string, read: (p: string) => string | undefined = readText): string[] {
  const removed: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(d.buildsDir); } catch { return removed; }
  for (const n of names) {
    if (n === keep || n.startsWith('.') || buildLocks.has(n) || existsSync(join(d.buildsDir, `.${n}.lock`))) continue;
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

/** A build this recent that the phone refuses is refused for a reason a rebuild won't fix. */
const FRESH_BUILD_MS = 3_600_000;

export interface Launched {
  runner: Runner;
  /** How this Mac reaches it: the phone's tunnel address and the port it printed. */
  url: string;
  /** Sharing on: what other Macs connect to (the phone's local hostname, else its Wi-Fi address). */
  sharedUrl?: string;
  /** Private mode: the phone's Wi-Fi address refused WebDriverAgent's ports ('refused'), couldn't be checked from
   *  here ('unverified': the bind itself was confirmed), or the phone has no Wi-Fi address ('none'). */
  lanCheck?: 'refused' | 'unverified' | 'none';
  built: boolean;
}

/** Build if needed, then start the runner bound to the phone's private address (or every address when sharing is
 *  on), and fail closed: a runner that didn't bind where it was told to, or that answers on the phone's Wi-Fi address
 *  while it shouldn't, is stopped and reported. `beforeStart` runs between build and start (the supervisor stops the
 *  old runner there, so a failed build leaves a working WebDriverAgent alone). A launch refused for expired signing,
 *  or with a signature an older build no longer passes, rebuilds once. */
export async function launchWda(d: WdaBuildDeps, udid: string, cfg: WdaConfig, onProgress: (l: string) => void,
  opts: { timeoutMs?: number; signal?: AbortSignal; beforeStart?: () => Promise<void> } = {}): Promise<Launched> {
  let b = await ensureBuild(d, udid, cfg, onProgress, { signal: opts.signal });
  await opts.beforeStart?.();
  const destination = destinationFor(udid, cfg);
  const device = isDeviceDestination(destination);
  const start = async (): Promise<Launched> => {
    if (opts.signal?.aborted) throw cancelledError();
    const ep = await d.endpoint(udid, cfg);
    const env: NodeJS.ProcessEnv = {
      ...d.env,
      // Passed to the runner without the prefix (man xcodebuild); FBWebServer binds HTTP and MJPEG to USE_IP.
      TEST_RUNNER_USE_PORT: String(WDA_PORT), TEST_RUNNER_MJPEG_SERVER_PORT: String(MJPEG_PORT),
      ...(cfg.share ? {} : { TEST_RUNNER_USE_IP: ep.host }),
    };
    const r = await startRunner(d.spawn, { xctestrun: b.xctestrun, destination, env, now: () => d.now(), timeoutMs: opts.timeoutMs, udid, team: cfg.team, signal: opts.signal, apiKey: cfg.apiKey }, onProgress);
    try {
      const printed = parsePrinted(r.url);
      // FBWebServer prints the address it bound: proof the private binding took effect.
      if (!cfg.share && (!printed || !sameHost(printed.host, ep.host))) {
        throw new PhoneDockError('WebDriverAgent didn’t bind to the iPhone’s private address', 'wda_exposed', 502,
          ['PhoneDock stopped it. Set up control again; if it happens again, report it.'], `asked it to bind ${ep.host}; it printed ${r.url}`);
      }
      const port = printed?.port ?? WDA_PORT;
      const url = urlFor(ep.host, port);
      const out: Launched = { runner: r.runner, url, built: b.built };
      if (device) {
        const ip = (await d.getJson(`${url}/status`))?.value?.ios?.ip;
        const wifi = typeof ip === 'string' && ip && !sameHost(ip, ep.host) ? ip : undefined;
        if (!cfg.share) {
          if (!wifi) out.lanCheck = 'none';
          else {
            const [http, mjpeg] = await Promise.all([d.probe(wifi, port), d.probe(wifi, MJPEG_PORT)]);
            if (http === 'open' || mjpeg === 'open') {
              throw new PhoneDockError('WebDriverAgent answered on the iPhone’s Wi-Fi address', 'wda_exposed', 502,
                ['PhoneDock stopped it, so nobody on this network can control the iPhone. Set up control again; if it happens again, report it.'],
                `${http === 'open' ? port : MJPEG_PORT} answered at the iPhone’s Wi-Fi address`);
            }
            out.lanCheck = http === 'refused' && mjpeg === 'refused' ? 'refused' : 'unverified';
          }
        } else {
          out.sharedUrl = ep.lanName ? urlFor(ep.lanName, port) : wifi ? urlFor(wifi, port) : undefined;
        }
      }
      onProgress(cfg.share
        ? `WebDriverAgent is running; other Macs on this Wi-Fi can reach it${out.sharedUrl ? ` at ${out.sharedUrl}` : ''}`
        : 'WebDriverAgent is running, reachable only from this Mac');
      return out;
    } catch (e) { await stopRunner(r.runner); throw e; }
  };
  try { return await start(); }
  catch (e) {
    if (!(e instanceof PhoneDockError) || b.built) throw e;
    const stale = e.code === 'signing_expired'
      || (e.code === 'signature_invalid' && (b.builtAt === undefined || d.now() - b.builtAt > FRESH_BUILD_MS));
    if (!stale) throw e;
    b = await ensureBuild(d, udid, cfg, onProgress, { force: e.code === 'signing_expired' ? 'its signing expired' : 'the iPhone refused its signature', signal: opts.signal });
    return { ...(await start()), built: true };
  }
}

// ── one PhoneDock per phone on this Mac ────────────────────────────────────

export type ClaimResult = { ok: true } | { ok: false; pid: number };

/** Host-wide: which PhoneDock process runs WebDriverAgent for a phone (two daemons, even with different state
 *  directories, would fight over the phone). A claim file per phone holds the owner's pid and its xcodebuild's; a
 *  dead owner's claim is taken over after its orphaned xcodebuild (if still alive) is stopped. */
export class HostClaims {
  private readonly dir: string;
  private readonly pid: number;
  private readonly alive: (pid: number) => boolean;
  private readonly stopOrphan: (pid: number) => void;

  constructor(dir: string, o: { pid?: number; alive?: (pid: number) => boolean; stopOrphan?: (pid: number) => void } = {}) {
    this.dir = dir;
    this.pid = o.pid ?? process.pid;
    this.alive = o.alive ?? pidAlive;
    this.stopOrphan = o.stopOrphan ?? (() => undefined);
  }

  private file(udid: string): string { return join(this.dir, `${udid.replace(/[^A-Za-z0-9-]/g, '_')}.json`); }
  private read(udid: string): { pid?: number; child?: number } | undefined {
    try { return JSON.parse(readFileSync(this.file(udid), 'utf8')); } catch { return undefined; }
  }

  acquire(udid: string): ClaimResult {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    for (let i = 0; i < 3; i++) {
      try { writeFileSync(this.file(udid), JSON.stringify({ pid: this.pid, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }); return { ok: true }; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      const rec = this.read(udid);
      if (rec?.pid === this.pid) return { ok: true };
      if (rec?.pid && this.alive(rec.pid)) return { ok: false, pid: rec.pid };
      if (rec?.child && this.alive(rec.child)) this.stopOrphan(rec.child);
      rmSync(this.file(udid), { force: true });
    }
    return { ok: false, pid: -1 };
  }

  /** Record (or clear) the xcodebuild that runs WebDriverAgent, so a successor can stop it if this process dies. */
  setChild(udid: string, child?: number): void {
    const rec = this.read(udid);
    if (rec?.pid !== this.pid) return;
    writeFileSync(this.file(udid), JSON.stringify({ ...rec, child }), { mode: 0o600 });
  }

  release(udid: string): void {
    if (this.read(udid)?.pid === this.pid) rmSync(this.file(udid), { force: true });
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
  /** Sharing on: what another Mac passes to `phonedock connect --ios`. */
  sharedUrl?: string;
  /** Sharing off: what the check of the phone's Wi-Fi address after launch found. */
  lanCheck?: 'refused' | 'unverified' | 'none';
}

export interface SupervisorDeps {
  now(): number;
  /** udids PhoneDock manages WebDriverAgent for (ios-device.json). */
  managed(): string[];
  saveUrl(udid: string, url: string): void;
  /** GET /status answered (fresh, short timeout). */
  status(url: string): Promise<boolean>;
  phone(udid: string): Promise<PhoneFacts>;
  /** Build if needed, then start the runner (resolves once it is verified). `beforeStart` runs after the build, before
   *  the new runner starts; `signal` aborts the build or the launch (Stop, Disconnect, daemon exit). */
  launch(udid: string, onProgress: (l: string) => void, ctl: { signal: AbortSignal; beforeStart: () => Promise<void> }): Promise<Omit<Launched, 'built'>>;
  /** End WebDriverAgent's runner process on the phone and confirm it's gone (a runner can outlive its xcodebuild).
   *  Resolves with how many are left. */
  stopOnPhone(udid: string): Promise<number>;
  /** One PhoneDock process per phone on this Mac (HostClaims). */
  claims?: Pick<HostClaims, 'acquire' | 'setChild' | 'release'>;
  /** The person turned sharing on for this phone. */
  shared?(udid: string): boolean;
  log(msg: string): void;
  changed?(udid: string): void;
}

export interface SuperviseOptions {
  tickMs: number;
  /** /status may be quiet this long before the runner counts as stuck (and, at launch, before Local Network is blamed). */
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
  /** How long stopping waits for xcodebuild and the phone (daemon exit, Stop, Disconnect). */
  stopWaitMs: number;
  /** Run tick() on a timer once started (tests drive tick() themselves). */
  autoTick: boolean;
}
export const SUPERVISE_DEFAULTS: SuperviseOptions = {
  tickMs: 15_000, graceMs: 45_000, backoffMs: [5_000, 15_000, 60_000, 300_000, 900_000], maxAttempts: 6, personPollMs: 30_000,
  personBackoffMs: [30_000, 60_000, 300_000, 900_000], maxPersonAttempts: 8, minUptimeMs: 60_000, stopWaitMs: 20_000, autoTick: true,
};

interface Entry {
  state: WdaState; message: string; hint?: string;
  url?: string; runner?: Runner;
  /** the tunnel address the runner is bound to */
  boundHost?: string;
  sharedUrl?: string;
  lanCheck?: WdaControl['lanCheck'];
  attempts: number;
  personAttempts: number;
  nextAt?: number;
  /** last time /status answered */
  okAt?: number;
  /** /status answered at least once since this runner started */
  answered: boolean;
  /** devicectl reported the phone locked while waiting (so "unlocked" now means something) */
  sawLocked: boolean;
  /** gave up on something only a person can change (an account, a team, Apple's quota): no restart on reconnect */
  needsPerson?: boolean;
  /** a runner was started on the phone at some point (so stopping must look there) */
  launched?: boolean;
  claimed?: boolean;
  reachable?: boolean;
  inflight?: Promise<void>;
  /** aborted by Stop, Disconnect and daemon exit: a build or launch in flight stops */
  abort: AbortController;
  gone?: boolean;
  updatedAt: number;
}

/** Waits for the person that only a launch revealed: retried with backoff. */
const PERSON_CODES = new Set(['device_locked', 'no_device', 'not_found', 'not_paired', 'developer_mode_off']);
/** Failures only a person can fix (an account, a team, Apple's quota, the binding): no automatic retry at all. */
const AUTHORITY_CODES = new Set(['xcode_account_missing', 'bundle_id_unavailable', 'device_not_registered', 'team_unknown', 'team_required',
  'xcode_missing', 'ios_unsupported', 'signing_limit', 'wda_exposed', 'exec_failed']);

export class WdaSupervisor {
  private readonly deps: SupervisorDeps;
  private readonly o: SuperviseOptions;
  private readonly entries = new Map<string, Entry>();
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
      ...(e.url ? { wdaUrl: e.url } : {}), attempts: e.attempts,
      ...(e.nextAt && e.state === 'retrying' ? { nextRetryAt: new Date(e.nextAt).toISOString() } : {}),
      updatedAt: new Date(e.updatedAt).toISOString(),
      shared, ...(shared && e.sharedUrl ? { sharedUrl: e.sharedUrl } : {}),
      ...(!shared && e.lanCheck && e.runner ? { lanCheck: e.lanCheck } : {}),
    };
  }

  /** Daemon start: start WebDriverAgent on each managed phone (ending any runner left on it), then watch them. */
  start(): void {
    if (this.started || this.closing) return;
    this.started = true;
    for (const udid of this.deps.managed()) void this.ensure(udid, 'PhoneDock started');
    if (this.o.autoTick && !this.timer) { this.timer = setInterval(() => { void this.tick(); }, this.o.tickMs); this.timer.unref(); }
  }

  /** Daemon exit: cancel builds and launches (including setups waiting their turn), stop every runner this process
   *  started, on the Mac and on the phone, and wait for that (bounded). The next daemon starts them again. */
  async stop(): Promise<void> {
    this.closing = true;
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const all = [...this.entries];
    this.entries.clear();
    await this.bounded(Promise.all(all.map(([udid, e]) => this.teardown(udid, e, false))), this.o.stopWaitMs * 2);
  }

  /** The phones devicectl lists right now. A managed phone that comes back (USB or Wi-Fi) gets a start; one that
   *  was given up on gets a fresh count, unless only a person can fix why. A changed tunnel address relaunches (the
   *  runner listens on the old one). A flap while running changes nothing: the tick watches /status. */
  observe(phones: { udid: string; reachable: boolean; tunnelIp?: string }[]): void {
    if (!this.started) return;
    const seen = new Map(phones.map((p) => [p.udid, p]));
    for (const udid of this.deps.managed()) {
      const e = this.entry(udid);
      const p = seen.get(udid);
      const now = p?.reachable ?? false;
      const was = e.reachable;
      e.reachable = now;
      if (!now || e.inflight) continue;
      if (e.state === 'running' && e.runner && e.boundHost && p?.tunnelIp && !sameHost(p.tunnelIp, e.boundHost)) {
        void this.ensure(udid, 'the iPhone’s developer connection changed');
        continue;
      }
      const back = was === false ? ['waiting_phone', 'waiting_trust', 'failed', 'retrying'].includes(e.state) : was === undefined && e.state === 'waiting_phone';
      if (!back || (e.state === 'failed' && e.needsPerson)) continue;
      if (e.state === 'failed') { e.attempts = 0; e.personAttempts = 0; }
      void this.ensure(udid, 'the iPhone reconnected');
    }
  }

  /** Set up (or redo) WebDriverAgent now, for a person or agent who asked. Waits for a launch already under way
   *  (one launcher per phone), builds, and only then replaces the running WebDriverAgent, so a setup that fails to
   *  build leaves a working one alone. Rejects with the reason. */
  async setup(udid: string, onProgress: (l: string) => void): Promise<{ url: string; pid?: number }> {
    const stillWanted = () => !this.closing && this.deps.managed().includes(udid);
    if (!stillWanted()) throw cancelledError();
    let e = this.entry(udid);
    while (e.inflight) {
      await e.inflight.catch(() => undefined);
      // Stop, Disconnect or daemon exit while this setup waited its turn: it doesn't start anything.
      if (!stillWanted()) throw cancelledError();
      e = this.entry(udid);
    }
    const c = this.claim(udid, e);
    if (!c.ok) {
      throw new PhoneDockError('Another PhoneDock service on this Mac runs WebDriverAgent for this iPhone', 'busy', 409,
        ['Stop control in that PhoneDock, or set it up from there.'], `owned by process ${c.pid}`);
    }
    e.attempts = 0; e.personAttempts = 0; e.needsPerson = false;
    let failure: unknown;
    const run = (async () => {
      this.set(e, 'starting', 'Setting up WebDriverAgent…');
      try { await this.launchNow(udid, e, onProgress); }
      catch (err) {
        failure = err;
        if (e.runner?.alive()) this.set(e, 'running', 'WebDriverAgent is running');   // the old one still serves
        else this.failed(udid, e, err, true);
      }
    })();
    const tracked: Promise<void> = run.finally(() => { if (e.inflight === tracked) e.inflight = undefined; this.deps.changed?.(udid); });
    e.inflight = tracked;
    await tracked;
    if (failure) throw failure;
    if (e.gone || !e.url) throw cancelledError();
    return { url: e.url, ...(e.runner?.pid ? { pid: e.runner.pid } : {}) };
  }

  /** Try again now with a fresh count (setup failed and the previous configuration was put back). */
  resume(udid: string, why: string): void {
    if (!this.started || !this.deps.managed().includes(udid)) return;
    const e = this.entry(udid);
    e.attempts = 0; e.personAttempts = 0; e.needsPerson = false;
    if (!e.inflight && e.state !== 'running') void this.ensure(udid, why);
  }

  /** Stop managing a phone (Stop Control, Disconnect): cancel a build or launch in flight, stop the runner on the Mac
   *  and on the phone, and forget the state. Resolves once that's done (bounded). */
  unmanage(udid: string): Promise<void> {
    const e = this.entries.get(udid);
    if (e) { this.entries.delete(udid); this.deps.changed?.(udid); }
    return this.teardown(udid, e, true);
  }

  private async teardown(udid: string, e: Entry | undefined, always: boolean): Promise<void> {
    if (e) {
      e.gone = true;
      e.abort.abort();
      const r = e.runner;
      e.runner = undefined;
      // A build or launch in flight stops at once (aborted); wait for it, so nothing it started outlives this.
      await this.bounded(Promise.all([r ? stopRunner(r, this.o.stopWaitMs) : undefined, e.inflight?.catch(() => undefined)]), this.o.stopWaitMs);
    }
    // The runner app can outlive xcodebuild on the phone: end it there too. A person's Stop always looks (an older
    // service may have left one); daemon exit only where this process started one.
    if (always || e?.launched) {
      const left = await this.bounded(this.deps.stopOnPhone(udid).catch(() => -1), this.o.stopWaitMs);
      if (left !== 0) this.deps.log(`wda ${udid}: couldn’t confirm WebDriverAgent stopped on the iPhone (${left ?? 'timed out'})`);
    }
    if (e?.claimed || always) this.deps.claims?.release(udid);
  }

  private async bounded<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
    let t: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((res) => { t = setTimeout(() => res(undefined), ms); t.unref?.(); });
    try { return await Promise.race([p, timeout]); } finally { if (t) clearTimeout(t); }
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
      if (e.inflight || e.gone) return;
      const now = this.deps.now();
      switch (e.state) {
        case 'running':
        case 'unreachable': {
          const ok = e.url ? await this.deps.status(e.url).catch(() => false) : false;
          if (e.gone || e.inflight) return;
          const t = this.deps.now();
          if (ok) {
            e.okAt = t; e.answered = true;
            // Forgive earlier failures only once this runner has stayed up a while: one that answers and then dies
            // keeps counting toward giving up.
            const up = e.runner ? t - (e.runner.readyAt ?? e.runner.startedAt) : 0;
            if (up >= this.o.minUptimeMs) { e.attempts = 0; e.personAttempts = 0; }
            if (e.state !== 'running') this.set(e, 'running', 'WebDriverAgent is running');
            return;
          }
          if (e.runner && !e.runner.alive()) return;    // its exit handler takes over
          const since = e.okAt ?? e.runner?.readyAt ?? e.runner?.startedAt ?? 0;
          if (t - since < this.o.graceMs) return;
          if (e.runner && !e.answered) {
            // It started on the phone but this Mac never reached it: the developer connection or this Mac's network.
            // Relaunching would kill a working runner, so wait for /status instead.
            if (e.state !== 'unreachable') {
              this.set(e, 'unreachable', `WebDriverAgent started, but PhoneDock can’t reach it at ${e.url}`,
                `Keep the iPhone connected (USB, or awake on the same Wi-Fi). ${LOCAL_NETWORK_HINT}`);
            }
            return;
          }
          // It answered before and is quiet now (hung, or its tunnel went away): replace it, and count it.
          e.attempts++;
          if (e.attempts >= this.o.maxAttempts) {
            const r = e.runner; e.runner = undefined;
            if (r) r.kill();
            this.giveUp(e, 'WebDriverAgent keeps hanging');
            this.cleanUpPhone(udid, e);
            this.deps.changed?.(udid);
            return;
          }
          void this.ensure(udid, 'WebDriverAgent stopped answering');
          return;
        }
        case 'waiting_unlock': {
          const f = await this.deps.phone(udid).catch(() => undefined);
          if (e.gone || e.inflight) return;
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
      e = { state: 'starting', message: 'Starting WebDriverAgent…', attempts: 0, personAttempts: 0, answered: false, sawLocked: false, abort: new AbortController(), updatedAt: this.deps.now() };
      this.entries.set(udid, e);
    }
    return e;
  }

  private claim(udid: string, e: Entry): ClaimResult {
    if (e.claimed) return { ok: true };
    const r = this.deps.claims?.acquire(udid) ?? { ok: true };
    if (r.ok) e.claimed = true;
    return r;
  }

  private set(e: Entry, state: WdaState, message: string, hint?: string, nextAt?: number): void {
    e.state = state; e.message = message; e.hint = hint; e.nextAt = nextAt; e.updatedAt = this.deps.now();
  }

  /** One attempt at a time per phone; callers share it. */
  private ensure(udid: string, why: string): Promise<void> {
    if (!this.started) return Promise.resolve();
    const e = this.entry(udid);
    if (e.inflight) return e.inflight;
    const p = this.attempt(udid, e, why).catch((err) => { this.deps.log(`wda ${udid}: ${(err as Error).message}`); });
    const tracked: Promise<void> = p.finally(() => { if (e.inflight === tracked) e.inflight = undefined; this.deps.changed?.(udid); });
    e.inflight = tracked;
    return tracked;
  }

  private async attempt(udid: string, e: Entry, why: string): Promise<void> {
    // Waits devicectl can see cost no launch: look again at the waiting pace.
    const f = await this.deps.phone(udid).catch(() => undefined);
    if (e.gone) return;
    const person = this.personWait(f);
    if (person) {
      if (person.state === 'waiting_unlock') e.sawLocked = true;
      this.set(e, person.state, person.message, person.hint, this.deps.now() + this.o.personPollMs);
      return;
    }
    const c = this.claim(udid, e);
    if (!c.ok) {
      this.set(e, 'waiting_phone', 'Another PhoneDock service on this Mac runs WebDriverAgent for this iPhone',
        'Stop control there, or leave it to that service.', this.deps.now() + this.o.personPollMs);
      return;
    }
    this.set(e, 'starting', `Starting WebDriverAgent (${why})…`);
    this.deps.log(`wda ${udid}: starting (${why})`);
    try { await this.launchNow(udid, e, (l) => { if (!e.gone) { e.message = l; e.updatedAt = this.deps.now(); } }); }
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

  /** Build, then replace the current runner (if any) with a new one. The current runner keeps serving until the
   *  build is done; if the launch fails before replacing it, it stays. */
  private async launchNow(udid: string, e: Entry, onProgress: (l: string) => void): Promise<void> {
    // The current runner stays attached (Stop stops it) until the build is done.
    const old = e.runner;
    let started = false;
    let r: Omit<Launched, 'built'>;
    try {
      r = await this.deps.launch(udid, onProgress, {
        signal: e.abort.signal,
        beforeStart: async () => {
          started = true; e.launched = true;
          if (old && e.runner === old) e.runner = undefined;    // its exit is no longer a crash to handle
          if (old) await stopRunner(old, this.o.stopWaitMs);
          // A runner can outlive its xcodebuild on the phone, and one may be left from before this service started:
          // end every WebDriverAgent runner on the phone before starting this one.
          await this.deps.stopOnPhone(udid).catch(() => -1);
        },
      });
    } catch (err) {
      // A launch that got as far as starting leaves nothing behind on the phone either.
      if (started) await this.deps.stopOnPhone(udid).catch(() => -1);
      throw err;
    }
    if (e.gone) { await stopRunner(r.runner, this.o.stopWaitMs); return; }
    e.runner = r.runner; e.url = r.url; e.boundHost = hostOf(r.url); e.sharedUrl = r.sharedUrl; e.lanCheck = r.lanCheck;
    e.answered = false; e.okAt = undefined; e.sawLocked = false;
    this.deps.claims?.setChild(udid, r.runner.pid);
    this.deps.saveUrl(udid, r.url);
    this.set(e, 'running', 'WebDriverAgent is running');
    this.deps.log(`wda ${udid}: running at ${r.url} (xcodebuild pid ${r.runner.pid ?? '?'}${r.lanCheck ? `, Wi-Fi address ${r.lanCheck}` : ''}${r.sharedUrl ? `, shared at ${r.sharedUrl}` : ''})`);
    const runner = r.runner;
    void runner.exited.then(() => this.onExit(udid, e, runner));
  }

  /** The runner's xcodebuild ended without anyone asking. Every such exit counts toward giving up, also one that
   *  happens while its own launch is still settling (a runner that dies right after printing its address). */
  private onExit(udid: string, e: Entry, runner: Runner): void {
    if (e.gone || e.runner !== runner || this.entries.get(udid) !== e) return;
    e.runner = undefined; e.answered = false;
    this.deps.claims?.setChild(udid, undefined);
    const up = this.deps.now() - (runner.readyAt ?? runner.startedAt);
    e.attempts++;
    this.deps.log(`wda ${udid}: WebDriverAgent stopped after ${Math.round(up / 1000)} s (${e.attempts}/${this.o.maxAttempts})`);
    if (e.attempts >= this.o.maxAttempts) {
      this.giveUp(e, up < this.o.minUptimeMs ? 'WebDriverAgent keeps stopping right after it starts' : 'WebDriverAgent keeps stopping');
    } else {
      this.set(e, 'retrying', 'WebDriverAgent stopped; PhoneDock is restarting it', undefined, this.deps.now() + this.backoff(e.attempts));
    }
    this.cleanUpPhone(udid, e);
    this.deps.changed?.(udid);
  }

  /** Its xcodebuild is gone, but the runner may live on on the phone: end it there, before anything starts again
   *  (queued behind whatever is in flight, and skipped if a new runner took its place). */
  private cleanUpPhone(udid: string, e: Entry): void {
    const prev = e.inflight ?? Promise.resolve();
    const p = prev.catch(() => undefined).then(async () => { if (!e.gone && !e.runner) await this.deps.stopOnPhone(udid).catch(() => -1); });
    const tracked: Promise<void> = p.finally(() => { if (e.inflight === tracked) e.inflight = undefined; });
    e.inflight = tracked;
  }

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
      // Retrying can't help (and would ask Apple again): wait for the person to change something and set up again.
      e.needsPerson = true;
      this.giveUp(e, pe.message, hint);
      return;
    }
    if (manual) { this.giveUp(e, pe.message, hint); return; }
    e.attempts++;
    if (e.attempts >= this.o.maxAttempts) { this.giveUp(e, pe.message, hint); return; }
    this.set(e, 'retrying', `${pe.message}; PhoneDock tries again`, hint, this.deps.now() + this.backoff(e.attempts));
  }

  private giveUp(e: Entry, why: string, hint?: string): void {
    this.set(e, 'failed', `Couldn’t start WebDriverAgent: ${why}`, hint ?? 'Set Up Control again in PhoneDock, or run `phonedock ios wda-setup`.');
  }

  private backoff(attempts: number): number {
    return this.o.backoffMs[Math.min(Math.max(attempts, 1) - 1, this.o.backoffMs.length - 1)];
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
export interface WdaSetupResult { udid: string; wdaUrl: string; pid?: number; team: string; managed: true; shared: boolean; sharedUrl?: string }

export interface SetupDeps {
  xcode(): Promise<XcodeInfo | undefined>;
  teams(): Promise<XcodeTeam[]>;
  /** devicectl's facts for a phone found by its UDID or its CoreDevice identifier; `udid` is the hardware UDID. */
  phone(id: string): Promise<PhoneFacts & { udid?: string }>;
  developerMode(udid: string): Promise<boolean | null | undefined>;
  exists(path: string): boolean;
  /** Stop Control and Disconnect mark a phone; a setup that began before the mark changes nothing and starts nothing. */
  marks: { now(): number; since(udid: string, t: number): boolean };
  store: { get(udid: string): SetupEntry | undefined; set(udid: string, entry: SetupEntry | undefined): void };
  sup: Pick<WdaSupervisor, 'setup' | 'info' | 'unmanage' | 'resume'>;
  /** udids being set up now (one setup per phone). */
  running: Set<string>;
  changed(): void;
}

/** `-destination` names this device ("id=<udid>", alone or among other keys). */
export function destinationNames(dest: string, id: string): boolean {
  return dest.split(',').some((kv) => { const [k, v] = kv.split('='); return k.trim() === 'id' && (v ?? '').trim().toLowerCase() === id.toLowerCase(); });
}

/** One-step setup: preflight with plain errors, pick the team, build the pinned WebDriverAgent if needed, start it,
 *  and from then on keep it running. Nothing is written before preflight passes; Stop or Disconnect during setup wins;
 *  a failure puts the phone's whole entry back as it was. */
export async function setupPhone(d: SetupDeps, id: string, req: SetupRequest, progress: (l: string) => void): Promise<WdaSetupResult> {
  const t0 = d.marks.now();
  let last = '';
  const onProgress = (l: string) => { if (l !== last) { last = l; progress(l); } };
  const sim = !!req.destination && !isDeviceDestination(req.destination);
  const stoppedMeanwhile = (...ids: string[]) => ids.some((u) => d.marks.since(u, t0));
  onProgress('Checking Xcode and the iPhone…');
  const [xcode, teams, facts] = await Promise.all([
    d.xcode(), sim ? Promise.resolve([] as XcodeTeam[]) : d.teams(),
    sim ? Promise.resolve(undefined) : d.phone(id).catch((): PhoneFacts & { udid?: string } => ({ found: false })),
  ]);
  const udid = facts?.udid ?? id;
  if (stoppedMeanwhile(id, udid)) throw cancelledError();
  // One phone, one name: the CoreDevice identifier and the UDID are the same iPhone, and the destination must be it.
  if (req.destination && !destinationNames(req.destination, id) && !destinationNames(req.destination, udid)) {
    throw new PhoneDockError('The destination names a different device', 'bad_request', 400, ['Pass `id=<the same udid>` (or leave destination out).'], `destination ${req.destination}, udid ${udid}`);
  }
  if (d.running.has(udid) && udid !== id) throw new PhoneDockError('This iPhone is already being set up', 'busy', 409, ['Wait for that setup to finish.']);
  d.running.add(udid);
  try {
    if (!sim) {
      const f = facts!;
      if (f.found && f.developerMode == null) {
        f.developerMode = (await d.developerMode(udid).catch(() => null)) ?? null;
        if (stoppedMeanwhile(id, udid)) throw cancelledError();
      }
      const err = preflight(xcode, f, udid);
      if (err) throw err;
    } else if (!xcode) throw preflight(undefined, undefined, udid)!;

    const cur = d.store.get(udid);
    const prior = cur?.wda ?? cur?.wdaStopped;
    // Nothing asked for: reuse this phone's last setup (running, or stopped with Stop Control), and so its build.
    const reuse = req.team === undefined && !req.apiKey ? prior : undefined;
    const reuseKey = reuse?.apiKey && d.exists(reuse.apiKey.path) ? reuse.apiKey : undefined;
    const apiKey = req.apiKey ?? reuseKey;
    const team = sim ? { id: UNSIGNED_TEAM, free: false }
      : chooseTeam(teams, { team: req.team ?? (reuseKey ? reuse?.team : undefined), apiKey, udid, remembered: reuse?.team });
    if (!sim) onProgress(`Signing with team ${team.id}${team.free ? ' (a personal team: its signing lasts 7 days, and PhoneDock renews it)' : ''}`);
    const share = req.share ?? prior?.share ?? false;
    let cfg: WdaConfig = {
      team: team.id, free: team.free,
      // A team that fell back to its own runner id before keeps it.
      bundleId: sim ? UPSTREAM_RUNNER_BUNDLE_ID : prior?.team === team.id && prior.bundleId ? prior.bundleId : runnerBundleId(team.id, team.free),
      ...(apiKey ? { apiKey } : {}), ...(req.destination ? { destination: req.destination } : {}), ...(share ? { share: true } : {}),
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
        if (!(e instanceof PhoneDockError) || e.code !== 'bundle_id_unavailable' || cfg.bundleId !== UPSTREAM_RUNNER_BUNDLE_ID || sim) throw e;
        cfg = { ...cfg, bundleId: teamScopedBundleId(cfg.team) };
        onProgress(`Team ${cfg.team} can’t sign WebDriverAgent’s usual app ID; trying its own (${cfg.bundleId})…`);
        commit(cfg);
        r = await d.sup.setup(udid, onProgress);
      }
      const done = d.store.get(udid);
      if (done?.wda && done.wdaStopped) { const next = { ...done }; delete next.wdaStopped; d.store.set(udid, next); }
      d.changed();
      const info = d.sup.info(udid);
      return {
        udid, wdaUrl: r.url, ...(r.pid ? { pid: r.pid } : {}), team: cfg.team, managed: true,
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
        // setup and its WebDriverAgent, or stop managing the phone.
        d.store.set(udid, snapshot);
        if (snapshot?.wda) d.sup.resume(udid, 'setup failed; back to the previous setup');
        else await d.sup.unmanage(udid);
      }
      d.changed();
      throw e;
    }
  } finally { d.running.delete(udid); }
}
