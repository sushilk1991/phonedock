// `phonedock setup`: connect PhoneDock to the agent clients on this Mac (Claude Code, Codex, Cursor, Pi) in one step.
// For each client it registers the MCP server in user scope with the absolute CLI path, installs the `phonedock` skill,
// puts `phonedock` on PATH, then checks the result in stages. It uses each client's own CLI where there is one and
// edits config files only where there isn't (Cursor) or where the CLI would lose the user's text: `codex mcp add`
// rewrites config.toml without its comments, so setup edits only its own table there and has Codex read the file back
// (falling back to `codex mcp add` if Codex disagrees). Never touches unrelated entries, an entry
// that runs another copy of PhoneDock (unless --force), or skill files the user edited. Writes are atomic, every file
// it changes is backed up first, and a second run changes nothing.
//
// Config locations (verified against each client's docs and --help, November 2026):
//   Claude Code  `claude mcp add --scope user` → ~/.claude.json mcpServers     skills: ~/.claude/skills/<name>/
//   Codex        `codex mcp add` (format)      → ~/.codex/config.toml          skills: ~/.agents/skills/<name>/
//   Cursor       (no add command)              → ~/.cursor/mcp.json            skills: ~/.agents/skills (also reads ~/.claude/skills)
//   Pi           `pi mcp add`                  → ~/.pi/agent/mcp.json          skills: ~/.agents/skills (and ~/.pi/agent/skills)
// One shared copy in ~/.agents/skills serves Codex, Cursor and Pi, so none of them sees the skill twice from setup's
// own installs. (Cursor also reads ~/.claude/skills for compatibility, so with Claude Code set up too it finds a
// second, identical copy there.)
//
// Dev/test only: PHONEDOCK_SETUP_HOME points every client config at another folder (and ignores CLAUDE_CONFIG_DIR,
// CODEX_HOME and PI_CODING_AGENT_DIR), so tests never touch the real ones.
import { spawn } from 'node:child_process';
import { accessSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { phonedockHome } from '../sdk/client.ts';
import { jsonText, listFiles, readJsonObject, readTomlServer, removeTomlServer, setTomlServerKey, sha256, tomlServerBlock, upsertTomlServer, writeFileAtomic, type Json, type JsonObject } from './setup-files.ts';

export const AGENTS = ['claude', 'codex', 'cursor', 'pi'] as const;
export type AgentId = (typeof AGENTS)[number];
export const AGENT_NAMES: Record<AgentId, string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', pi: 'Pi' };
const BINARIES: Record<AgentId, string> = { claude: 'claude', codex: 'codex', cursor: 'cursor-agent', pi: 'pi' };
export const SERVER_NAME = 'phonedock';
export const SKILL_NAME = 'phonedock';
/** request_human waits up to 15 min; long create/boot calls too. Codex's default tool timeout is 60 s. */
export const CODEX_TOOL_TIMEOUT_SEC = 960;
/** Pi's per-request timeout (seconds; default 60, reset by progress notifications). */
export const PI_TIMEOUT_SEC = 960;
const PI_DESCRIPTION = 'Android and iOS phones, emulators and simulators: create devices, read the screen, tap and type, test apps';
const MANIFEST = '.phonedock-skill.json';
export const TRY_PROMPT_IOS = 'Use PhoneDock to create an iPhone simulator, open Settings and turn on Dark Mode.';
export const TRY_PROMPT_ANDROID = 'Use PhoneDock to create an Android phone, open Settings and turn on Dark Mode.';
const VERSION = '0.2.4';

export type Exec = (cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Run a command (argv, never a shell string) and capture its output; never throws. */
export const execCapture: Exec = (cmd, args, opts = {}) => new Promise((res) => {
  let out = ''; let err = ''; let done = false;
  const child = spawn(cmd, args, { env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => { child.kill('SIGKILL'); }, opts.timeoutMs ?? 60_000);
  child.stdout.on('data', (d: Buffer) => { if (out.length < 2_000_000) out += d; });
  child.stderr.on('data', (d: Buffer) => { if (err.length < 200_000) err += d; });
  const finish = (code: number, extra = '') => { if (done) return; done = true; clearTimeout(timer); res({ code, stdout: out, stderr: err + extra }); };
  child.on('error', (e) => finish(127, e.message));
  child.on('close', (code, signal) => finish(code ?? (signal ? 137 : 1), signal === 'SIGKILL' ? '\n(timed out)' : ''));
});

export interface SetupContext {
  /** Where client configs live: the user's home (PHONEDOCK_SETUP_HOME in tests). */
  home: string;
  /** PHONEDOCK_SETUP_HOME is in effect: ignore config-dir overrides from the environment. */
  devHome: boolean;
  env: NodeJS.ProcessEnv;
  /** The user's PATH, in order (where `phonedock` can go). */
  pathDirs: string[];
  /** Where client binaries are looked for (PATH plus usual install folders). */
  searchDirs: string[];
  cliPath: string;
  skillSrc: string;
  /** Environment for the MCP server entry: PHONEDOCK_PORT / PHONEDOCK_HOME when set to something non-default. */
  serverEnv: Record<string, string>;
  /** Backups go under <stateHome>/setup-backups/<time>/. */
  stateHome: string;
  exec: Exec;
  now: Date;
}

export interface ClientInfo {
  id: AgentId; name: string; found: boolean; binary?: string; config: string; how: string;
  /** After this run: is PhoneDock registered with this client? yes / outdated (ours, needs an update) / other (another copy) / no. */
  registered?: 'yes' | 'outdated' | 'other' | 'no';
}

export type Action = 'add' | 'update' | 'remove' | 'none' | 'conflict' | 'manual' | 'error';
export interface Change {
  item: 'mcp' | 'skill' | 'path';
  agents: AgentId[];
  action: Action;
  /** File, folder or symlink this is about. */
  target: string;
  detail: string;
  /** Exact command(s) or edit that will run / ran. */
  steps: string[];
  /** --force would do this instead of reporting a conflict. */
  forceable?: boolean;
  /** Codex: only tool_timeout_sec needs raising. */
  timeoutOnly?: boolean;
  /** Remove or overwrite files the user edited (with --force; they're backed up). */
  force?: boolean;
}

export type StageStatus = 'ok' | 'warn' | 'fail' | 'skip';
export interface Stage { n: number; id: 'cli' | 'service' | 'mcp' | 'client' | 'platforms' | 'try'; agent?: AgentId; status: StageStatus; title: string; detail: string; fix?: string }

export interface SetupReport {
  ok: boolean;
  mode: 'install' | 'dry-run' | 'check' | 'uninstall';
  /** Nothing was written (--dry-run, also with --uninstall). */
  dryRun: boolean;
  version: string;
  cli: string;
  home: string;
  clients: ClientInfo[];
  agents: AgentId[];
  changes: Change[];
  backups: string[];
  stages: Stage[];
  tryPrompt?: string;
  restart: { agent: AgentId; note: string }[];
  /** Copy-paste commands for doing it by hand. */
  manual: Partial<Record<AgentId, string>>;
  platforms?: { id: string; name: string; ready: boolean; detail: string; fix?: string }[];
}

export interface SetupOptions {
  agents?: AgentId[] | 'all';
  dryRun?: boolean;
  check?: boolean;
  uninstall?: boolean;
  force?: boolean;
  /** Run the verification stages (default true; tests turn it off). */
  verify?: boolean;
  /** Test hook: replace stages 2, 3 and 5 (service, MCP handshake, platforms). */
  probe?: (ctx: SetupContext) => Promise<ProbeResult>;
}

// ── context ─────────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));

/** The CLI to register: the app bundle's bin/phonedock, else <repo>/bin/phonedock. */
export function defaultCliPath(env = process.env): string {
  if (env.PHONEDOCK_CLI_PATH) return resolve(env.PHONEDOCK_CLI_PATH);
  if (env.PHONEDOCK_BUNDLE_RESOURCES) return join(env.PHONEDOCK_BUNDLE_RESOURCES, 'bin', 'phonedock');
  return resolve(here, '..', '..', 'bin', 'phonedock');
}

/** The skill to install: bundled Contents/Resources/skills/phonedock, else <repo>/skills/phonedock. */
export function defaultSkillSrc(env = process.env): string {
  if (env.PHONEDOCK_SKILL_SRC) return resolve(env.PHONEDOCK_SKILL_SRC);
  if (env.PHONEDOCK_BUNDLE_RESOURCES) return join(env.PHONEDOCK_BUNDLE_RESOURCES, 'skills', SKILL_NAME);
  return resolve(here, '..', '..', 'skills', SKILL_NAME);
}

const SYSTEM_DIRS = new Set(['/usr/bin', '/bin', '/usr/sbin', '/sbin']);

/** PATH from the user's login shell: apps started from the Dock get a bare PATH that says nothing about the user's. */
async function loginShellPath(env: NodeJS.ProcessEnv, home: string, exec: Exec): Promise<string[]> {
  const shell = env.SHELL && isAbsolute(env.SHELL) ? env.SHELL : '/bin/zsh';
  const r = await exec(shell, ['-ilc', 'printf "\\n__PHONEDOCK_PATH__%s\\n" "$PATH"'], { env: { ...env, HOME: home }, timeoutMs: 6000 });
  const m = /__PHONEDOCK_PATH__(.*)/.exec(r.stdout);
  return m ? m[1].split(':').filter(Boolean) : [];
}

export async function resolveContext(env: NodeJS.ProcessEnv = process.env, over: Partial<SetupContext> = {}): Promise<SetupContext> {
  const devHome = !!env.PHONEDOCK_SETUP_HOME;
  const home = over.home ?? (devHome ? resolve(env.PHONEDOCK_SETUP_HOME!) : homedir());
  const exec = over.exec ?? execCapture;
  let pathDirs = over.pathDirs ?? (env.PATH ?? '').split(':').filter(Boolean);
  if (!over.pathDirs && pathDirs.every((d) => SYSTEM_DIRS.has(d))) {
    const fromShell = await loginShellPath(env, home, exec).catch(() => []);
    pathDirs = [...new Set([...fromShell, ...pathDirs])];
  }
  const extra = [join(home, '.local', 'bin'), join(home, 'bin'), '/opt/homebrew/bin', '/usr/local/bin', join(home, '.npm-global', 'bin'),
    join(home, '.bun', 'bin'), join(home, '.volta', 'bin'), join(home, 'Library', 'pnpm'), join(home, '.claude', 'local')];
  const serverEnv: Record<string, string> = {};
  if (env.PHONEDOCK_PORT && env.PHONEDOCK_PORT !== '47420') serverEnv.PHONEDOCK_PORT = env.PHONEDOCK_PORT;
  if (env.PHONEDOCK_HOME) serverEnv.PHONEDOCK_HOME = env.PHONEDOCK_HOME;
  return {
    home, devHome, env, pathDirs,
    searchDirs: over.searchDirs ?? [...new Set([...pathDirs, ...extra])],
    cliPath: over.cliPath ?? defaultCliPath(env),
    skillSrc: over.skillSrc ?? defaultSkillSrc(env),
    serverEnv: over.serverEnv ?? serverEnv,
    stateHome: over.stateHome ?? (devHome ? join(home, 'Library', 'Application Support', 'PhoneDock') : phonedockHome()),
    exec,
    now: over.now ?? new Date(),
  };
}

/** Environment for a client's own CLI: HOME = the setup home; in dev mode no config-dir overrides leak through. */
function clientEnv(ctx: SetupContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...ctx.env, HOME: ctx.home, PATH: [...new Set([...ctx.pathDirs, ...SYSTEM_DIRS])].join(':') };
  if (ctx.devHome) for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PI_CODING_AGENT_DIR']) delete env[k];
  delete env.PHONEDOCK_SETUP_HOME;
  return env;
}

const envDir = (ctx: SetupContext, k: string) => (!ctx.devHome && ctx.env[k] ? resolve(ctx.env[k]!) : undefined);
export function configPath(ctx: SetupContext, a: AgentId): string {
  switch (a) {
    case 'claude': return join(envDir(ctx, 'CLAUDE_CONFIG_DIR') ?? ctx.home, '.claude.json');
    case 'codex': return join(envDir(ctx, 'CODEX_HOME') ?? join(ctx.home, '.codex'), 'config.toml');
    case 'cursor': return join(ctx.home, '.cursor', 'mcp.json');
    case 'pi': return join(envDir(ctx, 'PI_CODING_AGENT_DIR') ?? join(ctx.home, '.pi', 'agent'), 'mcp.json');
  }
}
/** Where a client's copy of the skill goes: Claude Code its own folder, everyone else the shared ~/.agents/skills. */
export function skillDir(ctx: SetupContext, a: AgentId): string {
  return a === 'claude' ? join(envDir(ctx, 'CLAUDE_CONFIG_DIR') ?? join(ctx.home, '.claude'), 'skills', SKILL_NAME) : join(ctx.home, '.agents', 'skills', SKILL_NAME);
}

function isExecutable(p: string): boolean { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } }
function findBinary(ctx: SetupContext, name: string): string | undefined {
  for (const d of ctx.searchDirs) { const p = join(d, name); if (isExecutable(p)) return p; }
  return undefined;
}

export function detectClients(ctx: SetupContext): ClientInfo[] {
  return AGENTS.map((id) => {
    const binary = findBinary(ctx, BINARIES[id]);
    const cursorDir = id === 'cursor' && existsSync(join(ctx.home, '.cursor'));
    const found = !!binary || cursorDir;
    return { id, name: AGENT_NAMES[id], found, binary, config: configPath(ctx, id),
      how: binary ? `${BINARIES[id]} at ${tilde(ctx, binary)}` : cursorDir ? `${tilde(ctx, join(ctx.home, '.cursor'))} exists` : `no ${BINARIES[id]} on PATH` };
  });
}

// ── MCP entries ─────────────────────────────────────────────────────────

export interface McpEntry { command?: string; args?: string[]; env?: Record<string, string>; timeout?: number }

function realOrSelf(p: string): string { try { return realpathSync(p); } catch { return resolve(p); } }
const sameEnv = (a: Record<string, string> = {}, b: Record<string, string> = {}) => {
  const ka = Object.keys(a).sort(); const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
};
/** An entry runs this copy of PhoneDock when its command resolves to the same file. */
export function runsThisCli(ctx: SetupContext, e: McpEntry | undefined): boolean {
  if (!e?.command) return false;
  // A bare "phonedock" runs whatever PATH finds first.
  const cmd = isAbsolute(e.command) ? e.command : e.command.includes('/') ? undefined : ctx.searchDirs.map((d) => join(d, e.command!)).find(isExecutable);
  return !!cmd && realOrSelf(cmd) === realOrSelf(ctx.cliPath);
}

export function readEntry(ctx: SetupContext, a: AgentId): { entry?: McpEntry; error?: string } {
  const file = configPath(ctx, a);
  if (a === 'codex') {
    if (!existsSync(file)) return {};
    const s = readTomlServer(readFileSync(file, 'utf8'), SERVER_NAME);
    if (!s) return {};
    return { entry: { command: s.command, args: s.args, env: s.env, timeout: s.tool_timeout_sec } };
  }
  const j = readJsonObject(file);
  if (j.error) return { error: j.error };
  const servers = j.value?.mcpServers;
  const e = servers && typeof servers === 'object' && !Array.isArray(servers) ? (servers as JsonObject)[SERVER_NAME] : undefined;
  if (!e || typeof e !== 'object' || Array.isArray(e)) return {};
  const o = e as JsonObject;
  const strs = (v: Json | undefined) => (Array.isArray(v) ? v.map(String) : undefined);
  const env = o.env && typeof o.env === 'object' && !Array.isArray(o.env) ? Object.fromEntries(Object.entries(o.env).map(([k, v]) => [k, String(v)])) : undefined;
  return { entry: { command: typeof o.command === 'string' ? o.command : typeof o.url === 'string' ? o.url : undefined, args: strs(o.args), env, timeout: typeof o.timeout === 'number' ? o.timeout : undefined } };
}

type EntryState = 'missing' | 'same' | 'update' | 'other';
export function entryState(ctx: SetupContext, a: AgentId, e: McpEntry | undefined): EntryState {
  if (!e) return 'missing';
  if (!runsThisCli(ctx, e)) return 'other';
  const argsOk = JSON.stringify(e.args ?? []) === JSON.stringify(['mcp']);
  const timeoutOk = a === 'codex' ? (e.timeout ?? 0) >= CODEX_TOOL_TIMEOUT_SEC : a === 'pi' ? (e.timeout ?? 0) >= PI_TIMEOUT_SEC : true;
  return argsOk && sameEnv(e.env, ctx.serverEnv) && timeoutOk ? 'same' : 'update';
}

const q = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const cmdline = (argv: string[]) => argv.map(q).join(' ');
const envArgs = (flag: string, env: Record<string, string>) => Object.entries(env).flatMap(([k, v]) => [flag, `${k}=${v}`]);

/** The client's own command that registers PhoneDock (what we run, and what the app offers to copy). */
export function addCommand(ctx: SetupContext, a: AgentId): string[] | undefined {
  const tail = ['--', ctx.cliPath, 'mcp'];
  switch (a) {
    case 'claude': return ['claude', 'mcp', 'add', '--scope', 'user', SERVER_NAME, ...envArgs('-e', ctx.serverEnv), ...tail];
    case 'codex': return ['codex', 'mcp', 'add', SERVER_NAME, ...envArgs('--env', ctx.serverEnv), ...tail];
    case 'pi': return ['pi', 'mcp', 'add', SERVER_NAME, ...envArgs('--env', ctx.serverEnv), '--description', PI_DESCRIPTION, ...tail];
    case 'cursor': return undefined;
  }
}
function removeCommand(a: AgentId): string[] | undefined {
  switch (a) {
    case 'claude': return ['claude', 'mcp', 'remove', '--scope', 'user', SERVER_NAME];
    case 'codex': return ['codex', 'mcp', 'remove', SERVER_NAME];
    case 'pi': return ['pi', 'mcp', 'remove', SERVER_NAME];
    case 'cursor': return undefined;
  }
}

function jsonEntry(ctx: SetupContext, a: AgentId): JsonObject {
  const e: JsonObject = {};
  if (a === 'claude') e.type = 'stdio';
  e.command = ctx.cliPath; e.args = ['mcp'];
  if (Object.keys(ctx.serverEnv).length) e.env = { ...ctx.serverEnv };
  if (a === 'pi') { e.description = PI_DESCRIPTION; e.timeout = PI_TIMEOUT_SEC; }
  return e;
}

/** Hand-made registration, for the app's copyable fallback and the report. */
export function manualCommand(ctx: SetupContext, a: AgentId): string {
  if (a === 'cursor') return `Add to ${tilde(ctx, configPath(ctx, 'cursor'))}:\n${jsonText({ mcpServers: { [SERVER_NAME]: jsonEntry(ctx, 'cursor') } }).trim()}`;
  const add = cmdline(addCommand(ctx, a)!);
  return a === 'codex' ? `${add}\n# then add  tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}  under [mcp_servers.${SERVER_NAME}] in ${tilde(ctx, configPath(ctx, 'codex'))}` : add;
}

// ── skills ──────────────────────────────────────────────────────────────

interface Manifest { name: string; version: string; source: string; files: Record<string, string> }
function readManifest(dir: string): Manifest | undefined {
  try { const m = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')) as Manifest; return m && typeof m.files === 'object' ? m : undefined; } catch { return undefined; }
}
const fileHash = (p: string) => sha256(readFileSync(p));

interface SkillPlan { action: Action; detail: string; edited: string[] }
function planSkill(ctx: SetupContext, dir: string, force: boolean): SkillPlan {
  const src = listFiles(ctx.skillSrc);
  if (!src.length) return { action: 'error', detail: `the skill to install is missing (${ctx.skillSrc})`, edited: [] };
  if (!existsSync(dir)) return { action: 'add', detail: `install ${src.length} file${src.length > 1 ? 's' : ''}`, edited: [] };
  const m = readManifest(dir);
  const have = listFiles(dir);
  const differs = src.filter((f) => !existsSync(join(dir, f)) || fileHash(join(dir, f)) !== fileHash(join(ctx.skillSrc, f)));
  if (!m) {
    if (!differs.length && have.every((f) => src.includes(f))) return { action: 'update', detail: 'same files are already there: record them as installed by setup', edited: [] };
    return force ? { action: 'update', detail: 'replace a folder setup didn\'t install (backed up first)', edited: have }
      : { action: 'conflict', detail: 'a folder with this name exists and wasn\'t installed by setup: left alone', edited: have };
  }
  const edited = editedFiles(dir, m);
  const stale = Object.keys(m.files).filter((f) => !src.includes(f) && existsSync(join(dir, f)) && !edited.includes(f));
  const write = differs.filter((f) => force || !edited.includes(f));
  // An edit only blocks something when this version of PhoneDock changes that file too.
  const blocked = force ? [] : edited.filter((f) => src.includes(f) && fileHash(join(ctx.skillSrc, f)) !== m.files[f]);
  const yours = edited.filter((f) => !blocked.includes(f));
  const n = (k: number) => `${k} file${k === 1 ? '' : 's'}`;
  const keptNote = [blocked.length ? `kept your edits to ${blocked.join(', ')}, which this version also changes (--force replaces them, with a backup)` : '',
    !force && yours.length ? `your edits to ${yours.join(', ')} are kept` : ''].filter(Boolean).join('; ');
  if (!write.length && !stale.length) {
    return blocked.length ? { action: 'conflict', detail: `you edited ${blocked.join(', ')}, which this version also changes: kept yours (--force replaces it, with a backup)`, edited }
      : { action: 'none', detail: `up to date${keptNote ? ` (${keptNote})` : ''}`, edited };
  }
  return { action: 'update', detail: `update ${n(write.length + stale.length)}${keptNote ? `; ${keptNote}` : ''}`, edited };
}
/** Files setup installed that no longer match what it wrote. */
function editedFiles(dir: string, m: Manifest): string[] {
  return Object.entries(m.files).filter(([f, h]) => existsSync(join(dir, f)) && fileHash(join(dir, f)) !== h).map(([f]) => f);
}

// ── PATH ────────────────────────────────────────────────────────────────

function lexists(p: string): boolean { try { lstatSync(p); return true; } catch { return false; } }
function writableDir(d: string): boolean { try { return statSync(d).isDirectory() && (accessSync(d, constants.W_OK), true); } catch { return false; } }
const norm = (d: string) => resolve(d).replace(/\/+$/, '');

/** Shell line that puts the CLI's folder on PATH, for when no folder on PATH can take a link. */
export function pathLine(ctx: SetupContext): string {
  const dir = dirname(ctx.cliPath); const shell = basename(ctx.env.SHELL ?? '/bin/zsh');
  if (shell === 'fish') return `fish_add_path ${q(dir)}`;
  const rc = shell === 'bash' ? '~/.bash_profile' : shell === 'zsh' ? '~/.zshrc' : '~/.profile';
  return `echo 'export PATH="${dir.replace(/'/g, `'\\''`)}:$PATH"' >> ${rc}`;
}

/**
 * Folders setup may link into or remove its link from. Under PHONEDOCK_SETUP_HOME only folders inside that home, so
 * a test run never creates or removes a link in a real folder such as /opt/homebrew/bin.
 */
function linkScope(ctx: SetupContext): { pathDirs: string[]; prefs: string[] } {
  const prefs = [join(ctx.home, '.local', 'bin'), join(ctx.home, 'bin'), '/opt/homebrew/bin', '/usr/local/bin'].map(norm);
  if (!ctx.devHome) return { pathDirs: ctx.pathDirs, prefs };
  const inside = (d: string) => { const r = relative(ctx.home, resolve(d)); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
  return { pathDirs: ctx.pathDirs.filter(inside), prefs: prefs.filter(inside) };
}

export function planPath(ctx: SetupContext): Change {
  const base = { item: 'path' as const, agents: [] as AgentId[] };
  const real = realOrSelf(ctx.cliPath);
  const scope = linkScope(ctx);
  for (const d of scope.pathDirs) {
    const p = join(d, 'phonedock');
    if (!existsSync(p)) continue;        // missing, or a dangling link the shell skips
    if (realOrSelf(p) === real) return { ...base, action: 'none', target: p, detail: `phonedock is on PATH (${tilde(ctx, p)})`, steps: [] };
    let what = ''; try { what = lstatSync(p).isSymbolicLink() ? ` → ${readlinkSync(p)}` : ''; } catch { /* gone */ }
    return { ...base, action: 'conflict', target: p, detail: `${tilde(ctx, p)}${what} is another phonedock: left it alone (agents use the full path, so they aren't affected)`, steps: [] };
  }
  const onPath = new Set(scope.pathDirs.map(norm));
  const skipped: string[] = [];
  for (const d of scope.prefs) {
    if (!onPath.has(d) || !writableDir(d)) continue;
    const link = join(d, 'phonedock');
    if (lexists(link)) { skipped.push(`${tilde(ctx, link)} exists`); continue; }
    return { ...base, action: 'add', target: link, detail: `link ${tilde(ctx, link)} → ${ctx.cliPath}`, steps: [cmdline(['ln', '-s', ctx.cliPath, link])] };
  }
  return { ...base, action: 'manual', target: dirname(ctx.cliPath),
    detail: `no folder on your PATH can take a link${skipped.length ? ` (${skipped.join('; ')})` : ''}. To use the short name, run: ${pathLine(ctx)}`, steps: [pathLine(ctx)] };
}

/** Links named phonedock (on PATH or in the usual folders) that point at this CLI. Never regular files. */
function ourLinks(ctx: SetupContext): string[] {
  const real = realOrSelf(ctx.cliPath);
  const scope = linkScope(ctx);
  const dirs = [...new Set([...scope.pathDirs, ...scope.prefs].map(norm))];
  return dirs.map((d) => join(d, 'phonedock')).filter((p) => { try { return lstatSync(p).isSymbolicLink() && realOrSelf(p) === real; } catch { return false; } });
}

// ── helpers ─────────────────────────────────────────────────────────────

export function tilde(ctx: { home: string }, p: string): string {
  return p === ctx.home ? '~' : p.startsWith(ctx.home + '/') ? '~' + p.slice(ctx.home.length) : p;
}

class Backups {
  private ctx: SetupContext; private stamp: string; private done = new Set<string>();
  list: string[] = [];
  constructor(ctx: SetupContext) { this.ctx = ctx; this.stamp = ctx.now.toISOString().replace(/[:.]/g, '-'); }
  /** Copy a file (or every file of a folder) aside before it changes. */
  save(p: string): void {
    // Only the state before this run counts: a file that didn't exist then has nothing to keep.
    if (this.done.has(p)) return;
    this.done.add(p);
    if (!existsSync(p)) return;
    const root = join(this.ctx.stateHome, 'setup-backups', this.stamp);
    const rel = p.startsWith(this.ctx.home + '/') ? relative(this.ctx.home, p) : p.replace(/^\/+/, '');
    const files = statSync(p).isDirectory() ? listFiles(p).map((f) => join(p, f)) : [p];
    for (const f of files) {
      const to = join(root, rel, relative(p, f));
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(f, to);
    }
    this.list.push(join(root, rel));
  }
}

// ── plan ────────────────────────────────────────────────────────────────

function planMcp(ctx: SetupContext, a: AgentId, client: ClientInfo, force: boolean): Change {
  const file = configPath(ctx, a);
  const base = { item: 'mcp' as const, agents: [a], target: file };
  const r = readEntry(ctx, a);
  if (r.error) return { ...base, action: 'error', detail: `can't read ${tilde(ctx, file)}: ${r.error}. Fix the file, then run setup again`, steps: [] };
  const st = entryState(ctx, a, r.entry);
  if (st === 'same') return { ...base, action: 'none', detail: `registered (${tilde(ctx, file)})`, steps: [] };
  if (st === 'other' && !force) {
    const gone = r.entry?.command && isAbsolute(r.entry.command) && !existsSync(r.entry.command) ? ' (that file no longer exists)' : '';
    return { ...base, action: 'conflict', forceable: true, detail: `a "${SERVER_NAME}" server is already registered and runs ${r.entry?.command ?? 'something else'}${gone}, not ${ctx.cliPath}: left it alone (--force replaces it)`, steps: [] };
  }
  const steps: string[] = [];
  const add = addCommand(ctx, a); const rm = removeCommand(a);
  const timeoutOnly = st === 'update' && a === 'codex' && JSON.stringify(r.entry?.args ?? []) === '["mcp"]' && sameEnv(r.entry?.env, ctx.serverEnv);
  if (a === 'codex') {
    steps.push(timeoutOnly ? `set tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC} in [mcp_servers.${SERVER_NAME}] of ${tilde(ctx, file)}`
      : `write [mcp_servers.${SERVER_NAME}] to ${tilde(ctx, file)} (the rest of the file stays as it is):\n${tomlServerBlock(SERVER_NAME, ctx.cliPath, ['mcp'], ctx.serverEnv, CODEX_TOOL_TIMEOUT_SEC).trim()}`);
    if (client.binary) steps.push(`codex mcp list --json  (Codex reads it back; if it disagrees, the file is put back and ${cmdline(add!)} does it)`);
  } else if (client.binary && add) {
    if (r.entry && a === 'claude' && rm) steps.push(cmdline(rm));
    steps.push(cmdline(add));
  } else {
    steps.push(`set mcpServers.${SERVER_NAME} in ${tilde(ctx, file)}: ${JSON.stringify(jsonEntry(ctx, a))}`);
  }
  if (a === 'pi' && client.binary) steps.push(`set mcpServers.${SERVER_NAME}.timeout = ${PI_TIMEOUT_SEC} in ${tilde(ctx, file)}`);
  const verb = st === 'missing' ? 'register' : st === 'other' ? 'replace the other registration' : timeoutOnly ? `raise tool_timeout_sec to ${CODEX_TOOL_TIMEOUT_SEC}` : 'update the registration';
  return { ...base, action: st === 'missing' ? 'add' : 'update', detail: `${verb} (user scope, ${tilde(ctx, file)})`, steps, timeoutOnly };
}

function skillTargets(ctx: SetupContext, agents: AgentId[]): Map<string, AgentId[]> {
  const m = new Map<string, AgentId[]>();
  for (const a of agents) { const d = skillDir(ctx, a); m.set(d, [...(m.get(d) ?? []), a]); }
  return m;
}

function planSkills(ctx: SetupContext, agents: AgentId[], force: boolean): Change[] {
  return [...skillTargets(ctx, agents)].map(([dir, as]) => {
    const p = planSkill(ctx, dir, force);
    const steps = p.action === 'add' || p.action === 'update' ? [`copy ${tilde(ctx, ctx.skillSrc)}/ → ${tilde(ctx, dir)}/`] : [];
    return { item: 'skill', agents: as, action: p.action, target: dir, detail: `${tilde(ctx, dir)}: ${p.detail}`, steps, forceable: p.action === 'conflict', force };
  });
}

function planUninstall(ctx: SetupContext, clients: ClientInfo[], agents: AgentId[], force: boolean): Change[] {
  const changes: Change[] = [];
  const stillOurs = (a: AgentId) => !agents.includes(a) && runsThisCli(ctx, readEntry(ctx, a).entry);
  for (const a of agents) {
    const file = configPath(ctx, a);
    const r = readEntry(ctx, a);
    const base = { item: 'mcp' as const, agents: [a], target: file };
    if (r.error) { changes.push({ ...base, action: 'error', detail: `can't read ${tilde(ctx, file)}: ${r.error}`, steps: [] }); continue; }
    if (!r.entry) { changes.push({ ...base, action: 'none', detail: 'not registered', steps: [] }); continue; }
    if (!runsThisCli(ctx, r.entry) && !force) { changes.push({ ...base, action: 'conflict', forceable: true, detail: `"${SERVER_NAME}" runs ${r.entry.command}, not this copy: left it alone (--force removes it)`, steps: [] }); continue; }
    const bin = clients.find((c) => c.id === a)?.binary; const rm = removeCommand(a);
    changes.push({ ...base, action: 'remove', detail: `remove the registration (${tilde(ctx, file)})`,
      steps: [a === 'codex' ? `delete [mcp_servers.${SERVER_NAME}] from ${tilde(ctx, file)}${bin ? ', then codex mcp list --json reads it back' : ''}`
        : bin && rm ? cmdline(rm) : `delete mcpServers.${SERVER_NAME} from ${tilde(ctx, file)}`] });
  }
  for (const [dir, as] of skillTargets(ctx, agents)) {
    const users = AGENTS.filter((a) => skillDir(ctx, a) === dir && stillOurs(a));
    const base = { item: 'skill' as const, agents: as, target: dir };
    if (!existsSync(dir)) { changes.push({ ...base, action: 'none', detail: `${tilde(ctx, dir)}: not installed`, steps: [] }); continue; }
    if (users.length) { changes.push({ ...base, action: 'none', detail: `${tilde(ctx, dir)}: kept, ${users.map((u) => AGENT_NAMES[u]).join(' and ')} still use${users.length > 1 ? '' : 's'} it`, steps: [] }); continue; }
    const m = readManifest(dir);
    // What an earlier uninstall left behind: no manifest and no skill, only files the user added. Nothing of ours.
    if (!m && !existsSync(join(dir, 'SKILL.md'))) { changes.push({ ...base, action: 'none', detail: `${tilde(ctx, dir)}: only your own files are left: kept`, steps: [] }); continue; }
    if (!m) { changes.push({ ...base, action: force ? 'remove' : 'conflict', forceable: !force, detail: `${tilde(ctx, dir)}: ${force ? 'remove a folder setup didn\'t install (backed up first)' : 'wasn\'t installed by setup: left alone'}`, steps: force ? [`delete ${tilde(ctx, dir)}/`] : [] }); continue; }
    const edited = editedFiles(dir, m);
    const ours = Object.keys(m.files).filter((f) => existsSync(join(dir, f)) && !edited.includes(f));
    if (!ours.length && edited.length && !force) { changes.push({ ...base, action: 'none', detail: `${tilde(ctx, dir)}: only ${edited.join(', ')}, which you edited, is left: kept (--force removes it)`, steps: [] }); continue; }
    changes.push({ ...base, action: 'remove', force, detail: `${tilde(ctx, dir)}: remove the files setup installed${edited.length ? (force ? ` (including your edits to ${edited.join(', ')}, backed up)` : `, but keep ${edited.join(', ')}, which you edited`) : ''}`, steps: [`delete setup's files from ${tilde(ctx, dir)}/`] });
  }
  const remaining = AGENTS.filter(stillOurs);
  for (const link of ourLinks(ctx)) {
    changes.push(remaining.length ? { item: 'path', agents: [], action: 'none', target: link, detail: `${tilde(ctx, link)}: kept (${remaining.map((r) => AGENT_NAMES[r]).join(', ')} still set up)`, steps: [] }
      : { item: 'path', agents: [], action: 'remove', target: link, detail: `remove the link ${tilde(ctx, link)}`, steps: [cmdline(['rm', link])] });
  }
  return changes;
}

// ── apply ───────────────────────────────────────────────────────────────

async function runClient(ctx: SetupContext, bin: string, argv: string[]): Promise<void> {
  const r = await ctx.exec(bin, argv.slice(1), { env: clientEnv(ctx), timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`${cmdline(argv)} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`);
}

function editJson(file: string, fn: (o: JsonObject) => void, backups: Backups): void {
  const j = readJsonObject(file);
  if (j.error) throw new Error(j.error);
  const o = j.value ?? {};
  fn(o);
  backups.save(file);
  writeFileAtomic(file, jsonText(o), existsSync(file) ? undefined : 0o600);
}
function setServer(o: JsonObject, e: JsonObject): void {
  const s = o.mcpServers && typeof o.mcpServers === 'object' && !Array.isArray(o.mcpServers) ? (o.mcpServers as JsonObject) : {};
  s[SERVER_NAME] = e; o.mcpServers = s;
}

async function applyMcp(ctx: SetupContext, c: Change, client: ClientInfo, backups: Backups): Promise<void> {
  const a = c.agents[0]; const file = configPath(ctx, a);
  const bin = client.binary;
  const r = readEntry(ctx, a);
  backups.save(file);
  if (a === 'codex') { await applyCodex(ctx, c, bin, file); return; }
  if (c.action === 'remove') {
    const rm = removeCommand(a);
    if (bin && rm) await runClient(ctx, bin, rm);
    else editJson(file, (o) => { const s = o.mcpServers as JsonObject | undefined; if (s) delete s[SERVER_NAME]; }, backups);
    return;
  }
  if (a === 'cursor' || !bin) { editJson(file, (o) => setServer(o, jsonEntry(ctx, a)), backups); return; }
  if (a === 'claude' && r.entry) await runClient(ctx, bin!, removeCommand(a)!);
  await runClient(ctx, bin!, addCommand(ctx, a)!);
  if (a === 'pi') editJson(file, (o) => { const e = (o.mcpServers as JsonObject | undefined)?.[SERVER_NAME] as JsonObject | undefined; if (e) e.timeout = PI_TIMEOUT_SEC; }, backups);
}

/**
 * Codex: edit only [mcp_servers.phonedock] in config.toml, because `codex mcp add` and `remove` rewrite the whole file
 * and drop the user's comments (checked with Codex's own CLI). Then Codex reads the file back (`codex mcp list --json`
 * parses all of it); if it doesn't see exactly our entry (a form of the table setup can't read, say), the file is put
 * back and Codex's own command does the change instead.
 */
async function applyCodex(ctx: SetupContext, c: Change, bin: string | undefined, file: string): Promise<void> {
  const before = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  const text = before ?? '';
  const remove = c.action === 'remove';
  const next = remove ? removeTomlServer(text, SERVER_NAME)
    : c.timeoutOnly ? setTomlServerKey(text, SERVER_NAME, 'tool_timeout_sec', String(CODEX_TOOL_TIMEOUT_SEC))
    : upsertTomlServer(text, SERVER_NAME, tomlServerBlock(SERVER_NAME, ctx.cliPath, ['mcp'], ctx.serverEnv, CODEX_TOOL_TIMEOUT_SEC));
  if (next === undefined) throw new Error(`[mcp_servers.${SERVER_NAME}] isn't in ${file}`);
  if (next !== text) writeFileAtomic(file, next, before === undefined ? 0o600 : undefined);
  if (!bin || (await codexReadsBack(ctx, bin, !remove))) return;
  if (before === undefined) rmSync(file, { force: true }); else writeFileAtomic(file, before);
  if (remove) { await runClient(ctx, bin, removeCommand('codex')!); return; }
  await runClient(ctx, bin, addCommand(ctx, 'codex')!);
  const added = readFileSync(file, 'utf8');
  const timed = setTomlServerKey(added, SERVER_NAME, 'tool_timeout_sec', String(CODEX_TOOL_TIMEOUT_SEC));
  if (timed === undefined) throw new Error(`codex didn't write [mcp_servers.${SERVER_NAME}] to ${file}`);
  if (timed !== added) writeFileAtomic(file, timed);
  if (!(await codexReadsBack(ctx, bin, true))) throw new Error(`Codex doesn't read the ${SERVER_NAME} entry back from ${file}: run codex mcp list`);
}

/** Does Codex parse config.toml and see our entry (or, after removal, no entry)? */
async function codexReadsBack(ctx: SetupContext, bin: string, present: boolean): Promise<boolean> {
  const r = await ctx.exec(bin, ['mcp', 'list', '--json'], { env: clientEnv(ctx), timeoutMs: 30_000 });
  if (r.code !== 0) return false;
  try {
    type S = { name: string; transport?: { command?: string; args?: string[]; env?: Record<string, string> | null }; tool_timeout_sec?: number | null };
    const s = (JSON.parse(r.stdout) as S[]).find((x) => x.name === SERVER_NAME);
    if (!present) return !s;
    return !!s && runsThisCli(ctx, { command: s.transport?.command ?? '' }) && JSON.stringify(s.transport?.args ?? []) === '["mcp"]'
      && sameEnv(s.transport?.env ?? undefined, ctx.serverEnv) && (s.tool_timeout_sec ?? 0) >= CODEX_TOOL_TIMEOUT_SEC;
  } catch { return false; }
}

function applySkill(ctx: SetupContext, c: Change, backups: Backups): void {
  const dir = c.target;
  const m = readManifest(dir);
  if (existsSync(dir)) backups.save(dir);
  const keep = m && !c.force ? editedFiles(dir, m) : [];
  if (c.action === 'remove') {
    const files = m ? Object.entries(m.files) : listFiles(dir).map((f) => [f, ''] as [string, string]);
    for (const [f] of files) {
      const p = join(dir, f);
      if (existsSync(p) && !keep.includes(f)) rmSync(p);
    }
    // Edited files stay, and so does the record that they are edits (so later runs still leave them alone).
    if (!keep.length) rmSync(join(dir, MANIFEST), { force: true });
    pruneEmpty(dir);
    return;
  }
  const src = listFiles(ctx.skillSrc);
  // Files from an older version that this one no longer has (only when the user didn't edit them).
  if (m) for (const f of Object.keys(m.files)) if (!src.includes(f) && existsSync(join(dir, f)) && !keep.includes(f)) rmSync(join(dir, f));
  const files: Record<string, string> = {};
  for (const f of src) {
    const from = join(ctx.skillSrc, f); const to = join(dir, f);
    // A file the user edited keeps their text and the hash setup wrote, so it still reads as an edit next time.
    if (keep.includes(f) && m) { files[f] = m.files[f]; continue; }
    const data = readFileSync(from);
    if (!existsSync(to) || fileHash(to) !== sha256(data)) writeFileAtomic(to, data, 0o644);
    files[f] = sha256(data);
  }
  const manifest: Manifest = { name: SKILL_NAME, version: VERSION, source: ctx.skillSrc, files };
  writeFileAtomic(join(dir, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', 0o644);
  pruneEmpty(dir, false);
}
/** Remove empty folders under `dir` (and `dir` itself when `self`); anything with a file in it stays. */
function pruneEmpty(dir: string, self = true): void {
  const walk = (d: string): boolean => {
    let empty = true;
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (lstatSync(p).isDirectory() && walk(p)) { try { rmdirSync(p); } catch { empty = false; } } else empty = false;
    }
    return empty;
  };
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
  if (walk(dir) && self) { try { rmdirSync(dir); } catch { /* not empty */ } }
}

function applyPath(ctx: SetupContext, c: Change): void {
  if (c.action === 'add') {
    if (lexists(c.target)) throw new Error(`${c.target} appeared meanwhile: left it alone`);
    symlinkSync(ctx.cliPath, c.target);
  } else if (c.action === 'remove' && lstatSync(c.target).isSymbolicLink() && realOrSelf(c.target) === realOrSelf(ctx.cliPath)) unlinkSync(c.target);
}

// ── verify ──────────────────────────────────────────────────────────────

export interface ProbeResult {
  service: { ok: boolean; detail: string; fix?: string };
  mcp: { ok: boolean; detail: string; fix?: string; tools?: string[] };
  platforms?: { id: string; name: string; ready: boolean; detail: string; fix?: string }[];
}

const PLATFORMS = [
  { id: 'ios-simulator', name: 'iPhone simulators', fix: 'Install Xcode from the App Store, open it once, then add an iOS runtime in Xcode › Settings › Components. AXe adds input and the UI tree: brew install cameroncooke/axe/axe' },
  { id: 'android-emulator', name: 'Android emulators', fix: 'Install the Android SDK command-line tools and emulator: brew install --cask android-commandlinetools (or Android Studio), then open PhoneDock › New Device… to download a system image' },
];

/** Stages 2, 3 and 5 for real: the service, an MCP handshake with `phonedock mcp`, and which platforms are ready. */
export async function realProbe(ctx: SetupContext): Promise<ProbeResult> {
  const { PhoneDockClient } = await import('../sdk/client.ts');
  const pd = new PhoneDockClient({ autoStart: true });
  let service: ProbeResult['service'];
  try { await pd.ensureDaemon(15_000); const h = await pd.health(); service = { ok: true, detail: `answers at ${pd.baseUrl}${h.version ? ` (v${h.version})` : ''}` }; }
  catch (e) { service = { ok: false, detail: (e as Error).message, fix: 'Open PhoneDock (or run `phonedock daemon start`), then run setup again.' }; }

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport, getDefaultEnvironment } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  // The environment an agent client gives the server: the basics plus the entry's own env.
  const transport = new StdioClientTransport({ command: ctx.cliPath, args: ['mcp'], env: { ...getDefaultEnvironment(), ...ctx.serverEnv }, stderr: 'pipe' });
  let errText = ''; transport.stderr?.on('data', (d: Buffer) => { if (errText.length < 4000) errText += d; });
  const client = new Client({ name: 'phonedock-setup', version: VERSION });
  const within = <T>(p: Promise<T>, ms: number, what: string) => Promise.race([p, new Promise<T>((_r, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000} s`)), ms).unref())]);
  let mcp: ProbeResult['mcp']; let platforms: ProbeResult['platforms'];
  try {
    await within(client.connect(transport), 20_000, 'initialize');
    const tools = (await within(client.listTools(), 10_000, 'tools/list')).tools.map((t) => t.name);
    mcp = { ok: tools.includes('get_ui') && tools.includes('list_devices'), detail: `initialize and tools/list answered: ${tools.length} tools`, tools };
    if (service.ok) {
      const text = async (name: string, args: Record<string, unknown>) => {
        const r = await within(client.callTool({ name, arguments: args }), 30_000, name) as { content?: { type: string; text?: string }[] };
        return (r.content ?? []).map((x) => x.text ?? '').join('\n');
      };
      const backends = await text('list_backends', {});
      platforms = [];
      for (const p of PLATFORMS) {
        const line = backends.split('\n').find((l) => l.startsWith(`${p.id} `));
        if (!line) { platforms.push({ id: p.id, name: p.name, ready: false, detail: 'not available in this build', fix: p.fix }); continue; }
        if (!/available=yes/.test(line)) { platforms.push({ id: p.id, name: p.name, ready: false, detail: /reason=(.*?)(?: hints=|$)/.exec(line)?.[1] ?? 'not available', fix: p.fix }); continue; }
        const imgs = await text('list_os_images', { backend: p.id }).catch(() => '');
        const n = imgs.split('\n').filter((l) => l.includes('installed=yes')).length;
        platforms.push(n ? { id: p.id, name: p.name, ready: true, detail: `${n} OS image${n > 1 ? 's' : ''} installed` }
          : { id: p.id, name: p.name, ready: false, detail: 'no OS image installed yet', fix: p.id === 'android-emulator' ? 'Open PhoneDock › New Device… (it downloads a system image), or: phonedock images android-emulator' : 'Add an iOS runtime in Xcode › Settings › Components' });
      }
    }
  } catch (e) {
    mcp = { ok: false, detail: `${(e as Error).message}${errText.trim() ? `: ${errText.trim().split('\n').slice(-2).join(' ')}` : ''}`, fix: `Run ${q(ctx.cliPath)} mcp in Terminal to see why it doesn't start.` };
  } finally { await client.close().catch(() => {}); }
  return { service, mcp, platforms };
}

async function clientStage(ctx: SetupContext, c: ClientInfo): Promise<Omit<Stage, 'n' | 'id'>> {
  const a = c.id; const name = c.name; const env = clientEnv(ctx);
  const base = { agent: a, title: `${name} lists it` };
  const e = readEntry(ctx, a).entry;
  if (!runsThisCli(ctx, e)) return { ...base, status: 'fail', detail: e ? `"${SERVER_NAME}" runs ${e.command}, not this copy` : `not registered in ${tilde(ctx, configPath(ctx, a))}`,
    fix: e ? `Run: phonedock setup --agent ${a} --force (replaces it; the old entry is backed up)` : `Run: phonedock setup --agent ${a}` };
  if (!c.binary) return { ...base, status: 'ok', detail: `registered in ${tilde(ctx, configPath(ctx, a))} (no ${BINARIES[a]} command to ask)` };
  if (a === 'claude') {
    const r = await ctx.exec(c.binary, ['mcp', 'get', SERVER_NAME], { env, timeoutMs: 60_000 });
    const status = /Status:\s*(.+)/.exec(r.stdout)?.[1]?.trim() ?? (r.stderr || r.stdout).trim().split('\n')[0];
    return /connected/i.test(status) && !/fail|not connected/i.test(status) ? { ...base, status: 'ok', detail: `claude mcp get ${SERVER_NAME}: ${status}` }
      : { ...base, status: 'fail', detail: `claude mcp get ${SERVER_NAME}: ${status || `exit ${r.code}`}`, fix: `Run claude mcp get ${SERVER_NAME} in Terminal for details.` };
  }
  if (a === 'codex') {
    const r = await ctx.exec(c.binary, ['mcp', 'get', SERVER_NAME, '--json'], { env, timeoutMs: 30_000 });
    try {
      const j = JSON.parse(r.stdout) as { enabled?: boolean; tool_timeout_sec?: number | null };
      const t = j.tool_timeout_sec ?? 0;
      return j.enabled !== false && t >= CODEX_TOOL_TIMEOUT_SEC ? { ...base, status: 'ok', detail: `codex mcp get ${SERVER_NAME}: enabled, tool_timeout_sec ${t}` }
        : { ...base, status: 'warn', detail: `codex mcp get ${SERVER_NAME}: ${j.enabled === false ? 'disabled' : `tool_timeout_sec ${t || 'default (60)'}`}`, fix: `Run: phonedock setup --agent codex` };
    } catch { return { ...base, status: 'fail', detail: `codex mcp get ${SERVER_NAME} --json: ${(r.stderr || r.stdout).trim().split('\n')[0] || `exit ${r.code}`}`, fix: `Run codex mcp list in Terminal.` }; }
  }
  if (a === 'pi') {
    const r = await ctx.exec(c.binary, ['mcp', 'list', '--json'], { env, timeoutMs: 60_000 });
    try {
      const s = (JSON.parse(r.stdout) as { servers?: { name: string; state?: string; tools?: unknown[]; error?: string }[] }).servers?.find((x) => x.name === SERVER_NAME);
      if (!s) return { ...base, status: 'fail', detail: 'pi mcp list does not show it', fix: 'Run: phonedock setup --agent pi' };
      return s.state === 'connected' ? { ...base, status: 'ok', detail: `pi mcp list: connected, ${s.tools?.length ?? 0} tools` }
        : { ...base, status: 'fail', detail: `pi mcp list: ${s.state ?? '?'}${s.error ? ` (${s.error})` : ''}`, fix: 'Run pi mcp list in Terminal for details.' };
    } catch { return { ...base, status: 'fail', detail: `pi mcp list --json: ${(r.stderr || r.stdout).trim().split('\n')[0] || `exit ${r.code}`}` }; }
  }
  const r = await ctx.exec(c.binary, ['mcp', 'list-tools', SERVER_NAME], { env, timeoutMs: 60_000 });
  const out = `${r.stdout}\n${r.stderr}`;
  if (r.code === 0 && /get_ui/.test(out)) return { ...base, status: 'ok', detail: `cursor-agent mcp list-tools ${SERVER_NAME}: ${(out.match(/\bget_ui\b|\btap\b|\bscreenshot\b/g) ?? []).length ? 'tools listed' : 'ok'}` };
  return { ...base, status: 'warn', detail: `registered in ${tilde(ctx, configPath(ctx, 'cursor'))}; cursor-agent mcp list-tools ${SERVER_NAME}: ${out.trim().split('\n')[0] || `exit ${r.code}`}`, fix: 'Open Cursor › Settings › MCP and turn PhoneDock on, or run cursor-agent mcp list.' };
}

export const RESTART: Record<AgentId, string> = {
  claude: 'Claude Code loads MCP servers when a session starts: start a new session (sessions that were already open need a restart).',
  codex: 'Start a new Codex session: open ones don’t pick up new MCP servers.',
  cursor: 'Restart Cursor (or turn PhoneDock on in Cursor Settings › MCP); start a new cursor-agent session.',
  pi: 'Start a new Pi session, or run /reload in an open one.',
};

// ── run ─────────────────────────────────────────────────────────────────

export function parseAgents(v: string | undefined): AgentId[] | 'all' | undefined {
  if (v === undefined || v === '') return undefined;
  if (v === 'all') return 'all';
  const list = v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).map((s) => (s === 'claude-code' ? 'claude' : s === 'cursor-agent' ? 'cursor' : s));
  const bad = list.filter((s) => !(AGENTS as readonly string[]).includes(s));
  if (bad.length) throw new Error(`unknown agent ${bad.join(', ')}: use claude, codex, cursor, pi or all`);
  return list as AgentId[];
}

export async function runSetup(ctx: SetupContext, opts: SetupOptions = {}): Promise<SetupReport> {
  const mode: SetupReport['mode'] = opts.uninstall ? 'uninstall' : opts.check ? 'check' : opts.dryRun ? 'dry-run' : 'install';
  const write = (mode === 'install' || mode === 'uninstall') && !opts.dryRun;
  const clients = detectClients(ctx);
  const agents = !opts.agents || opts.agents === 'all' ? clients.filter((c) => c.found).map((c) => c.id) : [...new Set(opts.agents)];
  const report: SetupReport = { ok: true, mode, dryRun: !!opts.dryRun, version: VERSION, cli: ctx.cliPath, home: ctx.home, clients, agents, changes: [], backups: [], stages: [], restart: [], manual: {} };
  for (const a of AGENTS) report.manual[a] = manualCommand(ctx, a);
  const force = !!opts.force;
  const byId = (a: AgentId) => clients.find((c) => c.id === a)!;

  if (opts.uninstall) report.changes = planUninstall(ctx, clients, agents, force);
  else if (agents.length) report.changes = [...agents.map((a) => planMcp(ctx, a, byId(a), force)), ...planSkills(ctx, agents, force), planPath(ctx)];

  if (write) {
    const backups = new Backups(ctx);
    for (const c of report.changes) {
      if (!['add', 'update', 'remove'].includes(c.action)) continue;
      try {
        if (c.item === 'mcp') await applyMcp(ctx, c, byId(c.agents[0]), backups);
        else if (c.item === 'skill') applySkill(ctx, c, backups);
        else applyPath(ctx, c);
      } catch (e) { c.action = 'error'; c.detail = `${c.detail}: ${(e as Error).message}`; }
    }
    report.backups = backups.list;
  }
  for (const c of clients) {
    const st = entryState(ctx, c.id, readEntry(ctx, c.id).entry);
    c.registered = st === 'same' ? 'yes' : st === 'update' ? 'outdated' : st === 'other' ? 'other' : 'no';
  }
  // Failing: errors, and another copy of PhoneDock keeping this one from being registered. A skill the user edited,
  // or another phonedock on PATH, is reported but isn't a failure.
  report.ok = !report.changes.some((c) => c.action === 'error' || (c.action === 'conflict' && c.item === 'mcp'));

  const verify = opts.verify !== false && !opts.dryRun && !opts.uninstall && agents.length > 0;
  if (verify) {
    const stages: Stage[] = [];
    const cli = await ctx.exec(ctx.cliPath, ['home', '--json'], { env: { ...ctx.env, ...ctx.serverEnv }, timeoutMs: 30_000 });
    stages.push(cli.code === 0 ? { n: 1, id: 'cli', status: 'ok', title: 'CLI runs', detail: ctx.cliPath }
      : { n: 1, id: 'cli', status: 'fail', title: 'CLI runs', detail: `${ctx.cliPath} exited ${cli.code}: ${(cli.stderr || cli.stdout).trim().split('\n').slice(-1)[0] ?? ''}`, fix: 'Reinstall PhoneDock (from source: Node.js 24 or later must be on PATH).' });
    const probe = await (opts.probe ?? realProbe)(ctx);
    stages.push({ n: 2, id: 'service', status: probe.service.ok ? 'ok' : 'fail', title: 'Service answers', detail: probe.service.detail, fix: probe.service.fix });
    stages.push({ n: 3, id: 'mcp', status: probe.mcp.ok ? 'ok' : 'fail', title: 'MCP server starts', detail: probe.mcp.detail, fix: probe.mcp.fix });
    for (const a of agents) stages.push({ n: 4, id: 'client', ...(await clientStage(ctx, byId(a))) });
    report.platforms = probe.platforms;
    const ready = (probe.platforms ?? []).filter((p) => p.ready);
    if (probe.platforms) {
      stages.push({ n: 5, id: 'platforms', status: ready.length ? (ready.length === probe.platforms.length ? 'ok' : 'warn') : 'fail', title: 'Platforms ready',
        detail: probe.platforms.map((p) => `${p.name}: ${p.ready ? 'ready' : p.detail}`).join(' · '),
        fix: probe.platforms.filter((p) => !p.ready && p.fix).map((p) => `${p.name}: ${p.fix}`).join('\n') || undefined });
    } else stages.push({ n: 5, id: 'platforms', status: 'skip', title: 'Platforms ready', detail: 'skipped: the service or the MCP server isn\'t working' });
    const ios = ready.some((p) => p.id === 'ios-simulator'); const android = ready.some((p) => p.id === 'android-emulator');
    report.tryPrompt = ios || !android ? TRY_PROMPT_IOS : TRY_PROMPT_ANDROID;
    report.restart = agents.map((a) => ({ agent: a, note: RESTART[a] }));
    stages.push({ n: 6, id: 'try', status: 'ok', title: 'Try it', detail: `Ask your agent: "${report.tryPrompt}"` });
    report.stages = stages;
    if (stages.some((s) => s.status === 'fail' && s.id !== 'platforms')) report.ok = false;
  }
  return report;
}

// ── output ──────────────────────────────────────────────────────────────

const MARK: Record<Action | StageStatus, string> = { add: '+', update: '~', remove: '-', none: '✓', conflict: '!', manual: '→', error: '✗', ok: '✓', warn: '!', fail: '✗', skip: '·' };

export function formatReport(r: SetupReport): string {
  const ctx = { home: r.home };
  const out: string[] = [];
  const found = r.clients.filter((c) => c.found); const missing = r.clients.filter((c) => !c.found);
  const label = [r.mode === 'uninstall' ? 'uninstall' : r.mode === 'check' ? 'check' : '', r.dryRun ? 'dry run' : ''].filter(Boolean).join(', ');
  out.push(`PhoneDock setup${label ? ` (${label})` : ''}`, '');
  out.push(`Found:     ${found.length ? found.map((c) => `${c.name} (${c.how})`).join(', ') : 'no agent clients'}`);
  if (missing.length) out.push(`Not found: ${missing.map((c) => c.name).join(', ')}`);
  if (!r.agents.length) {
    out.push('', 'Nothing to set up. Install Claude Code, Codex, Cursor or Pi, or name one: phonedock setup --agent claude');
    return out.join('\n');
  }
  out.push(`${r.mode === 'uninstall' ? 'Removing from' : r.mode === 'check' ? 'Checking' : 'Setting up'}: ${r.agents.map((a) => AGENT_NAMES[a]).join(', ')}`, '');
  out.push(r.dryRun ? 'Proposed changes (nothing was written):' : r.mode === 'check' ? 'Current state (nothing was written):' : 'Changes:');
  const who = (c: Change) => (c.item === 'path' ? 'PATH' : c.agents.map((a) => AGENT_NAMES[a]).join(', '));
  const wide = Math.max(4, ...r.changes.map((c) => who(c).length));
  for (const c of r.changes) {
    const item = c.item === 'mcp' ? 'MCP server' : c.item === 'skill' ? 'skill' : 'phonedock on PATH';
    out.push(`  ${MARK[c.action]} ${who(c).padEnd(wide)}  ${item}: ${c.detail}`);
    if (r.dryRun || c.action === 'error') for (const s of c.steps) out.push(...s.split('\n').map((l, i) => `      ${i ? '  ' : '$ '}${l}`));
  }
  if (r.backups.length) out.push(`  Backups: ${r.backups.map((b) => tilde(ctx, b)).join(', ')}`);
  if (r.stages.length) {
    out.push('', 'Checks:');
    const tw = Math.max(...r.stages.map((s) => s.title.length));
    for (const s of r.stages) {
      out.push(`  ${MARK[s.status]} ${s.n}. ${s.title.padEnd(tw)}  ${s.detail}`);
      if (s.fix && s.status !== 'ok') out.push(...s.fix.split('\n').map((l) => `       fix: ${l}`));
    }
    if (r.restart.length) out.push('', ...r.restart.map((x) => `  ${AGENT_NAMES[x.agent]}: ${x.note}`));
  }
  const conflicts = r.changes.filter((c) => c.forceable && c.action === 'conflict');
  if (conflicts.length) out.push('', `Some items were left alone. Re-run with --force to replace them (backups are kept).`);
  if (r.dryRun) out.push('', 'Run without --dry-run to apply.');
  return out.join('\n');
}

/** `phonedock setup …` — returns the exit code. */
export async function setupCommand(flags: Record<string, string | boolean>, json: boolean): Promise<number> {
  const agents = parseAgents(typeof flags.agent === 'string' ? flags.agent : undefined);
  const ctx = await resolveContext();
  const report = await runSetup(ctx, { agents, dryRun: flags.dryRun === true, check: flags.check === true, uninstall: flags.uninstall === true, force: flags.force === true });
  process.stdout.write(json ? JSON.stringify(report, null, 2) + '\n' : formatReport(report) + '\n');
  return report.ok ? 0 : 1;
}
