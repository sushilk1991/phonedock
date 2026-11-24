// WebDriverAgent for iPhones on iOS 26 and older (iOS 27+ is controlled natively: ios-hid.ts, ios-native.ts).
//
// Set Up Control builds the pinned appium/WebDriverAgent source (component 'wda') once per WebDriverAgent version,
// signing team and Xcode build with `xcodebuild build-for-testing`, then starts it on the phone with
// `xcodebuild test-without-building`, bound to the phone's end of this Mac's CoreDevice tunnel (TEST_RUNNER_USE_IP), and
// checks that it is private before it reports success. Stop Control ends every runner on the phone.
//
// PhoneDock remembers only the team (ios-device.json `wdaTeam`) and the build (<state>/wda-builds). Every launch is
// an explicit act: nothing relaunches in the background, and what runs is read from the phone each time. A runner that
// was on the phone before a setup is never ended by it: one that is private here is used, anything else is refused.
//
// Everything that touches the system arrives through injected functions (WdaDeps), so this file is unit-tested with
// fakes (ios-wda.test.ts); ios-device.ts wires in devicectl, the component manager and real processes.
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunOptions } from '../core/exec.ts';
import { PhoneDockError, type ExecResult } from '../core/types.ts'


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

/** build-for-testing, signed for the phone. Registering the phone with the team needs both provisioning flags;
 *  the two build settings at the end are what appium passes too (survive Xcode's new warnings, skip indexing). */
export function buildArgv(p: BuildPlan): string[] {
  return [
    'build-for-testing',
    '-project', p.project, '-scheme', 'WebDriverAgentRunner',
    '-destination', p.destination, '-derivedDataPath', p.derivedData,
    '-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration',
    ...(p.apiKey ? ['-authenticationKeyPath', p.apiKey.path, '-authenticationKeyID', p.apiKey.keyId, '-authenticationKeyIssuerID', p.apiKey.issuerId] : []),
    `DEVELOPMENT_TEAM=${p.team}`, 'CODE_SIGN_STYLE=Automatic',
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
 *  same version still gets a fresh copy. Sharing is not in the key: a shared launch uses the same build. */
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
      ['On the iPhone open Settings › General › VPN & Device Management, tap your Apple ID and tap Trust, then set up control again.'], tail);
  }
  if (/invalid code signature|inadequate entitlements|has not been explicitly trusted/i.test(text)) {
    return new PhoneDockError('The iPhone refused WebDriverAgent’s signature', 'signature_invalid', 409,
      ['If the iPhone asks you to trust the developer (Settings › General › VPN & Device Management), do that and retry. Otherwise set up control again: PhoneDock rebuilds it.'], tail);
  }
  if (/Unlock .* to Continue|device is locked|passcode protected|is passcode locked|device was locked|could not be,? unlocked/i.test(text)) {
    return new PhoneDockError('Unlock the iPhone', 'device_locked', 409, ['Unlock it and keep it unlocked, then set up control again.'], tail);
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
    // Given up (Stop Control, a time limit): the caller hears only once xcodebuild has exited, so nothing it started
    // outlives what the caller reports.
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

/** What a TCP connect found: something listens, the host said no, or nothing conclusive (unreachable, timed out,
 *  or macOS Local Network privacy stopped it). */
export type ProbeResult = 'open' | 'refused' | 'unknown';


/** Is a running WebDriverAgent reachable on the phone's Wi-Fi address? For the device list, so the person sees that a
 *  phone is shared after a restart or a CLI setup: at most one probe of <Wi-Fi>:8100 per phone a minute. It answers:
 *  shared; it refuses, or the phone reports no Wi-Fi address (JSON null): not shared; anything else (no answer, Local
 *  Network permission, a malformed /status): unknown, never "not shared". */
export interface Sharing { state: 'shared' | 'not_shared' | 'unknown'; url?: string }
export function sharingChecker(probe: (host: string, port: number) => Promise<ProbeResult>, now: () => number = Date.now, everyMs = 60_000) {
  const last = new Map<string, { at: number; p: Promise<Sharing> }>();
  return {
    check(key: string, status: unknown): Promise<Sharing> {
      const c = last.get(key);
      if (c && now() - c.at < everyMs) return c.p;
      const ip = (status as { ios?: { ip?: unknown } } | undefined)?.ios?.ip;
      const p: Promise<Sharing> = ip === null ? Promise.resolve({ state: 'not_shared' })
        : typeof ip !== 'string' || !isIP(ip) ? Promise.resolve({ state: 'unknown' })
        : probe(ip, WDA_PORT).then((r): Sharing => (r === 'open' ? { state: 'shared', url: urlFor(ip, WDA_PORT) } : { state: r === 'refused' ? 'not_shared' : 'unknown' }),
          (): Sharing => ({ state: 'unknown' }));
      last.set(key, { at: now(), p });
      return p;
    },
    /** After Set Up or Stop Control: the next list looks again. */
    forget(key: string): void { last.delete(key); },
  };
}

// ── build once, launch on request ─────────────────────────────────────────

/** What Set Up Control remembers for a phone (ios-device.json `wdaTeam`): the team and how it signs, so setting up
 *  again needs no questions and reuses the build. An API key is remembered by its path and IDs, never its contents. */
export interface WdaConfig { team: string; free: boolean; bundleId: string; apiKey?: WdaApiKey }

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
  writeFile(path: string, text: string): void;
  mkdir(path: string): void;
  remove(path: string): void;
}

const BUILD_KEEP_MS = 30 * DAY_MS;

/** One build at a time per build key: two phones on one team share it, and two xcodebuilds in one DerivedData fight
 *  over its build database. */
const buildTurns = new Map<string, Promise<unknown>>();
async function inTurn<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (buildTurns.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
  const settled = run.catch(() => undefined);
  buildTurns.set(key, settled);
  try { return await run; } finally { if (buildTurns.get(key) === settled) buildTurns.delete(key); }
}

/** The build for this team, WebDriverAgent version and Xcode build: made once (signed, registering the phone with the
 *  team on the way), reused after. `force` rebuilds (the phone refused the signature, or isn't in its profile yet). */
export async function ensureBuild(d: WdaBuildDeps, udid: string, cfg: WdaConfig, onProgress: (l: string) => void,
  opts: { force?: string; signal?: AbortSignal } = {}): Promise<{ xctestrun: string; built: boolean }> {
  const xcode = await d.xcode();
  if (!xcode) throw preflight(undefined, undefined, udid)!;
  // Getting the source is what main's `git clone` was: any failure keeps its code, exec_failed, with the cause.
  const src = await d.source(onProgress).catch((e: unknown) => {
    const pe = new PhoneDockError((e as Error)?.message ?? 'Couldn’t get WebDriverAgent', 'exec_failed', 500, (e as PhoneDockError)?.hints, (e as PhoneDockError)?.detail);
    pe.cause = e instanceof PhoneDockError && e.code !== 'exec_failed' ? e.code : 'download_failed';
    throw pe;
  });
  const destination = `id=${udid}`;
  const key = buildKey({ wdaVersion: src.version, artifact: src.key, platform: 'iphoneos', team: cfg.team, xcodeBuild: xcode.build, bundleId: cfg.bundleId });
  const dir = join(d.buildsDir, key);
  const derivedData = join(dir, 'DerivedData');
  return inTurn(key, async () => {
  // Looked at in turn: another phone's build may have just made what this one needs.
  let xctestrun = findXctestrun(derivedData);
  if (xctestrun && !opts.force) {
    d.writeFile(join(dir, '.last-used'), new Date(d.now()).toISOString() + '\n');
    return { xctestrun, built: false };
  }
  onProgress(`Building WebDriverAgent ${src.version} for team ${cfg.team}${opts.force ? ` (${opts.force})` : ''}. The first build takes a few minutes…`);
  d.mkdir(dir);
  const project = join(dir, 'src');
  // Build a private copy: xcodebuild may write next to the project, and the verified component stays as downloaded.
  if (!existsSync(join(project, 'WebDriverAgent.xcodeproj'))) {
    d.remove(project);
    await d.copyTree(src.path, project);
  }
  await runBuild(d.spawn, { project: join(project, 'WebDriverAgent.xcodeproj'), derivedData, destination, team: cfg.team, bundleId: cfg.bundleId, apiKey: cfg.apiKey },
    d.env, onProgress, { udid, signal: opts.signal });
  xctestrun = findXctestrun(derivedData);
  if (!xctestrun) throw new PhoneDockError('Couldn’t build WebDriverAgent', 'wda_setup_failed', 502, undefined, `xcodebuild build-for-testing wrote no .xctestrun under ${derivedData}`);
  const at = new Date(d.now()).toISOString();
  d.writeFile(join(dir, 'build.json'), JSON.stringify({ key, wdaVersion: src.version, artifact: src.key, team: cfg.team, bundleId: cfg.bundleId, xcode: xcode.build, builtAt: at }, null, 2) + '\n');
  d.writeFile(join(dir, '.last-used'), at + '\n');
  pruneBuilds(d, key);
  return { xctestrun, built: true };
  });
}

/** Builds nobody launched for 30 days (an old Xcode, an old WebDriverAgent pin, another team) are deleted. */
export function pruneBuilds(d: Pick<WdaBuildDeps, 'buildsDir' | 'now' | 'remove'>, keep: string): string[] {
  const removed: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(d.buildsDir); } catch { return removed; }
  for (const n of names) {
    if (n === keep || n.startsWith('.') || buildTurns.has(n)) continue;
    let used = NaN;
    try { used = Date.parse(readFileSync(join(d.buildsDir, n, '.last-used'), 'utf8').trim()); } catch { /* none */ }
    if (Number.isFinite(used) ? d.now() - used < BUILD_KEEP_MS : !existsSync(join(d.buildsDir, n, 'build.json'))) continue;   // recent, or not ours
    d.remove(join(d.buildsDir, n)); removed.push(n);
  }
  return removed;
}

// ── is it private? ─────────────────────────────────────────────────────────

/** What a WebDriverAgent on the phone looks like from this Mac: `private` (it answers on this Mac's tunnel address and
 *  its Wi-Fi address, when it reports one, refuses both ports), `shared` (it answers on the Wi-Fi address too), or
 *  `unknown` (anything else, e.g. it doesn't answer here, or the Wi-Fi check is inconclusive). */
export interface Reach { kind: 'private' | 'shared' | 'unknown'; why: string; wifi?: string | null; sharedUrl?: string }

export interface ReachDeps {
  getJson(url: string): Promise<any>;
  probe(host: string, port: number): Promise<ProbeResult>;
}

/** Fail closed: private needs positive evidence. The pinned WebDriverAgent reports `ios.ip`, its Wi-Fi address, or
 *  JSON null when it has none; anything else (missing, another type, not an address) proves nothing. */
export async function checkReach(d: ReachDeps, tunnel: string, port = WDA_PORT): Promise<Reach> {
  const url = urlFor(tunnel, port);
  const status = await d.getJson(`${url}/status`);
  if (!status?.value) return { kind: 'unknown', why: `WebDriverAgent doesn’t answer at ${url}` };
  const ios = status.value.ios;
  if (!ios || typeof ios !== 'object' || !('ip' in ios)) return { kind: 'unknown', why: 'WebDriverAgent’s /status doesn’t say whether the iPhone has a Wi-Fi address' };
  if (ios.ip !== null && (typeof ios.ip !== 'string' || !isIP(canonHost(ios.ip)))) return { kind: 'unknown', why: `WebDriverAgent reports a Wi-Fi address that isn’t one (${JSON.stringify(ios.ip).slice(0, 60)})` };
  const wifi: string | null = ios.ip !== null && !sameHost(ios.ip, tunnel) ? ios.ip : null;
  if (!wifi) return { kind: 'private', why: 'the iPhone reports no Wi-Fi address', wifi: null };
  const [http, mjpeg] = await Promise.all([d.probe(wifi, port), d.probe(wifi, MJPEG_PORT)]);
  if (http === 'open') return { kind: 'shared', why: `it answers at the iPhone’s Wi-Fi address`, wifi, sharedUrl: urlFor(wifi, port) };
  if (mjpeg === 'open') return { kind: 'unknown', why: `its screen stream (${MJPEG_PORT}) answers at the iPhone’s Wi-Fi address`, wifi };
  if (http === 'refused' && mjpeg === 'refused') return { kind: 'private', why: 'the iPhone’s Wi-Fi address refuses it', wifi };
  return { kind: 'unknown', why: 'the iPhone’s Wi-Fi address neither answered nor refused (allow PhoneDock under Privacy & Security › Local Network)', wifi };
}

// ── Set Up Control and Stop Control ────────────────────────────────────────

export interface SetupRequest { team?: string; apiKey?: WdaApiKey; share?: boolean }
/** `wdaUrl`: this Mac's address for it (the phone's tunnel address); `reused`: it was already running, private, and
 *  nothing was started. */
export interface WdaSetupResult { udid: string; wdaUrl: string; pid?: number; team: string; shared: boolean; sharedUrl?: string; reused: boolean }

export interface WdaDeps extends WdaBuildDeps, ReachDeps {
  teams(): Promise<XcodeTeam[]>;
  phone(udid: string): Promise<PhoneFacts>;
  /** The phone's end of this Mac's CoreDevice tunnel (devicectl), bringing it up when devicectl can. */
  tunnel(udid: string): Promise<string>;
  /** The WebDriverAgent runner pids on the phone (devicectl); rejects when devicectl can't say. */
  runners(udid: string): Promise<number[]>;
  /** End these runners on the phone (all of them without `pids`) and confirm: resolves with how many are left. */
  endRunners(udid: string, pids?: number[]): Promise<number>;
  saved(udid: string): WdaConfig | undefined;
  save(udid: string, cfg: WdaConfig): void;
}

/** Codes a wda-setup job failed with before 0.7.0 stay; every other failure keeps the catch-all `wda_setup_failed`
 *  and names the specific one in `cause`. Getting the source was a `git clone` (`exec_failed`): a failed download
 *  keeps that code. */
const SETUP_KEEPS = new Set(['bad_request', 'exec_failed', 'wda_setup_failed']);
export function asSetupError(e: unknown): unknown {
  if (!(e instanceof PhoneDockError) || SETUP_KEEPS.has(e.code)) return e;
  const out = new PhoneDockError(e.message, 'wda_setup_failed', e.status, e.hints, e.detail);
  out.cause = e.code;
  return out;
}

/** A WebDriverAgent already on the phone isn't what was asked for: setup leaves it alone. */
function runningError(udid: string, r: Reach, share: boolean): PhoneDockError {
  const what = share ? 'PhoneDock only shares a WebDriverAgent it starts' : r.kind === 'shared' ? 'is shared on the Wi-Fi' : 'can’t be confirmed private';
  return new PhoneDockError(`WebDriverAgent is already running on this iPhone${share ? ': ' : ' and '}${what}`, 'wda_running', 409,
    [`PhoneDock leaves it running. Stop Control ends it (\`phonedock ios wda-stop --udid ${udid}\`), then Set Up Control${share ? ' with sharing' : ''} starts PhoneDock’s.`], r.why);
}

/** Set Up Control: preflight with plain errors, pick the team, then use the WebDriverAgent already running if it is
 *  what was asked (private here, or shared), refuse if one runs that isn't (leaving it alone), or build once and launch
 *  one bound to the tunnel (every address with `share`) and check it. A launch that fails its check is ended,
 *  xcodebuild and its runner on the phone. Only runners started by this setup are ever ended. */
export async function setupPhone(d: WdaDeps, udid: string, req: SetupRequest, onProgress: (l: string) => void,
  ctl: SetupControl = {}): Promise<WdaSetupResult> {
  try { return await setupSteps(d, udid, req, onProgress, ctl); } catch (e) { throw asSetupError(e); }
}

/** `signal`: Stop Control during setup (a build or launch in flight stops); `onRunner`: the runner this setup started,
 *  as soon as it printed its address (Stop Control ends it); `onStep`: where the time went. */
export interface SetupControl { signal?: AbortSignal; onRunner?: (r: Runner) => void; onStep?: (step: string, ms: number) => void }

async function setupSteps(d: WdaDeps, udid: string, req: SetupRequest, onProgress: (l: string) => void, ctl: SetupControl): Promise<WdaSetupResult> {
  const timed = async <T>(step: string, p: Promise<T>): Promise<T> => { const t = d.now(); try { return await p; } finally { ctl.onStep?.(step, d.now() - t); } };
  const share = !!req.share;
  onProgress('Checking Xcode and the iPhone…');
  // What runs on the phone is listed while the rest is checked: it decides whether anything is launched.
  const listing = timed('listing runners on the iPhone', d.runners(udid));
  listing.catch(() => undefined);
  const [xcode, teams, facts] = await Promise.all([timed('checking Xcode', d.xcode()), timed('reading teams', d.teams()),
    timed('checking the iPhone', d.phone(udid).catch((): PhoneFacts => ({ found: false })))]);
  const err = preflight(xcode, facts, udid);
  if (err) throw err;
  const saved = d.saved(udid);
  // An API key is used for this setup only (PhoneDock remembers the team and the build, nothing else).
  const apiKey = req.apiKey;
  const team = chooseTeam(teams, { team: req.team, apiKey, udid, remembered: saved?.team });
  // A team that fell back to its own runner id before keeps it.
  let cfg: WdaConfig = { team: team.id, free: team.free, bundleId: saved?.team === team.id && saved.bundleId ? saved.bundleId : runnerBundleId(team.id, team.free), ...(apiKey ? { apiKey } : {}) };
  const before = await listing.catch((e: unknown) => {
    throw new PhoneDockError('PhoneDock couldn’t see what runs on the iPhone', 'no_device', 409, ['Keep the iPhone connected and awake, then try again.'], (e as Error)?.message);
  });
  const tunnel = await timed('tunnel address', d.tunnel(udid));
  const result = (r: Reach, reused: boolean, pid?: number): WdaSetupResult => {
    d.save(udid, { team: cfg.team, free: cfg.free, bundleId: cfg.bundleId });   // never an API key: it is asked for when signing
    return { udid, wdaUrl: urlFor(tunnel, WDA_PORT), ...(pid ? { pid } : {}), team: cfg.team, shared: share, ...(r.sharedUrl ? { sharedUrl: r.sharedUrl } : {}), reused };
  };
  // Already running: used only when it is positively private here (it answers on this Mac's tunnel and the Wi-Fi
  // address it reports refuses it: with no Wi-Fi address reported, nothing shows how it is bound). Anything else, and
  // anything when sharing is asked for, is left alone.
  const reusable = async () => {
    if (!before.length) return false;
    const r = await timed('checking the running one', checkReach(d, tunnel));
    if (!share && r.kind === 'private' && r.wifi) return true;
    throw runningError(udid, r.kind === 'private' && !r.wifi ? { ...r, kind: 'unknown', why: 'it reports no Wi-Fi address, so how it is bound can’t be checked' } : r, share);
  };
  if (await reusable()) {
    onProgress('WebDriverAgent is already running, reachable only from this Mac');
    return result({ kind: 'private', why: '' }, true);
  }
  onProgress(`Signing with team ${cfg.team}${cfg.free ? ' (a personal team: its signing lasts 7 days; then set up again)' : ''}`);
  let xctestrun = '';
  let built = false;
  let listedAt = d.now();
  let baseline = before;
  const launch = async (): Promise<WdaSetupResult> => {
    // A build (or a wait for one) ran meanwhile: look again, and leave alone what appeared.
    if (d.now() - listedAt > 10_000) {
      baseline = await timed('listing runners on the iPhone', d.runners(udid)).catch(() => { throw new PhoneDockError('PhoneDock couldn’t see what runs on the iPhone', 'no_device', 409, ['Keep the iPhone connected and awake, then try again.']); });
      listedAt = d.now();
      if (baseline.length) throw runningError(udid, { kind: 'unknown', why: 'it started while WebDriverAgent was being built' }, share);
    }
    const t0 = d.now();
    const env: NodeJS.ProcessEnv = {
      ...d.env,
      // Passed to the runner without the prefix (man xcodebuild); FBWebServer binds HTTP and MJPEG to USE_IP.
      TEST_RUNNER_USE_PORT: String(WDA_PORT), TEST_RUNNER_MJPEG_SERVER_PORT: String(MJPEG_PORT),
      ...(share ? {} : { TEST_RUNNER_USE_IP: tunnel }),
    };
    let s: Awaited<ReturnType<typeof startRunner>> | undefined;
    try {
      s = await startRunner(d.spawn, { xctestrun, destination: `id=${udid}`, env, now: () => d.now(), udid, team: cfg.team, signal: ctl.signal, apiKey: cfg.apiKey }, onProgress);
      ctl.onRunner?.(s.runner);
      ctl.onStep?.('xcodebuild starting WebDriverAgent', d.now() - t0);
      const printed = parsePrinted(s.url);
      // FBWebServer prints the address it bound: proof the private binding took effect.
      if (!share && (!printed || !sameHost(printed.host, tunnel))) {
        throw new PhoneDockError('WebDriverAgent didn’t bind to the iPhone’s private address', 'wda_exposed', 502,
          ['PhoneDock stopped it. Set up control again; if it happens again, report it.'], `asked it to bind ${tunnel}; it printed ${s.url}`);
      }
      const r = await timed(share ? 'checking it answers' : 'checking it is private', checkReach(d, tunnel, printed?.port ?? WDA_PORT));
      // Private: the bind to the tunnel (just checked) plus, when it reports a Wi-Fi address, that address refusing it.
      if (!share && r.kind === 'shared') {
        throw new PhoneDockError('WebDriverAgent answered on the iPhone’s Wi-Fi address', 'wda_exposed', 502,
          ['PhoneDock stopped it, so nobody on this network can control the iPhone. Set up control again; if it happens again, report it.'], r.why);
      }
      // Shared: it answers on the Wi-Fi address (or reports none: bound to every address, it is reachable there anyway).
      if (share ? !(r.kind === 'shared' || (r.kind === 'private' && r.wifi === null)) : r.kind !== 'private') {
        throw new PhoneDockError(share ? 'PhoneDock couldn’t confirm other Macs can reach WebDriverAgent' : 'PhoneDock couldn’t confirm WebDriverAgent is private',
          'wda_unverified', 502, [`PhoneDock stopped it. Keep the iPhone awake on the Wi-Fi and try again. ${LOCAL_NETWORK_HINT}`], r.why);
      }
      onProgress(share ? `WebDriverAgent is running; anyone on this Wi-Fi can control the iPhone${r.sharedUrl ? ` (other Macs connect to ${r.sharedUrl})` : ''}` : 'WebDriverAgent is running, reachable only from this Mac');
      return result(r, false, s.runner.pid);
    } catch (e) {
      // This launch's runner ends with the failure (also one whose xcodebuild died before printing its address): its
      // xcodebuild, then on the phone what wasn't there just before it started.
      if (s) await stopRunner(s.runner);
      const left = await d.runners(udid).then(async (now) => {
        const mine = now.filter((p) => !baseline.includes(p));
        return mine.length ? d.endRunners(udid, mine) : 0;
      }).catch(() => -1);
      if (left !== 0 && e instanceof PhoneDockError) {
        e.hints = [`PhoneDock couldn’t confirm the WebDriverAgent it started is gone: press Stop Control (\`phonedock ios wda-stop --udid ${udid}\`).`, ...(e.hints ?? []).filter((h) => !/^PhoneDock stopped it/.test(h))];
      }
      throw e;
    }
  };
  const attempt = async (force?: string): Promise<WdaSetupResult> => {
    const b = await timed('build check', ensureBuild(d, udid, cfg, onProgress, { force, signal: ctl.signal }));
    xctestrun = b.xctestrun; built ||= b.built;
    if (b.built) listedAt = 0;                       // a build ran: look at the phone again before launching
    return launch();
  };
  try { return await attempt(); }
  catch (e) {
    if (!(e instanceof PhoneDockError)) throw e;
    // A paid team whose profile can't cover upstream's runner id: its own id, from now on (a new build).
    if (e.code === 'bundle_id_unavailable' && cfg.bundleId === UPSTREAM_RUNNER_BUNDLE_ID) {
      cfg = { ...cfg, bundleId: teamScopedBundleId(cfg.team) };
      onProgress(`Team ${cfg.team} can’t sign WebDriverAgent’s usual app ID; trying its own (${cfg.bundleId})…`);
      return attempt();
    }
    // The phone refuses an existing build's signing (expired, revoked, or it isn't in the profile yet): build again
    // once (a person asked for this setup).
    const why = { signing_expired: 'its signing expired', signature_invalid: 'the iPhone refused its signature', device_not_registered: 'this iPhone isn’t in its profile yet' }[e.code as 'signing_expired'];
    if (why && !built) return attempt(why);
    throw e;
  }
}
