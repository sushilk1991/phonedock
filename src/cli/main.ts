#!/usr/bin/env node
// `phonedock` CLI – a thin layer over the SDK. `--json` on every command prints machine-readable output.
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PhoneDockClient, PhoneDockApiError, checkAppId, jobErrorText, matchName, tapMeta, readDaemonInfo, resolveDaemonEntry, daemonLogFile, phonedockHome, wakeNoticeText, SLEEPING_NOTE } from '../sdk/client.ts';
import type { Device, Job, DeviceSpec, Expect, ExpectReport, InputAction, OsImage, ElementMatch, Handoff, HandoffState, SystemGesture, SystemPrompt } from '../sdk/client.ts';
import { GLOBAL_ALIAS, GLOBAL_BOOLEAN, parseArgs, str, num, bool, table, type ParsedArgs } from './args.ts';
import { localTime } from '../backends/ios-common.ts';
import { appNotesDir, appNotesPath } from '../core/app-notes.ts';
import { parseEnvironmentAction } from '../core/environment.ts';
import { launchSummarySuffix } from '../core/launch-options.ts';
import { readBoundedGpxFile } from '../core/gpx.ts';
import type { LaunchArgs } from '../core/types.ts';

const NOTES_USAGE = 'app-notes list | show <appId> | save <appId> [--file F] | rm <appId> | path [appId]';

// Keep flow parsing, visual comparison and report generation out of ordinary CLI startup.
// Help still uses the commands' own text, so it cannot drift from their usage output.
async function helpText(): Promise<string> {
  const [{ FLOW_HELP }, { RUNS_HELP }, { TRACE_USAGE }, { PROXY_USAGE }] = await Promise.all([
    import('./flow-cmds.ts'), import('./runs-cmds.ts'), import('./trace-cmds.ts'), import('./proxy-cmds.ts'),
  ]);
  return `phonedock – device runtime for AI agents

Usage: phonedock <command> [args] [--json] [--owner NAME]

Setup:      setup [--agent claude|codex|cursor|pi|all] [--dry-run] [--check] [--uninstall] [--force]
              Connects PhoneDock to your agents in one step: registers the MCP server (user scope), installs the
              phonedock skill, links phonedock onto your PATH, then checks each stage. Default: every agent found.
              --dry-run prints the exact changes, --check only verifies, --uninstall removes what setup added.
Daemon:     daemon start|stop|status|logs|install-agent [--load]|uninstall-agent
Catalog:    backends | components | components install [id] [--no-wait]
            images [backend] | images install <backend> <image> | profiles <backend>
Devices:    devices|ls [--backend B --platform P --state S]
            create --backend B --name N [--image I --profile P --cpus N --ram MB --storage MB
                   --width W --height H --dpi D --disguise [PROFILE] --carrier C --seed HEX
                   --slim [PROFILE_JSON] --boot --auto-start --no-wait]
            boot <id> [--window] [--cold] [--slim [PROFILE_JSON] | --no-slim] [--no-wait] | shutdown <id> | rm <id> [--force]
            idle-sleep [off|10m|15m|30m|1h]   (no value: show it) put idle virtual phones to sleep after that long:
              their memory is freed; any use wakes them, usually where they left off (default off; 15m suggested)
            simslim [status|on|off] | simslim <id> [status|measure|on|off] [--no-reboot]
              Cut iOS simulator RAM/CPU ~40% using simslim (falls back to stock simctl when absent or failing)
            clone <id> <name> | window <id> | update <id> [--name N] [--auto-start true|false]
            snapshot ls|save|restore|rm <id> [name] | info <id>
Observe:    screenshot <id> [-o file] [--max-size N] [--format png|jpeg] | ui <id> [--json] [--no-ocr]
            find <id> <text> [--id ID] [--type T] [--match contains|exact|regex] [--no-ocr] | focus <id> [--timeout MS]
            wait-for <id> visible|gone|idle [--text T] [--id ID] [--type T] [--match M] [--timeout MS] [--stable MS]
            foreground <id> | crashes <id> [crashId] [--app A] [--since ISO|15m] [--limit N] [--full]
Input:      tap <id> <x> <y> | tap <id> @e12 | tap <id> --text "Sign in" [--match M] [--index N] [--type T]
            long-press <id> <x> <y> [ms] | double-tap <id> <x> <y> | pinch <id> <x> <y> <scale> [ms]
            swipe <id> x1 y1 x2 y2 [ms] | type <id> <text> [--secret] | key <id> <key> | hide-keyboard <id>
            fill <id> <value> (--text T | --ref e12 | --id ID | --at X,Y) [--no-clear] [--submit] [--secret]
            scroll-to <id> <text…> [--direction down|up|left|right] [--max N] [--match M] [--type T] [--at X,Y] [--no-ocr]
            back <id> | gesture <id> go_home|app_switcher|control_center|notification_center
            alert <id> [accept|dismiss|button <label>|button=<label>]   (no action: show the prompt on screen)
            tap, long-press, double-tap, swipe, type, key, fill, launch, input: --expect TEXT|visible:TEXT|gone:TEXT|id:ID|changed
              [--expect-timeout MS] [--expect-match M] waits for that after the input (exit 1 when not verified)
Apps:       apps <id> [--system] | install <id> <path|url> | terminate|uninstall <id> <appId>
            launch <id> <appId> [--arg VAL]... [--extra K=V]... [--args-json JSON] [--env K=V]...
            open-url <id> <url>
System:     shell <id> -- <cmd…> | push <id> <local> <remote> | pull <id> <remote> [local]
            logs <id> [-n N] [--filter F] | location <id> (<lat> <lon> | --gpx <file> [--speed MPS] [--loop] | --stop)
            rotate <id> portrait|landscape
            notify <id> <appId> '<json payload>' | appearance <id> [dark|light]   (no mode: show the current one)
            settings <id> [key=value ...] | settings <id> --reset
            clipboard <id> [--get | --set TEXT]   (prints the text as is; --set with no TEXT reads it from stdin)
            ${PROXY_USAGE}
              Saved HTTP/SOCKS5 proxies (0600 store; pass "-" for URL to read from stdin). Applies live on Android.
Multi-agent: lease <id> [--ttl S] [--force] | release <id> [--pool]
            acquire [--platform P] [--backend B] [--ttl S]
Physical:   discover --android | pair <code> [--serial S] | pair <host:port> <code> | disconnect <id>
            connect [<host:port>] [--serial S]   (no address: the one phone with Wireless debugging)
            (Android Wi-Fi commands take --restart-adb to restart a blocked adb server; see docs/API.md)
            connect --ios <ip|wda-url> [--name N] [--udid U] | discover --ios
            ios wda-setup --udid <id> [--team TEAMID] [--name N] [--share]   (older iPhones: Set Up Control, private to this Mac;
                          --share: this launch also listens on the Wi-Fi, without a password; see docs/IPHONE-WIFI.md)
              [--api-key-path AuthKey.p8 --api-key-id KEYID --api-key-issuer ISSUER]   (instead of an Apple ID in Xcode)
            ios wda-stop --udid <id>   (Stop Control: ends every WebDriverAgent on the iPhone)
            ios wda-teams   (the signing teams Xcode is signed in to)
Human:      handoff request <id> <reason…> [--timeout S] [--wait] | handoff ls [--state S|--all] | handoff show|wait <hid>
            handoff resolve <hid> done|cancelled [--note N]   (also: handoff done|cancel <hid>)
Recording:  actions <id> [--limit N] | replay <id> <file.json> | record <id> start|stop|status [--max S]
Perf:       ${TRACE_USAGE}
              Instruments (iOS) / perfetto + frame stats (Android) around a flow; stop prints a summary that
              compares with the previous trace of the same app. Default limit 60 s, max 600.
App data:   appdata <id> save|restore|ls <appId> [name]
App notes:  ${NOTES_USAGE}
              What agents learned about an app, shared by every agent on this Mac. save reads --file or stdin.
${FLOW_HELP}
${RUNS_HELP}
Diagnostics: doctor [--device ID] | audit <id> | environment <id> | request-result <id> <requestId>
Test setup: permissions <id> <appId> grant|revoke|reset <service...>
            biometric <id> enroll|unenroll|match|fail [--modality face|fingerprint] [--finger-id N]
            status-bar <id> override|clear [--time HH:MM] [--battery N] [--wifi N] [--cellular N]
            media <id> <image-or-video> | webview <id> [appId] [--measure SELECTOR] [--network] [--target ID] [--bounds x,y,w,h]
Misc:       jobs [jobId] | watch | mcp [--http PORT] [--profile all|runtime | --compact] | help

<id> accepts the full device id, the native id, or a unique name / prefix.
Coordinates are device screenshot pixels. Env: PHONEDOCK_PORT, PHONEDOCK_HOME, PHONEDOCK_OWNER.`;
}

class UsageError extends Error {}

function usage(msg: string): never { throw new UsageError(msg); }

let JSON_OUT = false;
let CMD: string | undefined;   // the command being run (for error hints)

function out(data: unknown, human?: () => string | void): void {
  if (JSON_OUT || !human) { process.stdout.write(JSON.stringify(data ?? null, null, 2) + '\n'); return; }
  const s = human(); if (typeof s === 'string') process.stdout.write(s + (s.endsWith('\n') ? '' : '\n'));
}

function need(p: string[], n: number, what: string): void { if (p.length < n) usage(`Missing argument(s): ${what}`); }

/** `--expect TEXT | visible:TEXT | gone:TEXT | id:ID | changed` (+ --expect-timeout MS, --expect-match MODE): what the
 *  screen should show after an input. */
function expectFlag(flags: Record<string, string | boolean>): Expect | undefined {
  const v = flags.expect;
  if (v === undefined || v === false) return undefined;
  if (v === true) usage('--expect needs a value: TEXT, visible:TEXT, gone:TEXT, id:ID or changed');
  const m = /^(visible|gone|id):([\s\S]+)$/.exec(v as string);
  const e: Expect = v === 'changed' ? { changed: true } : m ? { [m[1]]: m[2] } : { visible: v as string };
  const t = num(flags, 'expectTimeout'); if (t !== undefined) e.timeoutMs = t;
  const mm = str(flags, 'expectMatch'); if (mm) e.match = mm as Expect['match'];
  return e;
}
/** Parse `--arg`, `--extra`, `--args-json` and `--env` for `phonedock launch` in one left-to-right pass. Exported for tests. */
export function parseLaunchFlags(argv: string[], _a?: ParsedArgs): { args?: LaunchArgs; env?: Record<string, string> } {
  const posArgs: string[] = [];
  const extrasRaw: string[] = [];
  const envRaw: string[] = [];
  let argsJsonRaw: string | undefined;
  const boolSet = new Set(GLOBAL_BOOLEAN);

  const take = (flag: string, i: number): [string, number] => {
    if (i + 1 >= argv.length) usage(`--${flag} needs a value`);
    return [argv[i + 1], i + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--') break;
    if (tok === '--arg') { const [v, next] = take('arg', i); posArgs.push(v); i = next; continue; }
    if (tok.startsWith('--arg=')) { posArgs.push(tok.slice(6)); continue; }
    if (tok === '--extra') { const [v, next] = take('extra', i); extrasRaw.push(v); i = next; continue; }
    if (tok.startsWith('--extra=')) { extrasRaw.push(tok.slice(8)); continue; }
    if (tok === '--env') { const [v, next] = take('env', i); envRaw.push(v); i = next; continue; }
    if (tok.startsWith('--env=')) { envRaw.push(tok.slice(6)); continue; }
    if (tok === '--args-json') { const [v, next] = take('args-json', i); argsJsonRaw = v; i = next; continue; }
    if (tok.startsWith('--args-json=')) { argsJsonRaw = tok.slice(12); continue; }
    // Skip values of other flags so their values cannot be mistaken for launch flags.
    if (tok.startsWith('--') && tok.length > 2) {
      const name = tok.slice(2);
      if (!name.includes('=') && !boolSet.has(name) && !(name.startsWith('no-') && !boolSet.has(name))) {
        if (i + 1 < argv.length && (!argv[i + 1].startsWith('-') || /^-\.?\d/.test(argv[i + 1]))) i++;
      }
    } else if (tok.startsWith('-') && tok.length > 1 && !/^-\.?\d/.test(tok)) {
      const short = tok.slice(1);
      const name = GLOBAL_ALIAS[short] ?? short;
      if (!boolSet.has(name) && i + 1 < argv.length) i++;
    }
  }

  const argSources = [posArgs.length > 0, extrasRaw.length > 0, argsJsonRaw !== undefined].filter(Boolean).length;
  if (argSources > 1) usage('launch: pass only one of --arg, --extra, or --args-json');

  const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);

  let args: LaunchArgs | undefined;
  if (posArgs.length) {
    args = posArgs;
  } else if (extrasRaw.length) {
    const map: Record<string, string> = {};
    for (const kv of extrasRaw) {
      const i = kv.indexOf('=');
      if (i < 1) usage(`--extra takes KEY=VALUE (got "${kv}")`);
      const k = kv.slice(0, i);
      if (forbiddenKeys.has(k)) usage(`Invalid launch argument key ${JSON.stringify(k)}`);
      map[k] = kv.slice(i + 1);
    }
    args = map;
  } else if (argsJsonRaw !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(argsJsonRaw); } catch (e) { usage(`--args-json is not valid JSON: ${(e as Error).message}`); }
    if (!Array.isArray(parsed) && (!parsed || typeof parsed !== 'object')) usage('--args-json must be a JSON array or object');
    if (!Array.isArray(parsed)) {
      for (const k of Object.keys(parsed as Record<string, unknown>)) {
        if (forbiddenKeys.has(k)) usage(`Invalid launch argument key ${JSON.stringify(k)}`);
      }
    }
    args = parsed as LaunchArgs;
  }

  let env: Record<string, string> | undefined;
  if (envRaw.length) {
    env = {};
    for (const kv of envRaw) {
      const i = kv.indexOf('=');
      if (i < 1) usage(`--env takes NAME=VALUE (got "${kv}")`);
      const k = kv.slice(0, i);
      if (forbiddenKeys.has(k)) usage(`Invalid environment variable name ${JSON.stringify(k)} (expected [A-Za-z_][A-Za-z0-9_]*)`);
      env[k] = kv.slice(i + 1);
    }
  }
  return { ...(args !== undefined ? { args } : {}), ...(env !== undefined ? { env } : {}) };
}

/** The human line of an input with its expect result, and the exit code (1: not verified). */
function withExpect(r: { expect?: ExpectReport }, line: string): string { return r.expect ? `${line}\n${r.expect.message}${!r.expect.ok && r.expect.summary ? `\n  screen now: ${r.expect.summary}` : ''}` : line; }
const expectCode = (r: { expect?: ExpectReport }): number => (r.expect && !r.expect.ok ? 1 : 0);

function toNum(s: string, what: string): number {
  const n = Number(s); if (!Number.isFinite(n)) usage(`${what} must be a number (got "${s}")`); return n;
}

const hhmm = (iso: string) => { const t = new Date(iso); return Number.isFinite(t.getTime()) ? t.toTimeString().slice(0, 5) : iso; };
/** "mcp:claude-code:36623 (stale)", "app:human (until handed back)", "cli:me (idle 10 min → 14:05)". */
export function leaseCell(l: Device['lease']): string {
  if (!l) return '';
  if (l.stale) return `${l.owner} (stale: process exited)`;
  return `${l.owner}${l.expiresAt ? ` (until ${hhmm(l.expiresAt)} unless used)` : ' (until handed back)'}`;
}
/** Pending handoff: who asked for a person, and what for. */
export function humanCell(d: Device): string {
  const h = d.handoff; if (!h || h.state !== 'pending') return '';
  const r = h.reason.length > 40 ? h.reason.slice(0, 39) + '…' : h.reason;
  return `WAITING (${h.requestedBy}): "${r}"`;
}
const quietFlag = (a: ParsedArgs) => !!a.flags.quiet;

export function devicesTable(list: Device[]): string {
  const rows = list.map((d) => ({
    name: d.name, id: d.id, platform: d.platform, kind: d.kind, state: d.sleep ? `${d.state} (sleeping)` : d.state,
    os: d.osVersion ?? '', screen: d.screen ? `${d.screen.width}x${d.screen.height}` : '',
    lease: leaseCell(d.lease), human: humanCell(d), managed: d.managed ? 'yes' : '',
  }));
  const cols = ['name', 'id', 'platform', 'state', 'os', 'screen', 'lease', ...(rows.some((r) => r.human) ? ['human'] : []), 'managed'];
  const waiting = list.filter((d) => humanCell(d));
  const sleeping = list.filter((d) => d.sleep);
  const notSleeping = list.filter((d) => d.sleepFailure && d.state === 'running');
  return table(rows, cols) + sharingNotes(list)
    + (sleeping.length ? `\n\n${sleeping.map((d) => `${d.name} is ${SLEEPING_NOTE}.`).join('\n')}` : '')
    + (notSleeping.length ? `\n\n${notSleeping.map((d) => `${d.name} couldn’t go to sleep, so it keeps running: ${d.sleepFailure!.message}`).join('\n')}` : '')
    + (waiting.length
    ? `\n\n${waiting.map((d) => `${d.name} is waiting for a person: ${d.handoff!.reason}\n  Do it on the device (as the person: --owner app:human, no lease needed), then: phonedock handoff done ${d.handoff!.id} [--note "…"]   (or: phonedock handoff cancel ${d.handoff!.id})`).join('\n')}`
    : '');
}

/** wda-setup's done line. "Only from this Mac" only when the result says `shared: false`: a daemon from before 0.7.0
 *  launched WebDriverAgent on every address and says nothing about it. */
export function setupDoneText(result: unknown): string {
  const r = (result ?? {}) as { wdaUrl?: string; sharedUrl?: string; shared?: boolean };
  const reach = r.shared === true
    ? `, shared on the Wi-Fi${r.sharedUrl ? `: other Macs run \`phonedock connect --ios ${r.sharedUrl}\`` : ''}. Anyone on this Wi-Fi can control the iPhone until Stop Control or a restart of the iPhone`
    : r.shared === false ? ' (reachable only from this Mac)'
    : '. This PhoneDock didn’t say whether other Macs on the Wi-Fi can reach it: update it, or run `phonedock ios wda-stop` if you didn’t mean to share';
  return `WebDriverAgent running at ${r.wdaUrl}${reach}. It doesn’t come back by itself after the iPhone or PhoneDock restarts.`;
}

/** Older iPhones whose control is shared on the Wi-Fi (or can't be checked): said under the table, every time. */
export function sharingNotes(list: Device[]): string {
  const lines = list.flatMap((d) => {
    const stop = `Stop Control ends it: phonedock ios wda-stop --udid ${d.nativeId}`;
    if (d.meta?.wdaSharing === 'shared') return [`${d.name}: anyone on this Wi-Fi can control it, without a password${d.meta.wdaSharedUrl ? ` (other Macs: phonedock connect --ios ${d.meta.wdaSharedUrl})` : ''}. ${stop}`];
    if (d.meta?.wdaSharing === 'unknown') return [`${d.name}: couldn’t check whether other Macs on this Wi-Fi can control it (allow PhoneDock under Privacy & Security › Local Network). ${stop}`];
    return [];
  });
  return lines.length ? `\n\n${lines.join('\n')}` : '';
}

function progressPrinter(quiet: boolean) {
  return quiet || JSON_OUT ? undefined : (l: string) => process.stderr.write(`  ${l}\n`);
}

function launchAgentsDir(): string { return process.env.PHONEDOCK_LAUNCH_AGENTS_DIR ?? join(homedir(), 'Library', 'LaunchAgents'); }
const AGENT_LABEL = 'dev.phonedock.daemon';

function xml(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

export function launchAgentPlist(entry: string, nodePath: string, env: Record<string, string>, logFile: string): string {
  const envXml = Object.entries(env).map(([k, v]) => `      <key>${xml(k)}</key><string>${xml(v)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(nodePath)}</string>
      <string>${xml(entry)}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ProcessType</key><string>Background</string>
    <key>StandardOutPath</key><string>${xml(logFile)}</string>
    <key>StandardErrorPath</key><string>${xml(logFile)}</string>
  </dict>
</plist>
`;
}

async function daemonCmd(c: PhoneDockClient, a: ParsedArgs): Promise<number> {
  const sub = a.positionals[1] ?? 'status';
  switch (sub) {
    case 'start': {
      await c.ensureDaemon();
      const h = await c.health();
      out({ ...h, url: c.baseUrl }, () => `PhoneDock daemon running at ${c.baseUrl} (pid ${h.pid}, v${h.version})`);
      return 0;
    }
    case 'stop': {
      const info = readDaemonInfo(c.home);
      let pid = info?.pid;
      try { pid = (await c.health()).pid ?? pid; } catch { /* not running */ }
      if (!pid) { out({ ok: true, running: false }, () => 'Daemon is not running.'); return 0; }
      try { process.kill(pid, 'SIGTERM'); } catch { out({ ok: true, running: false }, () => 'Daemon is not running.'); return 0; }
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 100));
        try { process.kill(pid, 0); } catch { break; }
      }
      out({ ok: true, pid, stopped: true }, () => `Stopped daemon (pid ${pid}).${existsSync(join(launchAgentsDir(), AGENT_LABEL + '.plist')) ? '\nNote: the LaunchAgent (KeepAlive) may restart it; use `phonedock daemon uninstall-agent` to stop that.' : ''}`);
      return 0;
    }
    case 'status': {
      const info = readDaemonInfo(c.home);
      let health: unknown = null;
      try { health = await c.health(); } catch { /* down */ }
      const st = { running: !!health, url: c.baseUrl, health, home: c.home, daemonJson: info ? { ...info, token: info.token ? '***' : undefined } : null, entry: resolveDaemonEntry() };
      out(st, () => health ? `running  ${c.baseUrl}  ${JSON.stringify(health)}` : `not running (expected at ${c.baseUrl}; home ${c.home})`);
      return health ? 0 : 1;
    }
    case 'logs': {
      const n = num(a.flags, 'lines') ?? 100;
      const cands = [daemonLogFile(c.home), join(c.home, 'daemon.log'), join(c.home, 'logs', 'phonedockd.log')].filter((f) => existsSync(f));
      if (!cands.length) { out({ files: [] }, () => `No daemon log found under ${c.home}`); return 1; }
      for (const f of cands) {
        const lines = readFileSync(f, 'utf8').split('\n');
        const tail = lines.slice(-n - 1).join('\n');
        out({ file: f, text: tail }, () => `==> ${f} <==\n${tail}`);
      }
      return 0;
    }
    case 'install-agent': {
      const entry = resolveDaemonEntry();
      if (!entry) usage('Cannot find the daemon entry point (set PHONEDOCK_DAEMON_ENTRY)');
      const env: Record<string, string> = { PHONEDOCK_HOME: c.home, PATH: [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':') };
      if (process.env.PHONEDOCK_PORT) env.PHONEDOCK_PORT = process.env.PHONEDOCK_PORT;
      for (const k of ['ANDROID_HOME', 'ANDROID_SDK_ROOT', 'JAVA_HOME', 'DEVELOPER_DIR']) if (process.env[k]) env[k] = process.env[k]!;
      const dir = launchAgentsDir(); mkdirSync(dir, { recursive: true });
      const plist = join(dir, `${AGENT_LABEL}.plist`);
      const logFile = daemonLogFile(c.home); mkdirSync(dirname(logFile), { recursive: true });
      writeFileSync(plist, launchAgentPlist(entry, process.execPath, env, logFile));
      let loaded = false;
      if (a.flags.load) {
        const uid = process.getuid?.() ?? userInfo().uid;
        spawnSync('launchctl', ['bootout', `gui/${uid}/${AGENT_LABEL}`], { stdio: 'ignore' });
        loaded = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plist], { stdio: 'inherit' }).status === 0;
      }
      out({ ok: true, plist, loaded }, () => `Wrote ${plist}\n${loaded ? 'Loaded with launchctl.' : `Load it now with: launchctl bootstrap gui/$(id -u) "${plist}"  (or re-run with --load)`}\nThe daemon will start at login and keep running; devices with autoStart boot when it starts.`);
      return 0;
    }
    case 'uninstall-agent': {
      const plist = join(launchAgentsDir(), `${AGENT_LABEL}.plist`);
      const uid = process.getuid?.() ?? userInfo().uid;
      if (!process.env.PHONEDOCK_LAUNCH_AGENTS_DIR) spawnSync('launchctl', ['bootout', `gui/${uid}/${AGENT_LABEL}`], { stdio: 'ignore' });
      const existed = existsSync(plist); rmSync(plist, { force: true });
      out({ ok: true, plist, removed: existed }, () => existed ? `Removed ${plist}` : `No LaunchAgent at ${plist}`);
      return 0;
    }
    default: usage(`Unknown daemon subcommand "${sub}"`);
  }
}

export function parseSpec(a: ParsedArgs): DeviceSpec & { boot?: boolean } {
  const f = a.flags;
  const backend = str(f, 'backend'); const name = str(f, 'name') ?? a.positionals[1];
  if (!backend) usage('create needs --backend (see `phonedock backends`)');
  if (!name) usage('create needs --name');
  const spec: DeviceSpec & { boot?: boolean } = { backend, name };
  const s = (k: string, v: unknown) => { if (v !== undefined) (spec as unknown as Record<string, unknown>)[k] = v; };
  s('image', str(f, 'image')); s('profile', str(f, 'profile'));
  s('cpus', num(f, 'cpus')); s('ramMB', num(f, 'ram')); s('storageMB', num(f, 'storage'));
  s('width', num(f, 'width')); s('height', num(f, 'height')); s('dpi', num(f, 'dpi'));
  s('network', str(f, 'network')); s('autoStart', bool(f, 'autoStart')); s('headless', bool(f, 'headless'));
  s('boot', bool(f, 'boot'));
  const opts = str(f, 'options'); if (opts) { try { spec.options = JSON.parse(opts); } catch { usage('--options must be JSON'); } }
  const disguiseFlag = f.disguise;
  const carrierFlag = str(f, 'carrier');
  const seedFlag = str(f, 'seed');
  if (disguiseFlag !== undefined || carrierFlag !== undefined || seedFlag !== undefined) {
    if (disguiseFlag === false) {
      if (carrierFlag !== undefined || seedFlag !== undefined) usage('--carrier and --seed require --disguise');
    } else {
      const d: Record<string, unknown> = { enabled: true };
      if (typeof disguiseFlag === 'string') d.profile = disguiseFlag;
      if (carrierFlag !== undefined) d.carrier = carrierFlag;
      if (seedFlag !== undefined) d.seed = seedFlag;
      spec.options = { ...(spec.options ?? {}), disguise: d };
    }
  }
  if (f.slim !== undefined) {
    spec.options = { ...(spec.options ?? {}), slim: typeof f.slim === 'string' ? f.slim : f.slim !== false };
  }
  return spec;
}

function matchLine(m: ElementMatch): string {
  const t = m.text ?? m.label ?? m.value;
  return `${m.ref ?? 'ocr'} ${m.type.split('.').pop()}${t ? ` ${JSON.stringify(t)}` : ''}${m.id ? ` id=${m.id.replace(/^.*:id\//, '')}` : ''} @(${m.center.x},${m.center.y})${m.visible ? '' : ' [not visible]'}`;
}

function promptLine(pr: SystemPrompt): string {
  return `${pr.kind}${pr.needsHuman ? ' (NEEDS A HUMAN: use `phonedock handoff request`)' : ''}: ${pr.reason}${pr.buttons.length ? `\n  buttons: ${pr.buttons.map((b) => `[${b.text}]${b.role ? `(${b.role})` : ''}`).join(' ')}` : ''}`;
}

function wantWait(a: ParsedArgs): boolean { return !(a.flags.noWait === true || a.flags.wait === false); }

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const ch of process.stdin) chunks.push(ch as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function run(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  JSON_OUT = !!a.flags.json;
  const cmd = a.positionals[0]; CMD = cmd;
  if (!cmd || cmd === 'help' || (a.flags.help && !cmd)) { process.stdout.write(await helpText() + '\n'); return 0; }
  if (a.flags.help) { process.stdout.write(await helpText() + '\n'); return 0; }

  const owner = str(a.flags, 'owner') ?? process.env.PHONEDOCK_OWNER ?? `cli:${userInfo().username}`;
  const c = new PhoneDockClient({ owner, baseUrl: str(a.flags, 'url'), token: str(a.flags, 'token'), autoStart: a.flags.autoStartDaemon !== false,
    // A sleeping phone woke for this command (idle sleep): say so on stderr, so stdout stays the command's output.
    onWake: (w) => { if (!quietFlag(a)) process.stderr.write(`${wakeNoticeText(w)}\n`); } });
  const p = a.positionals;
  const quiet = !!a.flags.quiet;
  const dev = async (i = 1): Promise<Device> => { need(p, i + 1, '<device>'); return c.resolveDevice(p[i]); };

  switch (cmd) {
    case 'doctor': {
      const name = str(a.flags, 'device');
      if (name) out(await c.doctor({ device: (await c.resolveDevice(name)).id }));
      else { const { buildDoctorReport } = await import('../core/doctor.ts'); out(await buildDoctorReport()); }
      return 0;
    }
    case 'request-result': { const d = await dev(); if (!a.positionals[2]) usage('request-result needs a request ID'); out(await c.requestResult(d.id, a.positionals[2])); return 0; }
    case 'audit': { const d = await dev(); out(await c.auditUi(d.id, { includeOffscreen: !!a.flags.includeOffscreen })); return 0; }
    case 'environment': { const d = await dev(); out(await c.environment(d.id)); return 0; }
    case 'permissions': case 'biometric': case 'status-bar': case 'media': {
      const d = await dev(); let change: unknown;
      if (cmd === 'permissions') change = { action: 'permissions', appId: a.positionals[2], state: a.positionals[3], permissions: a.positionals.slice(4) };
      else if (cmd === 'biometric') change = { action: 'biometric', event: a.positionals[2], ...(str(a.flags, 'modality') ? { modality: str(a.flags, 'modality') } : {}), ...(num(a.flags, 'fingerId') !== undefined ? { fingerId: num(a.flags, 'fingerId') } : {}) };
      else if (cmd === 'media') change = { action: 'media', path: a.positionals[2] ? resolve(a.positionals[2]) : undefined };
      else change = { action: 'statusBar', mode: a.positionals[2] ?? 'override', ...(str(a.flags, 'time') ? { time: str(a.flags, 'time') } : {}),
        ...(num(a.flags, 'battery') !== undefined ? { batteryLevel: num(a.flags, 'battery') } : {}), ...(num(a.flags, 'wifi') !== undefined ? { wifiBars: num(a.flags, 'wifi') } : {}), ...(num(a.flags, 'cellular') !== undefined ? { cellularBars: num(a.flags, 'cellular') } : {}) };
      out(await c.setEnvironment(d.id, parseEnvironmentAction(change))); return 0;
    }
    case 'webview': {
      const d = await dev();
      const appId = a.positionals[2];
      if (!appId && d.backend !== 'ios-simulator') usage('webview needs the app package ID on Android');
      const selector = str(a.flags, 'measure') ?? str(a.flags, 'selector');
      const action = a.flags.network ? 'network' : selector ? 'measure' : 'snapshot';
      const values = str(a.flags, 'bounds')?.split(',').map(Number);
      if (values && (values.length !== 4 || !values.every(Number.isFinite))) usage('--bounds must be x,y,width,height in screenshot pixels');
      out(await c.inspectWebView(d.id, {
        ...(appId ? { appId } : {}),
        action,
        ...(selector ? { selector } : {}),
        targetId: str(a.flags, 'target'),
        captureMs: num(a.flags, 'captureMs'),
        maxElements: num(a.flags, 'maxElements'),
        ...(values ? { bounds: { x: values[0], y: values[1], width: values[2], height: values[3] } } : {}),
      })); return 0;
    }
    case 'setup': {
      const { setupCommand, parseAgents } = await import('./setup.ts');
      try { parseAgents(str(a.flags, 'agent')); } catch (e) { usage((e as Error).message); }
      if (a.flags.agent === true) usage('--agent needs a value: claude, codex, cursor, pi or all');
      return setupCommand(a.flags, JSON_OUT);
    }
    case 'daemon': return daemonCmd(c, a);
    case 'mcp': {
      const { startMcpServer } = await import('../mcp/server.ts');
      const port = num(a.flags, 'http');
      const profile = a.flags.compact ? 'runtime' : str(a.flags, 'profile') ?? 'all';
      if (profile !== 'all' && profile !== 'runtime') { process.stderr.write('MCP profile must be all or runtime\n'); return 2; }
      await startMcpServer({ http: port, client: c, ownerFromFlag: str(a.flags, 'owner'), profile });
      return -1; // keep running
    }
    case 'backends': {
      if (a.flags.debug) { const r = await c.backendsDebug(); out(r); return 0; }
      const list = await c.backends();
      out(list, () => table(list.map((b) => ({ id: b.id, name: b.displayName, platform: b.platform, kind: b.kind,
        available: b.availability?.ok ? 'yes' : 'no', detail: b.availability?.ok ? (b.availability.version ?? '') : (b.availability?.reason ?? '') })),
      ['id', 'name', 'platform', 'kind', 'available', 'detail']));
      return 0;
    }
    case 'components': {
      const fmtSize = (bytes?: number) => {
        if (bytes === undefined) return '';
        if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
        if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
        if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
        return `${bytes} B`;
      };
      if (p[1] === 'install') {
        const target = p[2];
        const ids = target
          ? [target]
          : (await c.components()).filter((x) => x.state !== 'ready' || x.updateAvailable).map((x) => x.id);
        if (!ids.length) {
          out({ ok: true, installed: [] }, () => 'All managed components are already up to date.');
          return 0;
        }
        const results: Job[] = [];
        for (const id of ids) {
          const job = await c.installComponent(id, { wait: wantWait(a), onProgress: progressPrinter(quiet) });
          results.push(job);
        }
        out(target ? results[0] : results, () => results.map((j, i) => `Component ${ids[i]}: ${j.state}`).join('\n'));
        return 0;
      }
      const list = await c.components();
      out(list, () => table(list.map((x) => {
        const ver = x.installedVersion && x.installedVersion !== x.pinnedVersion
          ? `${x.installedVersion} → ${x.pinnedVersion}`
          : (x.installedVersion ?? x.pinnedVersion);
        const detail = x.state === 'installing'
          ? `${x.progress?.phase ?? 'installing'}${x.progress?.percent !== undefined ? ` (${x.progress.percent}%)` : ''}`
          : x.state === 'failed'
            ? (x.error?.message ?? x.detail ?? 'failed')
            : x.updateAvailable
              ? `update available (${x.pinnedVersion})`
              : (x.detail ?? (x.source === 'override' ? 'env override' : ''));
        return {
          id: x.id,
          state: x.state,
          version: ver,
          source: x.source,
          size: fmtSize(x.sizeBytes ?? x.estimatedBytes),
          detail,
        };
      }), ['id', 'state', 'version', 'source', 'size', 'detail']));
      return 0;
    }
    case 'images': {
      if (p[1] === 'install') {
        need(p, 4, '<backend> <image>');
        const job = await c.installImage(p[2], p[3], { wait: wantWait(a), onProgress: progressPrinter(quiet) });
        out(job, () => `Image ${p[3]} for ${p[2]}: ${job.state}`);
        return 0;
      }
      const backends = p[1] ? [p[1]] : (await c.backends()).filter((b) => b.availability?.ok).map((b) => b.id);
      const all: OsImage[] = [];
      for (const b of backends) {
        try { all.push(...(await c.images(b))); } catch (e) { if (p[1]) throw e; }
      }
      out(all, () => table(all.map((i) => ({ backend: i.backend, id: i.id, name: i.name, installed: i.installed ? (i.usable === false ? 'yes, NOT USABLE' : 'yes') : 'no', size: i.sizeMB ? `${i.sizeMB}MB` : '' })),
        ['backend', 'id', 'name', 'installed', 'size'])
        + all.filter((i) => i.usable === false && i.notes).map((i) => `\n${i.name}: ${i.notes}`).join(''));
      return 0;
    }
    case 'profiles': {
      need(p, 2, '<backend>');
      const list = await c.profiles(p[1]);
      out(list, () => table(list.map((x) => ({ id: x.id, name: x.name, screen: x.width ? `${x.width}x${x.height}` : '', dpi: x.dpi, ram: x.ramMB })), ['id', 'name', 'screen', 'dpi', 'ram']));
      return 0;
    }
    case 'devices': case 'ls': case 'list': {
      const list = await c.devices({ backend: str(a.flags, 'backend'), platform: str(a.flags, 'platform'), state: str(a.flags, 'state') });
      out(list, () => devicesTable(list));
      return 0;
    }
    case 'show': case 'device': { const d = await dev(); out(d); return 0; }
    case 'idle-sleep': {
      // phonedock idle-sleep [off|10m|15m|30m|1h]: when idle virtual phones go to sleep (docs/API.md "Idle sleep").
      const st = p[1] ? await c.setIdleSleep(p[1]) : await c.idleSleep();
      out(st, () => idleSleepText(st));
      return 0;
    }
    case 'simslim': {
      const sub = p[1];
      if (!sub || sub === 'status') {
        const st = await c.simslim();
        out(st, () => `${st.enabled ? 'SimSlim is on' : 'SimSlim is off'} for PhoneDock-managed iOS simulators`
          + ` (${st.available ? `installed: ${st.version ?? st.binary}` : 'simslim not installed'})`
          + (st.profilePath ? `\n  profile: ${st.profilePath}` : `\n  kept categories: ${st.except.join(', ')}`)
          + (st.source === 'env' ? '\n  (overridden by PHONEDOCK_SIMSLIM_ENABLED)' : ''));
        return 0;
      }
      if (sub === 'on' || sub === 'off') {
        const except = str(a.flags, 'except')?.split(',').map((s) => s.trim()).filter(Boolean);
        const profilePath = str(a.flags, 'profile');
        const st = await c.setSimslim({ enabled: sub === 'on', ...(except ? { except } : {}), ...(profilePath ? { profilePath } : {}) });
        out(st, () => `SimSlim ${st.enabled ? 'enabled' : 'disabled'} for PhoneDock-managed iOS simulators.`);
        return 0;
      }
      const d = await c.resolveDevice(sub);
      const act = (p[2] ?? 'status') as 'status' | 'measure' | 'on' | 'off';
      if (!['status', 'measure', 'on', 'off'].includes(act)) usage('simslim <device> [status|measure|on|off]');
      const except = str(a.flags, 'except')?.split(',').map((s) => s.trim()).filter(Boolean);
      const profilePath = str(a.flags, 'profile');
      const r = await c.deviceSimslim(d.id, act, { ...(except ? { except } : {}), ...(profilePath ? { profilePath } : {}), noReboot: a.flags.noReboot === true });
      out(r, () => `${d.name}: ${r.slimmed ? 'slimmed' : 'stock'}`
        + (r.disabledCount !== undefined ? ` (${r.disabledCount}${r.managedTotal ? `/${r.managedTotal}` : ''} daemons disabled)` : '')
        + (r.footprintMB !== undefined ? `, ${r.footprintMB} MB` : '')
        + (r.processCount !== undefined ? `, ${r.processCount} processes` : ''));
      return 0;
    }
    case 'info': {
      const d = await dev(); const i = await c.info(d.id) as Record<string, any>;
      out(i, () => {
        const m = i.summary as Record<string, any> | undefined;
        if (!m) return JSON.stringify(i, null, 2);
        const sc = m.screen as { width: number; height: number; scale?: number; orientation?: string } | undefined;
        return [
          `${m.name}${m.model ? ` (${m.model})` : ''}`,
          `OS:           ${m.os ?? '?'}${m.build ? ` (build ${m.build})` : ''}`,
          `Screen:       ${sc ? `${sc.width}x${sc.height}${sc.scale ? ` @${sc.scale}x` : ''}${sc.orientation ? `, ${sc.orientation}` : ''}` : 'unknown'}`,
          `Connection:   ${m.connection ?? 'unknown'}${m.locked === true ? ', locked' : m.locked === false ? ', unlocked' : ''}${m.developerMode === false ? ', Developer Mode off' : ''}`,
          `Capabilities: ${d.capabilities.join(', ')}`,
          '(full detail: phonedock info <id> --json)',
        ].join('\n');
      });
      return 0;
    }
    case 'create': {
      const spec = parseSpec(a);
      if (!wantWait(a)) { const r = await c.createDeviceAsync(spec); out(r, () => `Creating ${spec.name}: job ${r.job.id}`); return 0; }
      const d = await c.createDevice(spec, { onProgress: progressPrinter(quiet) });
      out(d, () => `Created ${d.name} [${d.id}] (${d.state})`);
      return 0;
    }
    case 'boot': {
      const d = await dev();
      const slim = a.flags.slim === undefined ? undefined : (typeof a.flags.slim === 'string' ? a.flags.slim : a.flags.slim === true);
      const job = await c.boot(d.id, { window: a.flags.window === true, coldBoot: a.flags.cold === true, headless: a.flags.window === true ? false : undefined, ...(slim !== undefined ? { slim } : {}), wait: wantWait(a), onProgress: progressPrinter(quiet) });
      const woke = (job as { progress?: string[] } | undefined)?.progress?.findLast((l) => /^woke in /.test(l));
      out(job ?? { ok: true }, () => `${d.name}: ${wantWait(a) ? (woke ? (/started fresh/.test(woke) ? 'woke, started fresh (its previous screen is gone)' : 'woke where it left off') : 'booted') : `booting (job ${job?.id})`}`);
      return 0;
    }
    case 'shutdown': case 'stop': { const d = await dev(); out(await c.shutdown(d.id), () => `${d.name}: shut down`); return 0; }
    case 'rm': case 'delete': {
      const d = await dev();
      out(await c.deleteDevice(d.id, { force: a.flags.force === true }), () => `Deleted ${d.name} [${d.id}]`);
      return 0;
    }
    case 'clone': {
      const d = await dev(); need(p, 3, '<id> <newName>');
      const n = await c.clone(d.id, p[2], { wait: wantWait(a), onProgress: progressPrinter(quiet) });
      out(n, () => `Cloned ${d.name} → ${n.name} [${n.id}]`);
      return 0;
    }
    case 'window': { const d = await dev(); out(await c.openWindow(d.id), () => `Opened window for ${d.name}`); return 0; }
    case 'update': {
      const d = await dev();
      const patch: { name?: string; autoStart?: boolean } = {};
      if (str(a.flags, 'name')) patch.name = str(a.flags, 'name');
      const as = bool(a.flags, 'autoStart'); if (as !== undefined) patch.autoStart = as;
      const r = await c.updateDevice(d.id, patch);
      out(r, () => `Updated ${r.name} [${r.id}]`);
      return 0;
    }
    case 'snapshot': case 'snapshots': {
      const sub = ['ls', 'list', 'save', 'restore', 'rm', 'delete'].includes(p[1]) ? p[1] : 'ls';
      const off = sub === p[1] ? 2 : 1;
      need(p, off + 1, '<device>');
      const d = await c.resolveDevice(p[off]); const name = p[off + 1];
      if (sub === 'ls' || sub === 'list') {
        const list = await c.snapshots(d.id);
        out(list, () => table(list.map((s) => ({ name: s.name, created: s.createdAt, size: s.sizeMB ? `${s.sizeMB}MB` : '' })), ['name', 'created', 'size']));
        return 0;
      }
      if (!name) usage(`snapshot ${sub} needs a snapshot name`);
      const r = sub === 'save' ? await c.saveSnapshot(d.id, name) : sub === 'restore' ? await c.restoreSnapshot(d.id, name) : await c.deleteSnapshot(d.id, name);
      out(r, () => `${d.name}: snapshot ${name} ${sub === 'save' ? 'saved' : sub === 'restore' ? 'restored' : 'deleted'}`);
      return 0;
    }
    case 'screenshot': case 'shot': {
      const d = await dev();
      const fmt = (str(a.flags, 'format') as 'png' | 'jpeg' | undefined) ?? (/\.jpe?g$/i.test(str(a.flags, 'output') ?? '') ? 'jpeg' : undefined);
      const r = await c.screenshot(d.id, { format: fmt, maxSize: num(a.flags, 'maxSize'), quality: num(a.flags, 'quality') });
      const ext = r.mime.includes('jpeg') ? 'jpg' : 'png';
      let file = str(a.flags, 'output');
      if (file === '-' || (!file && !process.stdout.isTTY && !JSON_OUT)) { process.stdout.write(r.data); return 0; }
      file ??= `${d.name.replace(/[^\w.-]+/g, '_')}-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
      writeFileSync(file, r.data);
      const { data: _d, ...meta } = r;
      out({ file: resolve(file), bytes: r.data.length, ...meta }, () => `Saved ${file} (${r.imageWidth}x${r.imageHeight}; device ${r.deviceWidth}x${r.deviceHeight}; scale ${r.scale})`);
      return 0;
    }
    case 'ui': {
      const d = await dev();
      const ocr = a.flags.noOcr === true || a.flags.ocr === false ? false : undefined;
      if (JSON_OUT) { out(await c.ui(d.id, { ocrFallback: ocr })); return 0; }
      process.stdout.write((await c.uiText(d.id, { ocrFallback: ocr })).replace(/\n?$/, '\n'));
      return 0;
    }
    case 'tap': {
      if (str(a.flags, 'text') || str(a.flags, 'id') || str(a.flags, 'type')) {
        const d = await dev();
        const q = { text: str(a.flags, 'text'), id: str(a.flags, 'id'), type: str(a.flags, 'type'), match: str(a.flags, 'match') as 'exact' | undefined, index: num(a.flags, 'index') };
        const r = await c.find(d.id, q);
        if (!r.match) throw new PhoneDockApiError(`Nothing on screen matches`, 'no_match', 404, r.summary ? [`Screen now: ${r.summary}`] : []);
        const t = await c.tap(d.id, r.match.center.x, r.match.center.y, matchName(r.match), { ...tapMeta(q, r.match), expect: expectFlag(a.flags) });
        out({ ...r, delivery: t.delivery, retrySafe: t.retrySafe, ...(t.expect ? { expect: t.expect } : {}) }, () => withExpect(t, `tapped ${matchLine(r.match!)}${r.total > 1 ? `\n  (${r.total - 1} other match${r.total > 2 ? 'es' : ''}; --index N to pick: ${r.matches.filter((_m, i) => i !== r.index).slice(0, 4).map(matchLine).join('; ')})` : ''}`));
        return expectCode(t);
      }
      const d = await dev(); need(p, 3, '<x> <y> | @ref | --text T');
      const target = p[2];
      if (p.length === 3 || /^@?e\d+$/i.test(target)) {
        if (!/^@?\w+$/.test(target)) usage('tap needs <x> <y> or @ref');
        const r = await c.tapRef(d.id, target, { expect: expectFlag(a.flags) });
        out(r, () => withExpect(r, `tapped ${target}`)); return expectCode(r);
      }
      const x = toNum(p[2], 'x'); const y = toNum(p[3], 'y');
      const r = await c.tap(d.id, x, y, undefined, { expect: expectFlag(a.flags) });
      out(r, () => withExpect(r, `tapped (${x},${y})`)); return expectCode(r);
    }
    case 'long-press': case 'longpress': {
      const d = await dev(); need(p, 4, '<x> <y> [ms]');
      const x = toNum(p[2], 'x'); const y = toNum(p[3], 'y'); const ms = p[4] ? toNum(p[4], 'ms') : num(a.flags, 'duration');
      const r = await c.longPress(d.id, x, y, ms, { expect: expectFlag(a.flags) });
      out(r, () => withExpect(r, `long-pressed (${x},${y})`)); return expectCode(r);
    }
    case 'swipe': {
      const d = await dev(); need(p, 6, '<x1> <y1> <x2> <y2> [ms]');
      const [x1, y1, x2, y2] = p.slice(2, 6).map((v, i) => toNum(v, ['x1', 'y1', 'x2', 'y2'][i]));
      const ms = p[6] ? toNum(p[6], 'ms') : num(a.flags, 'duration');
      const r = await c.swipe(d.id, x1, y1, x2, y2, ms, { expect: expectFlag(a.flags) });
      out(r, () => withExpect(r, `swiped (${x1},${y1})→(${x2},${y2})`)); return expectCode(r);
    }
    case 'type': {
      const d = await dev();
      const text = [...p.slice(2), ...a.rest].join(' ');
      if (!text) usage('type needs <text>');
      const secret = a.flags.secret === true;
      const r = await c.type(d.id, text, { secret, expect: expectFlag(a.flags) });
      out(r, () => withExpect(r, `typed ${secret ? `${[...text].length} secret chars` : JSON.stringify(text)}`)); return expectCode(r);
    }
    case 'double-tap': case 'doubletap': {
      const d = await dev(); need(p, 4, '<x> <y>');
      const x = toNum(p[2], 'x'); const y = toNum(p[3], 'y');
      const r = await c.doubleTap(d.id, x, y, { expect: expectFlag(a.flags) });
      out(r, () => withExpect(r, `double-tapped (${x},${y})`)); return expectCode(r);
    }
    case 'pinch': {
      const d = await dev(); need(p, 5, '<x> <y> <scale> [ms]');
      const x = toNum(p[2], 'x'); const y = toNum(p[3], 'y'); const sc = toNum(p[4], 'scale'); const ms = p[5] ? toNum(p[5], 'ms') : undefined;
      out(await c.pinch(d.id, x, y, sc, ms), () => `pinched ×${sc} at (${x},${y})`); return 0;
    }
    case 'hide-keyboard': { const d = await dev(); out(await c.hideKeyboard(d.id), () => `${d.name}: keyboard hidden`); return 0; }
    case 'find': {
      const d = await dev();
      const text = p.slice(2).join(' ') || str(a.flags, 'text');
      const r = await c.find(d.id, { text, id: str(a.flags, 'id'), type: str(a.flags, 'type'), match: str(a.flags, 'match') as 'exact' | undefined, index: num(a.flags, 'index'), ocrFallback: a.flags.noOcr === true || a.flags.ocr === false ? false : undefined, limit: num(a.flags, 'limit') });
      out(r, () => r.total ? `${r.total} match${r.total > 1 ? 'es' : ''} (${r.source}; device px; best first):\n${r.matches.map((m, i) => `  [${i}] ${matchLine(m)}  score=${m.score}`).join('\n')}` : `No match. Screen now: ${r.summary ?? '?'}`);
      return r.total ? 0 : 1;
    }
    case 'focus': {
      const d = await dev();
      // --timeout MS (like wait-for); --wait=MS also works (plain --wait is the global wait-for-job switch)
      const r = await c.focus(d.id, { waitMs: num(a.flags, 'timeout') ?? (typeof a.flags.wait === 'string' ? num(a.flags, 'wait') : undefined) });
      out(r, () => !r.known ? `unknown (${r.reason ?? 'no UI tree'})` : r.focused ? `focused: ${matchLine(r.focused)}${r.keyboard ? ' (keyboard up)' : ''}` : r.keyboard ? 'keyboard up (focused field not reported)' : 'nothing focused, no keyboard');
      return 0;
    }
    case 'wait-for': case 'waitfor': {
      const d = await dev(); need(p, 3, 'visible|gone|idle');
      const until = p[2] as 'visible' | 'gone' | 'idle';
      if (!['visible', 'gone', 'idle'].includes(until)) usage('wait-for needs visible|gone|idle');
      const text = p.slice(3).join(' ') || str(a.flags, 'text');
      const r = await c.waitFor(d.id, { until, text, id: str(a.flags, 'id'), type: str(a.flags, 'type'), match: str(a.flags, 'match') as 'exact' | undefined, timeoutMs: num(a.flags, 'timeout'), intervalMs: num(a.flags, 'interval'), stableMs: num(a.flags, 'stable') });
      out(r, () => until === 'idle' ? `idle after ${r.elapsedMs} ms (${r.changes} changes${r.changedRegion ? `, region ${JSON.stringify(r.changedRegion)}` : ''})` : `${until} after ${r.elapsedMs} ms${r.match ? `: ${matchLine(r.match)}` : ''}`);
      return 0;
    }
    case 'fill': {
      const d = await dev(); need(p, 3, '<value>');
      const value = p.slice(2).join(' ');
      const at = str(a.flags, 'at');
      const xy = at ? at.split(/[ ,]+/).map((v) => toNum(v, '--at')) : undefined;
      const ref = str(a.flags, 'ref'); const text = str(a.flags, 'text'); const id = str(a.flags, 'id'); const type = str(a.flags, 'type');
      if (!ref && !text && !id && !type && !xy) usage('fill needs --text T, --ref e12, --id ID or --at X,Y');
      const r = await c.fill(d.id, { value, ref: ref?.replace(/^@/, ''), text, id, type, match: str(a.flags, 'match') as 'exact' | undefined, index: num(a.flags, 'index'), x: xy?.[0], y: xy?.[1], clear: a.flags.clear !== false, submit: a.flags.submit === true, secret: a.flags.secret === true, expect: expectFlag(a.flags) });
      out(r, () => withExpect(r, `filled ${r.element ? matchLine(r.element) : `(${r.tapped.x},${r.tapped.y})`}${r.finalValue === undefined ? ': typed (value not verified)' : `: now ${a.flags.secret === true ? `${r.finalLength ?? '?'} hidden chars` : JSON.stringify(r.finalValue)}`}${r.verified ? ' (verified)' : r.verified === false ? ' (MISMATCH)' : ''}${r.clearMethod ? ` [clear: ${r.clearMethod}]` : ''} ${r.elapsedMs} ms${r.warnings.length ? `\n  warning: ${r.warnings.join('\n  warning: ')}` : ''}`));
      return r.verified === false ? 1 : expectCode(r);
    }
    case 'scroll-to': case 'scrollto': {
      const d = await dev();
      const text = p.slice(2).join(' ') || str(a.flags, 'text');
      if (!text && !str(a.flags, 'id')) usage('scroll-to needs <text>');
      const dir = str(a.flags, 'direction') ?? 'down';
      if (!['up', 'down', 'left', 'right'].includes(dir)) usage('--direction must be up|down|left|right');
      const at = str(a.flags, 'at'); const xy = at ? at.split(/[ ,]+/).map((v) => toNum(v, '--at')) : undefined;
      const r = await c.scrollTo(d.id, text ?? '', { id: str(a.flags, 'id'), type: str(a.flags, 'type'), match: str(a.flags, 'match') as 'exact' | undefined, direction: dir as 'down',
        maxScrolls: num(a.flags, 'max') ?? num(a.flags, 'maxScrolls'), x: xy?.[0], y: xy?.[1], durationMs: num(a.flags, 'duration'), ocrFallback: a.flags.noOcr === true || a.flags.ocr === false ? false : undefined });
      out(r, () => r.found && r.element
        ? `found ${matchLine(r.element)} after ${r.scrolls} scroll${r.scrolls === 1 ? '' : 's'} (${r.source}, ${r.elapsedMs} ms)${r.note ? ` – ${r.note}` : ''}`
        : `${r.reason} after ${r.scrolls} scroll${r.scrolls === 1 ? '' : 's'} (${r.elapsedMs} ms). Screen now: ${r.summary ?? '?'}`);
      return r.found ? 0 : 1;
    }
    case 'back': { const d = await dev(); const r = await c.goBack(d.id); out(r, () => `${d.name}: back via ${r.method}${r.tapped ? ` (${r.tapped.ref ?? ''} "${r.tapped.text ?? ''}")` : ''}`); return 0; }
    case 'gesture': {
      const d = await dev(); need(p, 3, 'go_home|app_switcher|control_center|notification_center');
      const r = await c.systemGesture(d.id, p[2].replace(/-/g, '_') as SystemGesture);
      out(r, () => `${d.name}: ${r.gesture} via ${r.method} (${r.elapsedMs} ms)`); return 0;
    }
    case 'alert': case 'prompt': {
      const d = await dev();
      const act = p.slice(2).join(' ').trim();
      const ocr = a.flags.noOcr === true || a.flags.ocr === false ? false : undefined;
      if (!act) {
        const r = await c.prompt(d.id, { ocrFallback: ocr });
        out(r, () => r.prompt ? promptLine(r.prompt) : `no system prompt on screen (${r.source ?? 'no UI'}${r.summary ? `; screen: ${r.summary}` : ''})`);
        return r.prompt ? 0 : 1;
      }
      const m = /^button(?:\s*=\s*|\s+)(.+)$/is.exec(act);
      const action = m ? { button: m[1].trim() } : act;
      if (!m && action !== 'accept' && action !== 'dismiss') usage('alert <id> [accept|dismiss|button <label>]');
      const r = await c.handleAlert(d.id, action as 'accept', { ocrFallback: ocr });
      out(r, () => `tapped [${r.tapped.text}] on ${r.prompt.kind}: ${r.prompt.reason}${r.dismissed === true ? ' → gone' : r.dismissed === false ? ' → STILL ON SCREEN' : ''}${r.after ? `\n  now: ${promptLine(r.after)}` : ''} (${r.elapsedMs} ms)`);
      return 0;
    }
    case 'foreground': {
      const d = await dev(); const app = await c.foregroundApp(d.id);
      out({ app }, () => app ? `${app.id}${app.name ? ` (${app.name})` : ''}` : '(home screen / none)'); return 0;
    }
    case 'crashes': case 'crash': {
      const d = await dev();
      if (p[2]) { const r = await c.crash(d.id, p[2], { full: a.flags.full === true }); out(r, () => r.text); return 0; }
      const since = str(a.flags, 'since'); const rel = since?.match(/^(\d+)\s*([smhd])$/i);
      const sinceIso = rel ? new Date(Date.now() - Number(rel[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[rel[2].toLowerCase() as 's']).toISOString() : since;
      const list = await c.crashes(d.id, { appId: str(a.flags, 'app'), since: sinceIso, limit: num(a.flags, 'limit') });
      out(list, () => table(list.map((x) => ({ id: x.id, time: x.time ? localTime(x.time) : '', app: x.appId ?? x.process, kind: x.kind, summary: x.summary })), ['id', 'time', 'app', 'kind', 'summary']));
      return 0;
    }
    case 'record': case 'recording': {
      const d = await dev(); const sub = p[2] ?? 'status';
      if (sub === 'start') { const r = await c.startRecording(d.id, { maxSeconds: num(a.flags, 'max') }); out(r, () => `recording → ${r.path} (auto-stop ${r.maxSeconds}s)`); return 0; }
      if (sub === 'stop') { const r = await c.stopRecording(d.id); out(r, () => `saved ${r.path} (${r.sizeBytes} bytes, ${r.durationSec}s)${r.warning ? ` – ${r.warning}` : ''}`); return 0; }
      if (sub !== 'status') usage('record <id> start|stop|status');
      const r = await c.recording(d.id); out(r, () => r.active ? `recording since ${r.startedAt} → ${r.path}` : 'not recording'); return 0;
    }
    case 'appdata': case 'app-data': {
      const d = await dev(); need(p, 4, 'save|restore|ls <appId> [name]');
      const sub = p[2]; const appId = p[3]; const name = p[4];
      if (sub === 'ls' || sub === 'list') { const l = await c.appData(d.id, appId); out(l, () => table(l.map((x) => ({ name: x.name, saved: x.savedAt, size: x.sizeBytes, files: x.files, path: x.path })), ['name', 'saved', 'size', 'files', 'path'])); return 0; }
      if (!name) usage(`appdata ${sub} needs a name`);
      if (sub === 'save' || sub === 'export') { const r = await c.exportAppData(d.id, appId, name); out(r, () => `saved ${appId} data as "${name}" → ${r.path} (${r.sizeBytes} bytes, ${r.files} files)`); return 0; }
      if (sub === 'restore' || sub === 'import') { const r = await c.importAppData(d.id, appId, name); out(r, () => `restored ${appId} data "${name}"`); return 0; }
      usage('appdata <id> save|restore|ls <appId> [name]');
    }
    case 'app-notes': case 'notes': {
      const sub = p[1] ?? 'list'; const appId = p[2];
      if (sub === 'list' || sub === 'ls') {
        const l = await c.listAppNotes();
        out(l, () => l.length ? table(l.map((n) => ({ app: n.appId, updated: localTime(n.updatedAt), bytes: n.sizeBytes })), ['app', 'updated', 'bytes']) : 'No app notes yet.');
        return 0;
      }
      if (sub === 'path') { const path = appId ? appNotesPath(checkAppId(appId)) : appNotesDir(); out({ path }, () => path); return 0; }
      if (!appId) usage(`app-notes ${sub} needs an app id (bundle ID or package name): ${NOTES_USAGE}`);
      if (sub === 'show' || sub === 'read' || sub === 'cat') {
        const r = await c.appNotes(appId);
        if (JSON_OUT) { out(r); return 0; }
        if (r.notes === null) { process.stderr.write(`No notes yet for ${appId}. After a task, save what you learned: phonedock app-notes save ${appId} --file notes.md\n`); return 0; }
        process.stdout.write(r.notes.endsWith('\n') ? r.notes : `${r.notes}\n`);   // as saved, so it pipes into a file
        return 0;
      }
      if (sub === 'save' || sub === 'set') {
        const file = str(a.flags, 'file');
        if (!file && process.stdin.isTTY) usage('app-notes save <appId> needs --file FILE, or the notes piped in on stdin');
        const r = await c.saveAppNotes(appId, file ? readFileSync(resolve(file), 'utf8') : await readStdin());
        out(r, () => `Saved ${r.created ? 'new ' : ''}notes for ${appId} (${r.sizeBytes} bytes) → ${r.path}`);
        return 0;
      }
      if (sub === 'rm' || sub === 'delete') {
        const r = await c.deleteAppNotes(appId);
        out(r, () => (r.deleted ? `Deleted the notes for ${appId}` : `No notes for ${appId}: nothing to delete`));
        return 0;
      }
      usage(NOTES_USAGE);
    }
    case 'handoff': case 'handoffs': {
      const sub = p[1] ?? 'ls';
      const fmt = (h: Handoff) => `${h.id}  ${h.state.padEnd(9)} ${h.deviceId}  "${h.reason}"  by ${h.requestedBy}${h.note ? `  note="${h.note}"` : ''}`
        + (h.state === 'pending' ? '' : h.leaseReturned ? `  (lease handed back to ${h.requestedBy})` : h.leaseHolder !== undefined ? `  (lease: ${h.leaseHolder ?? 'free'})` : '');
      // what to do about a pending one (blind run: `handoff show` printed the request but not how to answer it)
      const todo = (h: Handoff) => h.state !== 'pending' ? '' : `\n  Do it on the device (as the person: --owner app:human, no lease needed), then: phonedock handoff done ${h.id} [--note "…"]   (or: phonedock handoff cancel ${h.id})`;
      if (sub === 'ls' || sub === 'list') {
        // pending by default: resolved ones carry old lease owners and read like current requests
        const st = a.flags.all ? undefined : (str(a.flags, 'state') ?? 'pending') as HandoffState;
        const l = await c.handoffs({ state: st });
        out(l, () => l.length ? l.map(fmt).join('\n') : st === 'pending' ? '(none pending; --all lists resolved ones too)' : '(none)'); return 0;
      }
      if (sub === 'request') {
        need(p, 4, '<device> <reason…>');
        const d = await c.resolveDevice(p[2]);
        const h = await c.requestHandoff(d.id, p.slice(3).join(' '), { timeoutSec: num(a.flags, 'timeout') });
        if (!a.flags.wait) { out(h, () => `requested ${h.id} on ${d.name} (expires ${h.expiresAt})`); return 0; }
        const f = await c.waitHandoff(h.id, { onWait: (_h, ms) => { if (!JSON_OUT && !quiet) process.stderr.write(`  waiting for a human… ${Math.round(ms / 1000)}s\n`); } });
        out(f, () => fmt(f)); return f.state === 'done' ? 0 : 1;
      }
      if (sub === 'show' || sub === 'wait') {
        need(p, 3, '<handoffId>');
        const h = sub === 'wait' ? await c.waitHandoff(p[2]) : await c.handoff(p[2]);
        out(h, () => fmt(h) + todo(h)); return 0;
      }
      if (sub === 'resolve' || sub === 'done' || sub === 'cancel') {
        need(p, 3, '<handoffId>');
        const state = sub === 'done' ? 'done' : sub === 'cancel' ? 'cancelled' : p[3];
        if (state !== 'done' && state !== 'cancelled') usage('handoff resolve <hid> done|cancelled [--note N]');
        const h = await c.resolveHandoff(p[2], state, str(a.flags, 'note'));
        out(h, () => fmt(h)); return 0;
      }
      usage('handoff request|ls|show|wait|resolve|done|cancel');
    }
    case 'key': case 'press': {
      const d = await dev(); need(p, 3, '<key>');
      const r = await c.key(d.id, p[2], { expect: expectFlag(a.flags) });
      out(r, () => withExpect(r, `pressed ${p[2]}`)); return expectCode(r);
    }
    case 'input': {
      const d = await dev(); need(p, 3, "'<json action or array>'");
      const parsed = JSON.parse(p[2]) as InputAction | InputAction[];
      const r = await c.input(d.id, parsed, { expect: expectFlag(a.flags) });
      out(r); return expectCode(r);
    }
    case 'apps': {
      const d = await dev();
      const list = await c.apps(d.id, { system: a.flags.system === true });
      out(list, () => table(list.map((x) => ({ id: x.id, name: x.name, version: x.version, system: x.system ? 'yes' : '' })), ['id', 'name', 'version', 'system']));
      return 0;
    }
    case 'install': {
      const d = await dev(); need(p, 3, '<path|url>');
      const src = /^https?:\/\//i.test(p[2]) ? p[2] : resolve(p[2]);
      const r = await c.install(d.id, src);
      out(r, () => `Installed ${r.app?.id ?? src} on ${d.name}`); return 0;
    }
    case 'uninstall': { const d = await dev(); need(p, 3, '<appId>'); out(await c.uninstall(d.id, p[2]), () => `Uninstalled ${p[2]}`); return 0; }
    case 'launch': {
      const d = await dev(); need(p, 3, '<appId>');
      const { args, env } = parseLaunchFlags(argv, a);
      const launchOpts = { ...(args !== undefined ? { args } : {}), ...(env !== undefined ? { env } : {}) };
      const r = await c.launch(d.id, p[2], { expect: expectFlag(a.flags), ...launchOpts });
      const notes = r.appNotes ? `\nPhoneDock has notes for ${p[2]}: phonedock app-notes show ${p[2]}` : '';
      out(r, () => withExpect(r, `Launched ${p[2]}${launchSummarySuffix(launchOpts)}${r.inFront === false ? ` (not in front: ${r.foreground ?? 'home screen'})` : ''}${notes}`)); return expectCode(r);
    }
    case 'terminate': case 'kill': { const d = await dev(); need(p, 3, '<appId>'); out(await c.terminate(d.id, p[2]), () => `Terminated ${p[2]}`); return 0; }
    case 'open-url': case 'open': { const d = await dev(); need(p, 3, '<url>'); out(await c.openUrl(d.id, p[2]), () => `Opened ${p[2]}`); return 0; }
    case 'settings': {
      need(p, 2, 'settings <id> [key=value ...]');
      const d = await c.resolveDevice(p[1]);
      if (a.flags.reset) { if (p.length > 2) usage('--reset cannot be combined with settings'); out(await c.resetSettings(d.id)); return 0; }
      if (p.length === 2) { out(await c.settings(d.id)); return 0; }
      const patch: Record<string, unknown> = {};
      for (const arg of p.slice(2)) {
        const i = arg.indexOf('='); if (i < 1) usage('settings expects key=value');
        const key = arg.slice(0, i), value = arg.slice(i + 1);
        patch[key] = value === 'true' ? true : value === 'false' ? false : key === 'textSize' && value.trim() && Number.isFinite(Number(value)) ? Number(value) : value;
      }
      out(await c.setSettings(d.id, patch)); return 0;
    }
    case 'appearance': case 'dark-mode': {
      const d = await dev();
      const mode = p[2]?.toLowerCase();
      if (!mode) { const r = await c.appearance(d.id); out(r, () => `${d.name}: ${r.appearance}`); return 0; }
      if (mode !== 'dark' && mode !== 'light') usage('appearance <id> [dark|light]');
      const r = await c.setAppearance(d.id, mode as 'dark' | 'light');
      out(r, () => `${d.name}: appearance ${r.appearance}${r.changed ? ` (was ${r.previous})` : ' (unchanged)'}`);
      return 0;
    }
    case 'clipboard': case 'clip': {
      const d = await dev();
      if (p.length > 2) usage('clipboard <id> [--get | --set TEXT]: quote the text (--set "two words"), or pipe it in with --set alone');
      const set = a.flags.set;
      if (set !== undefined && set !== false) {
        if (a.flags.get === true) usage('clipboard takes --get or --set, not both');
        if (set === true && process.stdin.isTTY) usage('--set needs TEXT, or the text piped in on stdin');
        const text = typeof set === 'string' ? set : await readStdin();
        const r = await c.setClipboard(d.id, text);
        out(r, () => `${d.name}: clipboard set (${r.length} character${r.length === 1 ? '' : 's'})`);
        return 0;
      }
      const text = await c.getClipboard(d.id);
      if (JSON_OUT) { out({ text }); return 0; }
      if (text === null) { if (!quiet) process.stderr.write(`${d.name}: the clipboard is empty or holds no text\n`); return 0; }
      // exactly the clipboard's text, so it pipes into files and other commands unchanged
      process.stdout.write(text + (process.stdout.isTTY && !text.endsWith('\n') ? '\n' : ''));
      return 0;
    }
    case 'shell': {
      const d = await dev();
      const command = (a.rest.length ? a.rest : p.slice(2)).join(' ');
      if (!command) usage('shell needs a command: phonedock shell <id> -- <cmd…>');
      const r = await c.shell(d.id, command);
      if (JSON_OUT) { out(r); return r.code; }
      if (r.stdout) process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
      return r.code ?? 0;
    }
    case 'push': {
      const d = await dev(); need(p, 4, '<local> <remote>');
      out(await c.pushFile(d.id, resolve(p[2]), p[3]), () => `Pushed ${p[2]} → ${p[3]}`); return 0;
    }
    case 'pull': {
      const d = await dev(); need(p, 3, '<remote> [local]');
      const local = resolve(p[3] ?? p[2].split('/').pop() ?? 'pulled');
      out(await c.pullFile(d.id, p[2], local), () => `Pulled ${p[2]} → ${local}`); return 0;
    }
    case 'logs': {
      const d = await dev();
      const text = await c.logs(d.id, { lines: num(a.flags, 'lines'), filter: str(a.flags, 'filter') });
      out({ text }, () => text); return 0;
    }
    case 'location': {
      const d = await dev();
      if (a.flags.stop === true) {
        const r = await c.stopLocationRoute(d.id);
        out(r, () => r.stopped ? `Stopped location route on ${d.name}` : `Cleared location on ${d.name}`);
        return 0;
      }
      const gpxPath = str(a.flags, 'gpx');
      if (gpxPath) {
        const gpx = readBoundedGpxFile(resolve(gpxPath));
        const speedMps = num(a.flags, 'speed');
        const r = await c.startLocationRoute(d.id, { gpx, ...(speedMps !== undefined ? { speedMps } : {}), loop: a.flags.loop === true });
        out(r, () => `Started GPX route on ${d.name} (${r.route.waypoints} waypoints at ${r.route.speedMps} m/s${r.route.loop ? ', looping' : ''})`);
        return 0;
      }
      if (p.length < 4) {
        const st = await c.locationRoute(d.id);
        out(st, () => st.active ? `Active route on ${d.name}: waypoint ${st.index + 1}/${st.waypoints} at ${st.speedMps} m/s` : `No active location route on ${d.name}. Pass <lat> <lon> or --gpx <file>.`);
        return 0;
      }
      const lat = toNum(p[2], 'lat'); const lon = toNum(p[3], 'lon');
      out(await c.setLocation(d.id, lat, lon), () => `Location set to ${lat},${lon}`); return 0;
    }
    case 'rotate': {
      const d = await dev(); need(p, 3, 'portrait|landscape');
      if (p[2] !== 'portrait' && p[2] !== 'landscape') usage('orientation must be portrait or landscape');
      const r = await c.rotate(d.id, p[2]);
      out(r, () => r.orientation && r.orientation !== p[2] ? `Stayed in ${r.orientation}: ${r.note ?? ''}`.trim() : `Rotated to ${p[2]}${r.screen ? ` (${r.screen.width}x${r.screen.height})` : ''}`); return 0;
    }
    case 'notify': {
      const d = await dev(); need(p, 4, "<appId> '<json payload>'");
      out(await c.pushNotification(d.id, p[2], JSON.parse(p[3])), () => `Sent push to ${p[2]}`); return 0;
    }
    case 'lease': {
      const d = await dev();
      const l = await c.lease(d.id, { ttlSec: num(a.flags, 'ttl'), force: a.flags.force === true });
      out(l, () => `${d.name} leased by ${l.owner}${l.expiresAt ? ` until ${l.expiresAt}` : ''}`); return 0;
    }
    case 'release': {
      const d = await dev();
      const r = a.flags.pool ? await c.release(d.id) : await c.releaseLease(d.id);
      out(r, () => r.released === false ? `${d.name}: nothing to release. ${r.note ?? ''}`.trim() : `${d.name} released`); return 0;
    }
    case 'acquire': {
      const r = await c.acquire({ platform: str(a.flags, 'platform') as Device['platform'] | undefined, backend: str(a.flags, 'backend'), ttlSec: num(a.flags, 'ttl') });
      out(r, () => `Acquired ${r.device.name} [${r.device.id}] (${r.device.state}) as ${r.lease?.owner ?? owner}`); return 0;
    }
    case 'connect': {
      if (a.flags.ios !== undefined) {
        const target = typeof a.flags.ios === 'string' ? a.flags.ios : p[1];
        if (!target) usage('Missing argument: --ios <ip|wda-url>');
        const r = await c.connectIos(target, { name: str(a.flags, 'name'), udid: str(a.flags, 'udid') });
        out(r, () => `Connected iPhone via WebDriverAgent ${r.wdaUrl}${r.device ? ` → ${r.device.name} [${r.device.id}] (${r.device.state})` : ''}`); return 0;
      }
      const r = await c.connect(p[1], { serial: str(a.flags, 'serial'), restartAdb: a.flags.restartAdb === true });
      out(r, () => `Connected${p[1] ? ` ${p[1]}` : ''}${r.device ? ` → ${r.device.name} [${r.device.id}] (${r.device.state})` : ''}`); return 0;
    }
    case 'disconnect': {
      need(p, 2, '<id>');
      let id = p[1];
      if (!id.includes(':')) id = (await c.resolveDevice(id)).id;
      out(await c.disconnect(id), () => `Disconnected ${id}`); return 0;
    }
    case 'discover': {
      if (a.flags.android === true) {
        const list = await c.discoverAndroid();
        out(list, () => list.length ? table(list.map((x) => ({ model: x.model ?? '', serial: x.serial, ip: x.ip ?? '', connect: x.connectPort ?? '', pairing: x.pairingPort ?? '', status: x.connected ? 'connected' : x.pairingPort ? 'ready to pair' : '' })), ['model', 'serial', 'ip', 'connect', 'pairing', 'status'])
          : 'No Android phones found. Turn on Wireless debugging on the phone (Settings › Developer options), on the same Wi-Fi as this Mac.');
        return 0;
      }
      const list = await c.discoverIos();
      out(list, () => list.length ? table(list.map((d) => ({ name: d.name, host: d.host ?? '', udid: d.udid ?? '', source: d.source + (d.service ? ` ${d.service}` : '') })), ['name', 'host', 'udid', 'source']) : 'No iPhones found on the network (Bonjour / devicectl). If WebDriverAgent is running: phonedock connect --ios <ip>');
      return 0;
    }
    case 'ios': {
      if (p[1] === 'wda-teams') {
        const r = await c.wdaTeams();
        out(r, () => !r.xcode ? 'Xcode isn’t installed (or xcode-select points at the Command Line Tools).'
          : r.teams.length ? table(r.teams.map((t) => ({ team: t.id, name: t.name, kind: t.free ? 'personal (free)' : t.type ?? '' })), ['team', 'name', 'kind'])
          : 'Xcode isn’t signed in to any team. Add your Apple ID in Xcode › Settings › Accounts, or pass an App Store Connect API key to `ios wda-setup`.');
        return 0;
      }
      if (p[1] === 'wda-stop') {
        const udid = str(a.flags, 'udid') ?? p[2]; if (!udid) usage('Missing --udid <id>');
        const r = await c.wdaStop(udid);
        out(r, () => `${r.stopped ? `Stopped control on ${udid}` : `No WebDriverAgent was running on ${udid}`}.${r.confirmed ? ' None is left on the iPhone.' : ' PhoneDock couldn’t confirm the iPhone has none left (is it connected?): run it again.'} \`phonedock ios wda-setup --udid ${udid}\` starts it again.`);
        return r.confirmed ? 0 : 1;
      }
      if (p[1] !== 'wda-setup') usage('Usage: phonedock ios wda-setup --udid <id> [--team <TEAMID>] [--share] [--api-key-path P --api-key-id K --api-key-issuer I] | phonedock ios wda-stop --udid <id> | phonedock ios wda-teams');
      const udid = str(a.flags, 'udid') ?? p[2]; if (!udid) usage('Missing --udid <id>');
      const job = await c.wdaSetup(udid, {
        team: str(a.flags, 'team'), destination: str(a.flags, 'destination'), name: str(a.flags, 'name'),
        apiKeyPath: str(a.flags, 'apiKeyPath'), apiKeyId: str(a.flags, 'apiKeyId'), apiKeyIssuerId: str(a.flags, 'apiKeyIssuer') ?? str(a.flags, 'apiKeyIssuerId'),
        ...(a.flags.share === true || a.flags.share === 'true' ? { share: true } : {}),
        wait: wantWait(a), onProgress: progressPrinter(quiet),
      });
      out(job, () => job.state === 'done' ? setupDoneText(job.result)
        : `wda-setup ${job.state} (job ${job.id})${job.error ? `: ${jobErrorText(job.error)}` : ''}`);
      return job.state === 'failed' ? 1 : 0;
    }
    case 'pair': {
      const restartAdb = a.flags.restartAdb === true;
      if (p.length === 2) {   // pair <code>: find the phone showing its pairing screen, pair, connect
        const r = await c.pairWithCode(p[1], { serial: str(a.flags, 'serial'), restartAdb });
        out(r, () => `Paired and connected${r.device ? ` → ${r.device.name} [${r.device.id}] (${r.device.state})` : ''}`); return 0;
      }
      need(p, 3, '<code>  or  <host:port> <code>'); out(await c.pair(p[1], p[2], { restartAdb }), () => `Paired with ${p[1]}. Now: phonedock connect <host:port>`); return 0;
    }
    case 'actions': {
      const d = await dev();
      const list = await c.actions(d.id, { limit: num(a.flags, 'limit') });
      out(list, () => list.map((r) => `${r.at}  ${r.owner ?? ''}  ${JSON.stringify(r.action)}`).join('\n') || '(none)'); return 0;
    }
    case 'replay': {
      const d = await dev(); need(p, 3, '<file.json>');
      const raw = JSON.parse(readFileSync(p[2], 'utf8'));
      const list = Array.isArray(raw) ? raw : raw.actions;
      if (!Array.isArray(list)) usage('replay file must be a JSON array of actions or { actions: [...] }');
      const actions = list.map((x: { action: unknown; delayMs?: number }) => (x && typeof x.action === 'object' ? { ...(x.action as object), delayMs: x.delayMs } : x)) as (InputAction & { delayMs?: number })[];
      const job = await c.replay(d.id, actions, { wait: wantWait(a), onProgress: progressPrinter(quiet) });
      out(job, () => `Replay ${job.state ?? 'started'} (${actions.length} actions)`); return 0;
    }
    case 'jobs': case 'job': {
      if (p[1]) { const j = await c.job(p[1]); out(j, () => `${j.id} ${j.kind} ${j.state}${j.error ? ` – ${jobErrorText(j.error)}` : ''}\n${(j.progress ?? []).slice(-20).join('\n')}`); return 0; }
      const list = await c.jobs();
      out(list, () => table(list.map((j: Job) => ({ id: j.id, kind: j.kind, state: j.state, started: j.startedAt, error: jobErrorText(j.error) })), ['id', 'kind', 'state', 'started', 'error'])); return 0;
    }
    case 'watch': case 'events': {
      const ac = new AbortController();
      process.on('SIGINT', () => { ac.abort(); process.exit(0); });
      for await (const ev of c.events({ signal: ac.signal })) {
        if (JSON_OUT) { process.stdout.write(JSON.stringify(ev) + '\n'); continue; }
        const d = ev.data ?? {};
        const summary = ev.event === 'device' ? `${d.name ?? ''} [${d.id ?? ''}] ${d.state ?? ''}`
          : ev.event === 'job' ? `${d.id ?? ''} ${d.kind ?? ''} ${d.state ?? ''} ${(d.progress ?? []).slice(-1)[0] ?? ''}`
          : JSON.stringify(d);
        process.stdout.write(`${new Date().toISOString()}  ${ev.event.padEnd(6)}  ${summary}\n`);
      }
      return 0;
    }
    case 'home': out({ home: phonedockHome() }, () => phonedockHome()); return 0;
    case 'flow': case 'flows': {
      const { flowCmd } = await import('./flow-cmds.ts'); return flowCmd(c, a, argv, JSON_OUT);
    }
    case 'test': {
      const { testCmd } = await import('./flow-cmds.ts'); return testCmd(c, a, argv, JSON_OUT);
    }
    case 'run': case 'runs': {
      const { runsCmd } = await import('./runs-cmds.ts'); return runsCmd(c, a, JSON_OUT);
    }
    case 'trace': case 'perf': {
      const { traceCmd } = await import('./trace-cmds.ts'); return traceCmd(c, a, JSON_OUT);
    }
    case 'proxy': case 'proxies': {
      const { proxyCmd } = await import('./proxy-cmds.ts'); return proxyCmd(c, a, JSON_OUT);
    }
    default: usage(`Unknown command "${cmd}". Run \`phonedock help\`.`);
  }
}

/** Hints for terminal users: the daemon's, minus raw HTTP routes, plus the CLI way to take a leased device over. */
export function cliHints(e: PhoneDockApiError, cmd = CMD): string[] {
  const hints = (e.hints ?? []).filter((h) => !/\/v1\//.test(h));
  if (e.code === 'lease_conflict') {
    const id = /Device (\S+) is leased by/.exec(e.detail ?? '')?.[1];
    const dv = id ? (id.includes(' ') ? JSON.stringify(id) : id) : '<id>';
    const removing = cmd === 'rm' || cmd === 'delete';
    if (hints.some((h) => /A person was asked/.test(h))) hints.push('Doing what the agent asked? Act as the person: add --owner app:human (no lease needed while the handoff is pending).');
    if (/leased by app:human/.test(e.detail ?? '')) hints.push(`A person holds it: wait, or ask them for it: phonedock handoff request ${dv} "<what you need>"`);
    else if (!removing) hints.push(`To take it over anyway: phonedock lease ${dv} --force`);
    if (removing) hints.push(`To delete it anyway: phonedock rm ${dv} --force`);
  }
  return hints;
}
/** Detail lines without raw HTTP routes. */
export function cliDetail(detail?: string): string | undefined {
  const kept = (detail ?? '').split('\n').filter((l) => !/\/v1\//.test(l)).join('\n').trim();
  return kept || undefined;
}

export async function main(): Promise<void> {
  try {
    const code = await run(process.argv.slice(2));
    if (code >= 0) process.exitCode = code;
  } catch (e) {
    if (e instanceof UsageError) { process.stderr.write(`phonedock: ${e.message}\n`); process.exitCode = 2; return; }
    if (e instanceof PhoneDockApiError) {
      if (JSON_OUT) process.stdout.write(JSON.stringify({ error: { code: e.code, status: e.status, message: e.message, hints: e.hints, detail: e.detail } }, null, 2) + '\n');
      else {
        process.stderr.write(`phonedock: ${e.message}\n`);
        for (const h of cliHints(e)) process.stderr.write(`  hint: ${h}\n`);
        const detail = cliDetail(e.detail);
        if (detail) process.stderr.write(`  \x1b[2mdetail: ${detail}\x1b[0m\n`);
      }
      process.exitCode = 1; return;
    }
    process.stderr.write(`phonedock: ${(e as Error).stack ?? e}\n`);
    process.exitCode = 1;
  }
}

function isMainModule(): boolean {
  if (process.env.PHONEDOCK_CLI_MAIN === '1') return true;
  if (!process.argv[1]) return false;
  try { return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url; } catch { return false; }
}
if (isMainModule()) void main();

/** `phonedock idle-sleep` without --json. */
export function idleSleepText(st: import('../sdk/client.ts').IdleSleepStatus): string {
  const words = (s: number | null) => (s === null ? 'never' : s % 3600 === 0 ? `${s / 3600} hour${s === 3600 ? '' : 's'}` : s % 60 === 0 ? `${s / 60} minute${s === 60 ? '' : 's'}` : `${s} seconds`);
  const head = st.timeoutSec === null
    ? 'Idle virtual phones never go to sleep.'
    : `Idle virtual phones go to sleep after ${words(st.timeoutSec)} without use: their memory is freed, and any use wakes them, usually where they left off (otherwise they restart with their apps and data).`;
  const src = (st.source === 'env' ? `\n(Set by PHONEDOCK_IDLE_SLEEP for this service${st.saved !== undefined ? `; the saved setting is ${words(st.saved)}` : ''}.)` : '')
    + (st.sleeper === false ? '\nThis service doesn’t put phones to sleep or wake them: the app’s does (here a sleeping phone is a stopped one).' : '');
  const lines = st.devices.map((d) => {
    if (!d.eligible) return `  ${d.name}: never sleeps (${d.why})`;
    if (d.sleep) return `  ${d.name}: sleeping since ${d.sleep.since}`;
    if (d.state !== 'running') return `  ${d.name}: ${d.state}`;
    if (d.sleepFailure) return `  ${d.name}: couldn’t go to sleep, keeps running (${d.sleepFailure.message})`;
    if (d.keptAwakeBy?.length) return `  ${d.name}: awake (${d.keptAwakeBy.join('; ')})`;
    return `  ${d.name}: idle ${words(d.idleSec ?? 0)}${d.sleepsInSec != null ? `, sleeps in ${words(d.sleepsInSec)}` : ''}`;
  });
  return head + src + (lines.length ? `\n${lines.join('\n')}` : '');
}
