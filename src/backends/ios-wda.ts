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
  if (/has not been explicitly trusted|Untrusted Developer|inadequate entitlements or its profile|Verify the Developer App certificate|invalid code signature/i.test(text)) {
    return new PhoneDockError('Trust the developer on the iPhone', 'wda_untrusted', 409,
      ['On the iPhone open Settings › General › VPN & Device Management, tap your Apple ID and tap Trust. PhoneDock tries again by itself.'], tail);
  }
  if (/profile has expired|certificate has expired|provisioning profile .*expired|signature .*expired/i.test(text)) {
    return new PhoneDockError('WebDriverAgent’s signing expired', 'signing_expired', 409, ['PhoneDock rebuilds it; try again if this persists.'], tail);
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
  /** Resolves when xcodebuild exits (WebDriverAgent stops with it). */
  exited: Promise<number | null>;
}

/** Stop a runner and wait (bounded) until it has exited, so its replacement never overlaps it on the phone. */
export async function stopRunner(r: Runner, waitMs = 15_000): Promise<void> {
  if (!r.alive()) return;
  r.kill();
  await Promise.race([r.exited, new Promise<void>((res) => { const t = setTimeout(res, waitMs); t.unref?.(); })]);
}

export function cancelledError(): PhoneDockError {
  return new PhoneDockError('Setup was stopped', 'cancelled', 409, ['The iPhone was disconnected in PhoneDock while it was being set up.']);
}

/** Run build-for-testing to completion; reject with a classified error. A first signing can stop at a macOS prompt
 *  ("codesign wants to use a key in your keychain") that nobody sees from a service, so it has a time limit; a stop
 *  (time limit or `signal`) escalates to SIGKILL and never waits forever for the exit. */
export async function runBuild(spawn: Spawn, plan: BuildPlan, env: NodeJS.ProcessEnv, onProgress: (l: string) => void,
  ctx: { udid?: string; timeoutMs?: number; signal?: AbortSignal; graceMs?: number } = {}): Promise<void> {
  if (ctx.signal?.aborted) throw cancelledError();
  const child = spawn('xcodebuild', buildArgv(plan), { env: { ...env, WDA_PRODUCT_BUNDLE_IDENTIFIER: plan.bundleId } });
  let alive = true;
  const tail: string[] = []; const st = { compiled: 0 };
  let stopped: 'timeout' | 'cancelled' | undefined;
  let giveUp!: () => void;
  const gaveUp = new Promise<'stuck'>((res) => { giveUp = () => res('stuck'); });
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
  const exited = lines(child, (l) => {
    tail.push(l); if (tail.length > 400) tail.shift();
    const p = progressFor(l, st); if (p) onProgress(p);
  }).then((c) => { alive = false; return c; });
  const code = await Promise.race([exited, gaveUp]).finally(() => { clearTimeout(timer); ctx.signal?.removeEventListener('abort', onAbort); });
  if (stopped === 'cancelled') throw cancelledError();
  if (stopped === 'timeout') {
    throw new PhoneDockError('Building WebDriverAgent took too long', 'wda_setup_failed', 504,
      ['If macOS asked whether codesign may use a key in your keychain, click Always Allow, then try again.'], tail.slice(-12).join('\n'));
  }
  if (code !== 0) throw classifyXcodebuild(tail.join('\n'), 'build', { team: plan.team, udid: ctx.udid });
}

/** Start the runner and resolve once WebDriverAgent prints its address; xcodebuild keeps running to host it. */
export function startRunner(spawn: Spawn,
  o: { xctestrun: string; destination: string; env: NodeJS.ProcessEnv; now: () => number; timeoutMs?: number; udid?: string; team?: string; signal?: AbortSignal; graceMs?: number },
  onProgress: (l: string) => void): Promise<{ runner: Runner; url: string }> {
  if (o.signal?.aborted) return Promise.reject(cancelledError());
  const child = spawn('xcodebuild', launchArgv(o.xctestrun, o.destination), { env: o.env });
  let alive = true;
  const tail: string[] = []; const st = { compiled: 0 };
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => { settled = true; clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort); };
    const runner: Runner = {
      pid: child.pid, startedAt: o.now(), alive: () => alive,
      kill: () => stopChild(child, () => alive, o.graceMs),
      exited: lines(child, (l) => {
        if (!settled) { tail.push(l); if (tail.length > 300) tail.shift(); }
        const m = /ServerURLHere->(\S+?)<-ServerURLHere/.exec(l);
        if (m && !settled) {
          finish();
          runner.readyAt = o.now();
          const url = m[1].replace(/\/+$/, '');
          onProgress(`WebDriverAgent is running at ${url}`);
          resolve({ runner, url });
          return;
        }
        if (!settled) { const p = progressFor(l, st); if (p) onProgress(p); }
      }).then((code) => {
        alive = false;
        if (!settled) { finish(); reject(classifyXcodebuild(tail.join('\n'), 'launch', { team: o.team, udid: o.udid })); }
        return code;
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
export const isDeviceDestination = (dest: string) => !/simulator/i.test(dest);

/** One build at a time per build directory: two phones on one team share it, and two xcodebuilds in one
 *  DerivedData fight over its build database. */
const buildLocks = new Map<string, Promise<void>>();
async function withBuildLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const before = buildLocks.get(key) ?? Promise.resolve();
  const run = before.then(fn);
  const settled = run.then(() => undefined, () => undefined);
  buildLocks.set(key, settled);
  try { return await run; } finally { if (buildLocks.get(key) === settled) buildLocks.delete(key); }
}

/** Make sure a signed build that this phone can run exists, building it when the key changed, the signing is about
 *  to expire, or the phone isn't in the profile yet. */
export async function ensureBuild(d: WdaBuildDeps, udid: string, cfg: WdaConfig, onProgress: (l: string) => void,
  opts: { force?: string; signal?: AbortSignal } = {}): Promise<{ dir: string; xctestrun: string; built: boolean; reason?: string; builtAt?: number }> {
  const xcode = await d.xcode();
  if (!xcode) throw preflight(undefined, undefined, udid)!;
  const src = await d.source(onProgress);
  const key = buildKey({ wdaVersion: src.version, team: cfg.team, xcodeBuild: xcode.build, bundleId: cfg.bundleId });
  const dir = join(d.buildsDir, key);
  const derivedData = join(dir, 'DerivedData');
  const destination = destinationFor(udid, cfg);
  const device = isDeviceDestination(destination);
  return withBuildLock(key, async () => {
    if (opts.signal?.aborted) throw cancelledError();
    // Checked inside the lock: another phone's build may have just made what this one needs.
    let xctestrun = findXctestrun(derivedData);
    const profile = xctestrun && device ? await readProfile(runnerApp(derivedData), d.exec) : undefined;
    const reason = opts.force ?? rebuildReason({ xctestrun, profile, udid, now: d.now(), device });
    if (!reason && xctestrun) {
      d.writeFile(join(dir, '.last-used'), new Date(d.now()).toISOString() + '\n');
      return { dir, xctestrun, built: false, builtAt: builtAtOf(dir) };
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
      d.env, onProgress, { udid, signal: opts.signal });
    xctestrun = findXctestrun(derivedData);
    if (!xctestrun) throw new PhoneDockError('Couldn’t build WebDriverAgent', 'wda_setup_failed', 502, undefined, `xcodebuild build-for-testing wrote no .xctestrun under ${derivedData}`);
    const now = d.now(), at = new Date(now).toISOString();
    d.writeFile(join(dir, 'build.json'), JSON.stringify({ key, wdaVersion: src.version, team: cfg.team, bundleId: cfg.bundleId, xcode: xcode.build, builtAt: at, reason }, null, 2) + '\n');
    d.writeFile(join(dir, '.last-used'), at + '\n');
    pruneBuilds(d, key);
    return { dir, xctestrun, built: true, reason, builtAt: now };
  });
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
    if (n === keep || n.startsWith('.') || buildLocks.has(n)) continue;
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

/** A build this recent that the phone calls untrusted really waits for the person to trust its developer. */
const FRESH_BUILD_MS = 3_600_000;

/** Build if needed, then start the runner. `beforeStart` runs between the two (the supervisor stops the old runner
 *  there, so a failed build leaves a working WebDriverAgent alone). A launch refused for expired signing, or for a
 *  signature an older build no longer passes (a certificate revoked elsewhere reads like "untrusted"), rebuilds once. */
export async function launchWda(d: WdaBuildDeps, udid: string, cfg: WdaConfig, onProgress: (l: string) => void,
  opts: { timeoutMs?: number; signal?: AbortSignal; beforeStart?: () => Promise<void> } = {}): Promise<{ runner: Runner; url: string; built: boolean }> {
  let b = await ensureBuild(d, udid, cfg, onProgress, { signal: opts.signal });
  await opts.beforeStart?.();
  const start = () => {
    onProgress('Starting WebDriverAgent on the iPhone…');
    return startRunner(d.spawn, { xctestrun: b.xctestrun, destination: destinationFor(udid, cfg), env: d.env, now: () => d.now(), timeoutMs: opts.timeoutMs, udid, team: cfg.team, signal: opts.signal }, onProgress);
  };
  try { return { ...(await start()), built: b.built }; }
  catch (e) {
    if (!(e instanceof PhoneDockError) || b.built) throw e;
    const stale = e.code === 'signing_expired'
      || (e.code === 'wda_untrusted' && (b.builtAt === undefined || d.now() - b.builtAt > FRESH_BUILD_MS));
    if (!stale) throw e;
    b = await ensureBuild(d, udid, cfg, onProgress, { force: e.code === 'signing_expired' ? 'its signing expired' : 'the iPhone refused its signature', signal: opts.signal });
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
  /** Build if needed, then start the runner (resolves at ServerURLHere). `beforeStart` runs after the build, before
   *  the new runner starts; `signal` aborts the build or the launch (Disconnect). */
  launch(udid: string, onProgress: (l: string) => void, ctl: { signal: AbortSignal; beforeStart: () => Promise<void> }): Promise<{ runner: Runner; url: string }>;
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
  /** Waits that only a launch revealed (xcodebuild said locked, untrusted, unreachable): longer each time, then give up. */
  personBackoffMs: readonly number[];
  maxPersonAttempts: number;
  /** A runner counts as healthy, and earlier failures are forgiven, once it has been up this long and answers. */
  minUptimeMs: number;
  /** Run tick() on a timer once started (tests drive tick() themselves). */
  autoTick: boolean;
}
export const SUPERVISE_DEFAULTS: SuperviseOptions = {
  tickMs: 15_000, graceMs: 45_000, backoffMs: [5_000, 15_000, 60_000, 300_000, 900_000], maxAttempts: 6, personPollMs: 30_000,
  personBackoffMs: [30_000, 60_000, 300_000, 900_000], maxPersonAttempts: 8, minUptimeMs: 60_000, autoTick: true,
};

interface Entry {
  state: WdaState; message: string; hint?: string;
  url?: string; runner?: Runner;
  attempts: number;
  personAttempts: number;
  nextAt?: number;
  /** last time /status answered */
  okAt?: number;
  /** /status answered at least once since this runner started */
  answered: boolean;
  /** devicectl reported the phone locked while waiting (so "unlocked" now means something) */
  sawLocked: boolean;
  reachable?: boolean;
  inflight?: Promise<void>;
  /** aborted by unmanage: a build or launch in flight stops */
  abort: AbortController;
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
  /** Only a started supervisor (the daemon's, unfiltered) launches anything on its own; setup() always may. */
  private started = false;

  constructor(deps: SupervisorDeps, opts: Partial<SuperviseOptions> = {}) {
    this.deps = deps;
    this.o = { ...SUPERVISE_DEFAULTS, ...opts };
  }

  get isStarted(): boolean { return this.started; }

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
    if (this.started) return;
    this.started = true;
    for (const udid of this.deps.managed()) void this.ensure(udid, 'PhoneDock started');
    if (this.o.autoTick && !this.timer) { this.timer = setInterval(() => { void this.tick(); }, this.o.tickMs); this.timer.unref(); }
  }

  /** Daemon exit: stop watching, cancel builds, and stop the runners PhoneDock started, so none is left running
   *  untracked. The next daemon starts WebDriverAgent again (no rebuild). */
  stop(): void {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const e of this.entries.values()) { e.gone = true; e.abort.abort(); e.runner?.kill(); }
    this.entries.clear();
  }

  /** The phones devicectl lists right now. A managed phone that comes back (USB or Wi-Fi) gets a start; one that
   *  was given up on gets a fresh count. A flap while running changes nothing: the tick watches /status. */
  observe(phones: { udid: string; reachable: boolean }[]): void {
    if (!this.started) return;
    const seen = new Map(phones.map((p) => [p.udid, p.reachable]));
    for (const udid of this.deps.managed()) {
      const e = this.entry(udid);
      const now = seen.get(udid) ?? false;
      const was = e.reachable;
      e.reachable = now;
      if (!now || e.inflight) continue;
      const back = was === false ? ['waiting_phone', 'failed', 'retrying'].includes(e.state) : was === undefined && e.state === 'waiting_phone';
      if (!back) continue;
      if (e.state === 'failed') { e.attempts = 0; e.personAttempts = 0; }
      void this.ensure(udid, 'the iPhone reconnected');
    }
  }

  /** Set up (or redo) WebDriverAgent now, for a person or agent who asked. Waits for a launch already under way
   *  (one launcher per phone), builds, and only then replaces the running WebDriverAgent, so a setup that fails to
   *  build leaves a working one alone. Rejects with the reason. */
  async setup(udid: string, onProgress: (l: string) => void): Promise<{ url: string; pid?: number }> {
    let e = this.entry(udid);
    while (e.inflight) { await e.inflight.catch(() => undefined); e = this.entry(udid); }
    e.attempts = 0; e.personAttempts = 0;
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
    e.attempts = 0; e.personAttempts = 0;
    if (!e.inflight && e.state !== 'running') void this.ensure(udid, why);
  }

  /** Stop managing a phone (Disconnect): cancel a build or launch in flight, stop the runner, forget the state. */
  unmanage(udid: string): void {
    const e = this.entries.get(udid);
    if (!e) return;
    e.gone = true;
    e.abort.abort();
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
    if (!this.started) return;
    // Phones no longer in the configuration are only skipped: Disconnect stops them explicitly, and an unreadable
    // configuration file must not stop every runner.
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
            const up = e.runner ? t - (e.runner.readyAt ?? e.runner.startedAt) : Infinity;
            if (up >= this.o.minUptimeMs) { e.attempts = 0; e.personAttempts = 0; }
            if (e.state !== 'running') this.set(e, 'running', 'WebDriverAgent is running');
            return;
          }
          if (e.runner && !e.runner.alive()) return;    // its exit handler takes over
          const since = e.okAt ?? e.runner?.readyAt ?? e.runner?.startedAt ?? 0;
          if (t - since < this.o.graceMs) return;
          if (e.runner && !e.answered) {
            // It started on the phone but this Mac never reached it: a network or Local Network problem. Relaunching
            // would kill a working runner, so wait for /status instead.
            if (e.state !== 'unreachable') {
              this.set(e, 'unreachable', `WebDriverAgent started, but PhoneDock can’t reach it at ${e.url}`,
                `Check that the iPhone and this Mac are on the same Wi-Fi. ${LOCAL_NETWORK_HINT}`);
            }
            return;
          }
          if (e.runner) {
            // It answered before and hangs now: replace it, and count it.
            e.attempts++;
            if (e.attempts >= this.o.maxAttempts) {
              const r = e.runner; e.runner = undefined; r.kill();
              this.giveUp(e, 'WebDriverAgent keeps hanging'); this.deps.changed?.(udid);
              return;
            }
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
        case 'waiting_trust':
        case 'retrying':
          if (e.nextAt !== undefined && now >= e.nextAt) void this.ensure(udid, e.state === 'retrying' ? 'retrying' : 'checking again');
          return;
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
    // Adopt a WebDriverAgent that already answers: PhoneDock's own, or one started elsewhere before this daemon.
    const saved = e.url ?? this.deps.savedUrl(udid);
    if (saved && (!e.runner || e.runner.alive()) && await this.deps.status(saved).catch(() => false)) {
      if (e.gone) return;
      e.url = saved; e.okAt = this.deps.now(); e.answered = true;
      this.set(e, 'running', 'WebDriverAgent is running');
      return;
    }
    // Waits devicectl can see cost no launch: look again at the waiting pace.
    const f = await this.deps.phone(udid).catch(() => undefined);
    if (e.gone) return;
    const person = this.personWait(f);
    if (person) {
      if (person.state === 'waiting_unlock') e.sawLocked = true;
      this.set(e, person.state, person.message, person.hint, this.deps.now() + this.o.personPollMs);
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
    // The current runner stays attached (Disconnect stops it, the adopt check sees it) until the build is done.
    const old = e.runner;
    const { runner, url } = await this.deps.launch(udid, onProgress, {
      signal: e.abort.signal,
      beforeStart: async () => {
        if (old && e.runner === old) e.runner = undefined;    // its exit is no longer a crash to handle
        if (old) await stopRunner(old);
      },
    });
    if (e.gone) { runner.kill(); return; }
    e.runner = runner; e.url = url; e.answered = false; e.okAt = undefined; e.sawLocked = false;
    this.deps.saveUrl(udid, url);   // the phone's address comes from DHCP and can change between launches
    this.set(e, 'running', 'WebDriverAgent is running');
    this.deps.log(`wda ${udid}: running at ${url} (xcodebuild pid ${runner.pid ?? '?'})`);
    void runner.exited.then(() => this.onExit(udid, e, runner));
  }

  private onExit(udid: string, e: Entry, runner: Runner): void {
    if (e.gone || e.runner !== runner || this.entries.get(udid) !== e) return;
    e.runner = undefined; e.answered = false;
    if (e.inflight) return;    // a launch under way replaces it anyway
    const up = this.deps.now() - (runner.readyAt ?? runner.startedAt);
    // Every unexpected stop counts; a runner that stayed healthy for a while had the count forgiven by the tick.
    e.attempts++;
    this.deps.log(`wda ${udid}: WebDriverAgent stopped after ${Math.round(up / 1000)} s (${e.attempts}/${this.o.maxAttempts})`);
    if (e.attempts >= this.o.maxAttempts) {
      this.giveUp(e, up < this.o.minUptimeMs ? 'WebDriverAgent keeps stopping right after it starts' : 'WebDriverAgent keeps stopping');
    } else {
      this.set(e, 'retrying', 'WebDriverAgent stopped; PhoneDock is restarting it', undefined, this.deps.now() + this.backoff(e.attempts));
    }
    this.deps.changed?.(udid);
  }

  private failed(udid: string, e: Entry, err: unknown, manual: boolean): void {
    if (e.gone) return;
    const pe = err instanceof PhoneDockError ? err : new PhoneDockError((err as Error)?.message ?? String(err), 'wda_setup_failed', 502);
    if (pe.code === 'cancelled') return;
    this.deps.log(`wda ${udid}: ${pe.code}: ${pe.message}`);
    const hint = pe.hints?.[0];
    if (PERSON_CODES.has(pe.code)) {
      // Found only by launching (devicectl saw nothing wrong): wait longer each time, and give up after a while,
      // so a person who never taps Trust doesn't get a launch (and an alert) every 30 seconds all night.
      e.personAttempts++;
      if (e.personAttempts > this.o.maxPersonAttempts) { this.giveUp(e, pe.message, hint); return; }
      const delay = this.o.personBackoffMs[Math.min(e.personAttempts - 1, this.o.personBackoffMs.length - 1)];
      const state: WdaState = pe.code === 'device_locked' ? 'waiting_unlock' : pe.code === 'wda_untrusted' ? 'waiting_trust' : 'waiting_phone';
      this.set(e, state, pe.code === 'device_locked' ? 'Unlock the iPhone so PhoneDock can start WebDriverAgent' : pe.message, hint, this.deps.now() + delay);
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
