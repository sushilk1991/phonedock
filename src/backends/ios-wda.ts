// WebDriverAgent for iPhones on iOS 26 and older (iOS 27+ is controlled natively: ios-hid.ts, ios-native.ts).
//
// PhoneDock builds the pinned appium/WebDriverAgent source (component 'wda') once per Mac, signing team, Xcode build
// and runner bundle id with `xcodebuild build-for-testing`, then starts it on the phone with
// `xcodebuild test-without-building -xctestrun <file>`. That xcodebuild process keeps WebDriverAgent alive: it ends
// with an iPhone reboot or a daemon restart, so WdaSupervisor relaunches it (daemon start, the phone reappearing,
// /status going quiet) with bounded backoff, one launcher per phone.
//
// Everything that touches the system arrives through injected functions, so this file is unit-tested with fakes
// (ios-wda.test.ts). ios-device.ts wires in devicectl, the component manager, ios-device.json and real processes.
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
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
export function chooseTeam(teams: XcodeTeam[], opts: { team?: string; apiKey?: WdaApiKey; udid?: string }): { id: string; free: boolean; name?: string } {
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

/** Upstream's runner id signs with a paid team's wildcard profile (verified). A personal (free) team can't use an id
 *  another team registered, so it gets its own. UNVERIFIED on a free team. */
export const UPSTREAM_RUNNER_BUNDLE_ID = 'com.facebook.WebDriverAgentRunner';
export function runnerBundleId(team: string, free: boolean): string {
  return free ? `dev.phonedock.wda.${team.toLowerCase()}` : UPSTREAM_RUNNER_BUNDLE_ID;
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

/** Start the built runner without building anything. */
export function launchArgv(xctestrun: string, destination: string): string[] {
  return ['test-without-building', '-xctestrun', xctestrun, '-destination', destination];
}

/** One directory per (WebDriverAgent version, team, Xcode build, runner bundle id): a change to any rebuilds. */
export function buildKey(o: { wdaVersion: string; team: string; xcodeBuild: string; bundleId: string }): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_');
  return `${safe(o.wdaVersion)}-${safe(o.team)}-${safe(o.xcodeBuild)}-${createHash('sha256').update(o.bundleId).digest('hex').slice(0, 8)}`;
}

/** The newest .xctestrun build-for-testing wrote (its name carries the SDK version: WebDriverAgentRunner_iphoneos27.2-arm64.xctestrun). */
export function findXctestrun(derivedData: string): string | undefined {
  const dir = join(derivedData, 'Build', 'Products');
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.startsWith('WebDriverAgentRunner_') && n.endsWith('.xctestrun')); } catch { return undefined; }
  return names.map((n) => join(dir, n)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

export const runnerApp = (derivedData: string) => join(derivedData, 'Build', 'Products', 'Debug-iphoneos', 'WebDriverAgentRunner-Runner.app');

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
  const tail = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(-12).join('\n').slice(-2000);
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
  if (/has not been explicitly trusted|Untrusted Developer|inadequate entitlements or its profile|Verify the Developer App certificate|invalid code signature/i.test(text)) {
    return new PhoneDockError('Trust the developer on the iPhone', 'wda_untrusted', 409,
      ['On the iPhone open Settings › General › VPN & Device Management, tap your Apple ID and tap Trust. PhoneDock tries again by itself.'], tail);
  }
  if (/profile has expired|certificate has expired|provisioning profile .*expired|signature .*expired/i.test(text)) {
    return new PhoneDockError('WebDriverAgent’s signing expired', 'signing_expired', 409, ['PhoneDock rebuilds it; try again if this persists.'], tail);
  }
  if (/Unlock .* to Continue|device is locked|passcode protected|is passcode locked|device was locked/i.test(text)) {
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

/** Feed a child's stdout+stderr to onLine, a line at a time; resolve with the exit code. */
function lines(child: ChildLike, onLine: (l: string) => void): Promise<number | null> {
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
    child.on('error', (e) => { if (!done) { done = true; onLine(`error: ${e.message}`); resolve(-1); } });
    child.on('close', (code) => { if (!done) { done = true; if (buf.trim()) onLine(buf); resolve(code); } });
  });
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

export interface Runner {
  pid?: number;
  /** When the runner started (ms). */
  startedAt: number;
  alive(): boolean;
  kill(): void;
  /** Resolves when xcodebuild exits (WebDriverAgent stops with it). */
  exited: Promise<number | null>;
}

/** Run build-for-testing to completion; reject with a classified error. A first signing can stop at a macOS prompt
 *  ("codesign wants to use a key in your keychain") that nobody sees from a service, so it has a time limit. */
export async function runBuild(spawn: Spawn, plan: BuildPlan, env: NodeJS.ProcessEnv, onProgress: (l: string) => void,
  ctx: { udid?: string; timeoutMs?: number } = {}): Promise<void> {
  const child = spawn('xcodebuild', buildArgv(plan), { env: { ...env, WDA_PRODUCT_BUNDLE_IDENTIFIER: plan.bundleId } });
  const tail: string[] = []; const st = { compiled: 0 };
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGINT'); }, ctx.timeoutMs ?? 1_200_000);
  timer.unref?.();
  const code = await lines(child, (l) => {
    tail.push(l); if (tail.length > 400) tail.shift();
    const p = progressFor(l, st); if (p) onProgress(p);
  }).finally(() => clearTimeout(timer));
  if (timedOut) {
    throw new PhoneDockError('Building WebDriverAgent took too long', 'wda_setup_failed', 504,
      ['If macOS asked whether codesign may use a key in your keychain, click Always Allow, then try again.'], tail.slice(-12).join('\n'));
  }
  if (code !== 0) throw classifyXcodebuild(tail.join('\n'), 'build', { team: plan.team, udid: ctx.udid });
}

/** Start the runner and resolve once WebDriverAgent prints its address; xcodebuild keeps running to host it. */
export function startRunner(spawn: Spawn, o: { xctestrun: string; destination: string; env: NodeJS.ProcessEnv; now: () => number; timeoutMs?: number; udid?: string; team?: string },
  onProgress: (l: string) => void): Promise<{ runner: Runner; url: string }> {
  const child = spawn('xcodebuild', launchArgv(o.xctestrun, o.destination), { env: o.env });
  let alive = true;
  const tail: string[] = []; const st = { compiled: 0 };
  return new Promise((resolve, reject) => {
    let settled = false;
    const runner: Runner = {
      pid: child.pid, startedAt: o.now(), alive: () => alive,
      kill: () => { if (alive) child.kill('SIGINT'); },
      exited: lines(child, (l) => {
        if (!settled) { tail.push(l); if (tail.length > 300) tail.shift(); }
        const m = /ServerURLHere->(\S+?)<-ServerURLHere/.exec(l);
        if (m && !settled) {
          settled = true; clearTimeout(timer);
          const url = m[1].replace(/\/+$/, '');
          onProgress(`WebDriverAgent is running at ${url}`);
          resolve({ runner, url });
          return;
        }
        if (!settled) { const p = progressFor(l, st); if (p) onProgress(p); }
      }).then((code) => {
        alive = false;
        if (!settled) { settled = true; clearTimeout(timer); reject(classifyXcodebuild(tail.join('\n'), 'launch', { team: o.team, udid: o.udid })); }
        return code;
      }),
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true; runner.kill();
      reject(new PhoneDockError('WebDriverAgent didn’t start in time', 'wda_setup_failed', 504,
        ['Unlock the iPhone, keep it unlocked, and try again.'], tail.slice(-12).join('\n')));
    }, o.timeoutMs ?? 240_000);
    timer.unref?.();
  });
}

// ── build once, launch many times ──────────────────────────────────────────

/** How PhoneDock signs WebDriverAgent for one phone (stored in ios-device.json; the key file's path, never its contents). */
export interface WdaConfig { team: string; free: boolean; bundleId: string; apiKey?: WdaApiKey; destination?: string }

export interface WdaBuildDeps {
  exec: Exec;
  spawn: Spawn;
  now(): number;
  env: NodeJS.ProcessEnv;
  /** <state>/wda-builds: one directory per build key. */
  buildsDir: string;
  /** The pinned WebDriverAgent source (installs the 'wda' component when it's missing). */
  source(onProgress: (l: string) => void): Promise<{ path: string; version: string }>;
  xcode(): Promise<XcodeInfo | undefined>;
  /** Copy a directory's contents into a new directory. */
  copyTree(from: string, to: string): Promise<void>;
  /** Write/read small files (build.json, .last-used). */
  writeFile(path: string, text: string): void;
  mkdir(path: string): void;
  remove(path: string): void;
}

const BUILD_KEEP_MS = 30 * DAY_MS;

export const destinationFor = (udid: string, cfg: WdaConfig) => cfg.destination ?? `id=${udid}`;
const isDeviceDestination = (dest: string) => !/simulator/i.test(dest);

/** Make sure a signed build that this phone can run exists, building it when the key changed, the signing is about
 *  to expire, or the phone isn't in the profile yet. */
export async function ensureBuild(d: WdaBuildDeps, udid: string, cfg: WdaConfig, onProgress: (l: string) => void, force?: string):
  Promise<{ dir: string; xctestrun: string; built: boolean; reason?: string }> {
  const xcode = await d.xcode();
  if (!xcode) throw preflight(undefined, undefined, udid)!;
  const src = await d.source(onProgress);
  const key = buildKey({ wdaVersion: src.version, team: cfg.team, xcodeBuild: xcode.build, bundleId: cfg.bundleId });
  const dir = join(d.buildsDir, key);
  const derivedData = join(dir, 'DerivedData');
  const destination = destinationFor(udid, cfg);
  const device = isDeviceDestination(destination);
  let xctestrun = findXctestrun(derivedData);
  const profile = xctestrun && device ? await readProfile(runnerApp(derivedData), d.exec) : undefined;
  const reason = force ?? rebuildReason({ xctestrun, profile, udid, now: d.now(), device });
  if (!reason && xctestrun) {
    d.writeFile(join(dir, '.last-used'), new Date(d.now()).toISOString() + '\n');
    return { dir, xctestrun, built: false };
  }
  onProgress(`Building WebDriverAgent ${src.version} for team ${cfg.team} (${reason}). The first build takes a few minutes…`);
  d.mkdir(dir);
  const project = join(dir, 'src');
  // Build a private copy: xcodebuild may write next to the project, and the verified component stays as downloaded.
  if (!existsSync(join(project, 'WebDriverAgent.xcodeproj'))) {
    d.remove(project);
    await d.copyTree(src.path, project);
  }
  await runBuild(d.spawn, { project: join(project, 'WebDriverAgent.xcodeproj'), derivedData, destination, team: cfg.team, bundleId: cfg.bundleId, apiKey: cfg.apiKey },
    d.env, onProgress, { udid });
  xctestrun = findXctestrun(derivedData);
  if (!xctestrun) throw new PhoneDockError('Couldn’t build WebDriverAgent', 'wda_setup_failed', 502, undefined, `xcodebuild build-for-testing wrote no .xctestrun under ${derivedData}`);
  const at = new Date(d.now()).toISOString();
  d.writeFile(join(dir, 'build.json'), JSON.stringify({ key, wdaVersion: src.version, team: cfg.team, bundleId: cfg.bundleId, xcode: xcode.build, builtAt: at, reason }, null, 2) + '\n');
  d.writeFile(join(dir, '.last-used'), at + '\n');
  pruneBuilds(d, key);
  return { dir, xctestrun, built: true, reason };
}

/** Builds nobody launched for 30 days (an old Xcode, an old WebDriverAgent pin, another team) are deleted. */
export function pruneBuilds(d: Pick<WdaBuildDeps, 'buildsDir' | 'now' | 'remove'>, keep: string, read: (p: string) => string | undefined = readText): string[] {
  const removed: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(d.buildsDir); } catch { return removed; }
  for (const n of names) {
    if (n === keep || n.startsWith('.')) continue;
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

/** Build if needed, then start the runner. A launch refused for expired signing rebuilds once and tries again. */
export async function launchWda(d: WdaBuildDeps, udid: string, cfg: WdaConfig, onProgress: (l: string) => void, opts: { timeoutMs?: number } = {}): Promise<{ runner: Runner; url: string; built: boolean }> {
  let b = await ensureBuild(d, udid, cfg, onProgress);
  const start = () => {
    onProgress('Starting WebDriverAgent on the iPhone…');
    return startRunner(d.spawn, { xctestrun: b.xctestrun, destination: destinationFor(udid, cfg), env: d.env, now: () => d.now(), timeoutMs: opts.timeoutMs, udid, team: cfg.team }, onProgress);
  };
  try { return { ...(await start()), built: b.built }; }
  catch (e) {
    if (!(e instanceof PhoneDockError) || e.code !== 'signing_expired' || b.built) throw e;
    b = await ensureBuild(d, udid, cfg, onProgress, 'its signing expired');
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
  /** Failed launches since the last success (person-waits don't count). */
  attempts: number;
  nextRetryAt?: string;
  updatedAt: string;
}

export interface SupervisorDeps {
  now(): number;
  /** udids PhoneDock manages WebDriverAgent for (ios-device.json). */
  managed(): string[];
  savedUrl(udid: string): string | undefined;
  saveUrl(udid: string, url: string): void;
  /** GET /status answered (fresh, short timeout). */
  status(url: string): Promise<boolean>;
  phone(udid: string): Promise<PhoneFacts>;
  /** Build if needed, then start the runner (resolves at ServerURLHere). */
  launch(udid: string, onProgress: (l: string) => void): Promise<{ runner: Runner; url: string }>;
  log(msg: string): void;
  changed?(udid: string): void;
}

export interface SuperviseOptions {
  tickMs: number;
  /** /status may be quiet this long before the runner counts as stuck (and, at launch, before Local Network is blamed). */
  graceMs: number;
  backoffMs: readonly number[];
  maxAttempts: number;
  /** How often to look again while waiting for a person (trust the developer, plug the phone in). */
  personPollMs: number;
  /** A runner that dies sooner than this after starting counts as a failed launch. */
  minUptimeMs: number;
}
export const SUPERVISE_DEFAULTS: SuperviseOptions = {
  tickMs: 15_000, graceMs: 45_000, backoffMs: [5_000, 15_000, 60_000, 300_000, 900_000], maxAttempts: 6, personPollMs: 30_000, minUptimeMs: 60_000,
};

interface Entry {
  state: WdaState; message: string; hint?: string;
  url?: string; runner?: Runner;
  attempts: number; nextAt?: number;
  /** last time /status answered */
  okAt?: number;
  /** /status answered at least once since this runner started */
  answered: boolean;
  reachable?: boolean;
  inflight?: Promise<void>;
  /** set by unmanage: everything in flight for this entry stops caring */
  gone?: boolean;
  updatedAt: number;
}

const PERSON_CODES = new Set(['device_locked', 'wda_untrusted', 'no_device', 'not_found', 'not_paired', 'developer_mode_off']);

export class WdaSupervisor {
  private readonly deps: SupervisorDeps;
  private readonly o: SuperviseOptions;
  private readonly entries = new Map<string, Entry>();
  private timer?: NodeJS.Timeout;
  private ticking?: Promise<void>;

  constructor(deps: SupervisorDeps, opts: Partial<SuperviseOptions> = {}) {
    this.deps = deps;
    this.o = { ...SUPERVISE_DEFAULTS, ...opts };
  }

  info(udid: string): WdaControl | undefined {
    const e = this.entries.get(udid);
    if (!e || !this.deps.managed().includes(udid)) return undefined;
    return {
      managed: true, state: e.state, message: e.message, ...(e.hint ? { hint: e.hint } : {}),
      ...(e.url ? { wdaUrl: e.url } : {}), attempts: e.attempts,
      ...(e.nextAt && (e.state === 'retrying' || e.state === 'waiting_trust') ? { nextRetryAt: new Date(e.nextAt).toISOString() } : {}),
      updatedAt: new Date(e.updatedAt).toISOString(),
    };
  }

  /** Daemon start: adopt each managed phone's WebDriverAgent if it answers, else start it; then watch them. */
  start(): void {
    for (const udid of this.deps.managed()) void this.ensure(udid, 'PhoneDock started');
    if (!this.timer) { this.timer = setInterval(() => { void this.tick(); }, this.o.tickMs); this.timer.unref(); }
  }

  /** Daemon exit: stop watching. Runners end with the daemon (their xcodebuild's pipes close). */
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  /** The phones devicectl lists right now. A managed phone that comes back (USB or Wi-Fi) gets a fresh start. */
  observe(phones: { udid: string; reachable: boolean }[]): void {
    const managed = new Set(this.deps.managed());
    const seen = new Map(phones.map((p) => [p.udid, p.reachable]));
    for (const udid of managed) {
      const e = this.entry(udid);
      const now = seen.get(udid) ?? false;
      const was = e.reachable;
      e.reachable = now;
      if (!now) continue;
      const back = was === false || (e.state === 'waiting_phone' || e.state === 'failed') && was !== true;
      if (back && !e.inflight && e.state !== 'running') {
        e.attempts = 0;
        void this.ensure(udid, 'the iPhone reconnected');
      }
    }
  }

  /** Set up (or redo) WebDriverAgent now, for a person or agent who asked. Waits for a launch already under way
   *  (one launcher per phone), then restarts so a new team or build takes effect. Rejects with the reason. */
  async setup(udid: string, onProgress: (l: string) => void): Promise<{ url: string; pid?: number }> {
    const e = this.entry(udid);
    while (e.inflight) await e.inflight.catch(() => undefined);   // a tick may start another while we wait
    e.attempts = 0;
    let failure: unknown;
    const run = (async () => {
      e.runner?.kill(); e.runner = undefined;
      this.set(e, 'starting', 'Setting up WebDriverAgent…');
      try { await this.launchNow(udid, e, onProgress); }
      catch (err) { failure = err; this.failed(udid, e, err, true); }
    })();
    e.inflight = run.finally(() => { if (e.inflight === tracked) e.inflight = undefined; });
    const tracked = e.inflight;
    await tracked;
    if (failure) throw failure;
    return { url: e.url!, pid: e.runner?.pid };
  }

  /** Stop managing a phone (Disconnect): stop the runner PhoneDock started, forget the state. */
  unmanage(udid: string): void {
    const e = this.entries.get(udid);
    if (!e) return;
    e.gone = true;
    e.runner?.kill();
    this.entries.delete(udid);
    this.deps.changed?.(udid);
  }

  /** One supervision pass (the timer calls it; tests call it directly). */
  tick(): Promise<void> {
    this.ticking ??= this.tickOnce().finally(() => { this.ticking = undefined; });
    return this.ticking;
  }

  private async tickOnce(): Promise<void> {
    const managed = this.deps.managed();
    for (const udid of [...this.entries.keys()]) if (!managed.includes(udid)) this.unmanage(udid);
    await Promise.all(managed.map(async (udid) => {
      const e = this.entry(udid);
      if (e.inflight) return;
      const now = this.deps.now();
      switch (e.state) {
        case 'running':
        case 'unreachable': {
          const ok = e.url ? await this.deps.status(e.url).catch(() => false) : false;
          if (e.gone || e.inflight) return;
          if (ok) {
            e.okAt = now; e.answered = true;
            if (e.state !== 'running' || e.attempts) { e.attempts = 0; this.set(e, 'running', 'WebDriverAgent is running'); }
            return;
          }
          if (e.runner && !e.runner.alive()) return;    // its exit handler relaunches
          const since = e.okAt ?? e.runner?.startedAt ?? 0;
          if (now - since < this.o.graceMs) return;
          if (e.runner && !e.answered) {
            // It started on the phone but this Mac never reached it: a network or Local Network problem. Relaunching
            // would kill a working runner, so wait for /status instead.
            if (e.state !== 'unreachable') {
              this.set(e, 'unreachable', `WebDriverAgent started, but PhoneDock can’t reach it at ${e.url}`,
                `Check that the iPhone and this Mac are on the same Wi-Fi. ${LOCAL_NETWORK_HINT}`);
            }
            return;
          }
          void this.ensure(udid, 'WebDriverAgent stopped answering');
          return;
        }
        case 'waiting_unlock': {
          const f = await this.deps.phone(udid).catch(() => undefined);
          if (e.gone || e.inflight) return;
          // Unlocked: go now. Lock state unknown (the probe isn't verified on every iOS): try at the person-poll pace,
          // so an unreadable lock never relaunches xcodebuild every tick.
          if (f?.found && (f.locked === false || f.locked == null && e.nextAt !== undefined && now >= e.nextAt)) void this.ensure(udid, 'the iPhone was unlocked');
          return;
        }
        case 'waiting_phone':
        case 'waiting_trust':
        case 'retrying':
          if (e.nextAt !== undefined && now >= e.nextAt) void this.ensure(udid, e.state === 'retrying' ? 'retrying' : 'checking again');
          return;
        case 'starting':
        case 'failed':
          return;
      }
    }));
  }

  private entry(udid: string): Entry {
    let e = this.entries.get(udid);
    if (!e) {
      e = { state: 'starting', message: 'Starting WebDriverAgent…', attempts: 0, answered: false, updatedAt: this.deps.now() };
      this.entries.set(udid, e);
    }
    return e;
  }

  private set(e: Entry, state: WdaState, message: string, hint?: string, nextAt?: number): void {
    e.state = state; e.message = message; e.hint = hint; e.nextAt = nextAt; e.updatedAt = this.deps.now();
  }

  /** One attempt at a time per phone; callers share it. */
  private ensure(udid: string, why: string): Promise<void> {
    const e = this.entry(udid);
    if (e.inflight) return e.inflight;
    const p = this.attempt(udid, e, why).catch((err) => { this.deps.log(`wda ${udid}: ${(err as Error).message}`); });
    e.inflight = p.finally(() => { if (e.inflight === tracked) e.inflight = undefined; this.deps.changed?.(udid); });
    const tracked = e.inflight;
    return tracked;
  }

  private async attempt(udid: string, e: Entry, why: string): Promise<void> {
    // Adopt a WebDriverAgent that already answers: PhoneDock's own, or one started elsewhere before this daemon.
    const saved = e.url ?? this.deps.savedUrl(udid);
    if (saved && (!e.runner || e.runner.alive()) && await this.deps.status(saved).catch(() => false)) {
      if (e.gone) return;
      e.url = saved; e.okAt = this.deps.now(); e.answered = true; e.attempts = 0;
      this.set(e, 'running', 'WebDriverAgent is running');
      return;
    }
    const f = await this.deps.phone(udid).catch(() => undefined);
    if (e.gone) return;
    const person = this.personWait(f);
    if (person) { this.set(e, person.state, person.message, person.hint, this.deps.now() + this.o.personPollMs); return; }
    if (e.runner) { e.runner.kill(); e.runner = undefined; }    // alive but silent: replace it
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

  private async launchNow(udid: string, e: Entry, onProgress: (l: string) => void): Promise<void> {
    const { runner, url } = await this.deps.launch(udid, onProgress);
    if (e.gone) { runner.kill(); return; }
    e.runner = runner; e.url = url; e.answered = false; e.okAt = undefined;
    this.deps.saveUrl(udid, url);   // the phone's address comes from DHCP and can change between launches
    this.set(e, 'running', 'WebDriverAgent is running');
    this.deps.log(`wda ${udid}: running at ${url} (xcodebuild pid ${runner.pid ?? '?'})`);
    void runner.exited.then(() => this.onExit(udid, e, runner));
  }

  private onExit(udid: string, e: Entry, runner: Runner): void {
    if (e.gone || e.runner !== runner || this.entries.get(udid) !== e) return;
    e.runner = undefined; e.answered = false;
    const quick = this.deps.now() - runner.startedAt < this.o.minUptimeMs;
    if (quick) e.attempts++;
    this.deps.log(`wda ${udid}: WebDriverAgent stopped${quick ? ' right after starting' : ''}`);
    if (e.attempts >= this.o.maxAttempts) { this.giveUp(e, 'WebDriverAgent keeps stopping right after it starts'); this.deps.changed?.(udid); return; }
    const delay = quick ? this.backoff(e.attempts) : this.o.backoffMs[0];
    this.set(e, 'retrying', 'WebDriverAgent stopped; PhoneDock is restarting it', undefined, this.deps.now() + delay);
    this.deps.changed?.(udid);
  }

  private failed(udid: string, e: Entry, err: unknown, manual: boolean): void {
    if (e.gone) return;
    const pe = err instanceof PhoneDockError ? err : new PhoneDockError((err as Error)?.message ?? String(err), 'wda_setup_failed', 502);
    this.deps.log(`wda ${udid}: ${pe.code}: ${pe.message}`);
    const hint = pe.hints?.[0];
    if (pe.code === 'device_locked') { this.set(e, 'waiting_unlock', 'Unlock the iPhone so PhoneDock can start WebDriverAgent', hint, this.deps.now() + this.o.personPollMs); return; }
    if (pe.code === 'wda_untrusted') { this.set(e, 'waiting_trust', pe.message, hint, this.deps.now() + this.o.personPollMs); return; }
    if (PERSON_CODES.has(pe.code)) { this.set(e, 'waiting_phone', pe.message, hint, this.deps.now() + this.o.personPollMs); return; }
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
