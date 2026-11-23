// Retrievable flow run records (schemaVersion: 1) under stateDir('runs').
// Atomic, non-overwriting storage with bounded retention (PHONEDOCK_MAX_RUNS, default 200),
// strict validation (<= 2 MB body, <= 2000 steps), git provenance, and public-safe Markdown export.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { run } from './exec.ts';
import { stateDir } from './paths.ts';
import {
  PhoneDockError,
  type DeviceKind,
  type Platform,
  type RunAppProvenance,
  type RunArtifacts,
  type RunDeviceProvenance,
  type RunFlowProvenance,
  type RunRecord,
  type RunSourceProvenance,
  type RunStatus,
  type RunStepRecord,
  type RunStepStatus,
  type RunSummary,
} from './types.ts';

export const RUN_SCHEMA_VERSION = 1 as const;
export const RUN_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const UTC_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
export const MAX_RUN_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_RUN_STEPS = 2000;
export const DEFAULT_MAX_RUNS = 200;
const MAX_RUNS_LIMIT = 5000;

const RUN_STATUSES = new Set<RunStatus>(['pass', 'fail', 'skip']);
const STEP_STATUSES = new Set<RunStepStatus>(['pass', 'fail', 'warn', 'skip']);
const PLATFORMS = new Set<Platform | 'unknown'>(['android', 'ios', 'linux', 'other', 'unknown']);
const KINDS = new Set<DeviceKind | 'unknown'>(['virtual', 'physical', 'cloud', 'unknown']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function runsDir(override?: string): string {
  const dir = override ?? stateDir('runs');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function maxRuns(): number {
  const raw = process.env.PHONEDOCK_MAX_RUNS;
  if (!raw) return DEFAULT_MAX_RUNS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_RUNS_LIMIT) return DEFAULT_MAX_RUNS;
  return n;
}

/** Sortable run ID: YYYY-MM-DDTHH-MM-SS-mmmZ-<4hex>, valid under RUN_ID_RE. */
export function newRunId(startedAt: Date | string = new Date()): string {
  const d = typeof startedAt === 'string' ? new Date(startedAt) : startedAt;
  const iso = (Number.isNaN(d.getTime()) ? new Date() : d).toISOString();
  const stamp = iso.replace(/[:.]/g, '-');
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

export function assertValidRunId(id: string): string {
  if (typeof id !== 'string' || !RUN_ID_RE.test(id)) {
    throw new PhoneDockError(
      'The run ID is invalid',
      'bad_request',
      400,
      ['Run IDs must be 1–128 characters of letters, digits, ".", "_", or "-", and cannot start with ".".'],
      `Invalid run id ${JSON.stringify(id)}`,
    );
  }
  return id;
}

function badRun(detail: string): PhoneDockError {
  return new PhoneDockError('The run record is invalid', 'bad_request', 400, undefined, detail);
}

function assertSafeObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRun(`${path} must be an object`);
  const rec = value as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (FORBIDDEN_KEYS.has(key)) throw badRun(`${path} contains forbidden key ${JSON.stringify(key)}`);
  }
  return rec;
}

function checkNoForbiddenKeys(value: unknown, path = 'body'): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) checkNoForbiddenKeys(value[i], `${path}[${i}]`);
    return;
  }
  const rec = value as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (FORBIDDEN_KEYS.has(key)) throw badRun(`${path} contains forbidden key ${JSON.stringify(key)}`);
    checkNoForbiddenKeys(rec[key], `${path}.${key}`);
  }
}

function reqStr(obj: Record<string, unknown>, key: string, path: string, allowEmpty = false): string {
  const v = obj[key];
  if (typeof v !== 'string' || (!allowEmpty && !v.trim())) throw badRun(`${path}.${key} must be a non-empty string`);
  return v;
}

function optStr(obj: Record<string, unknown>, key: string, path: string): string | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw badRun(`${path}.${key} must be a string`);
  return v;
}

function reqNonNegNum(obj: Record<string, unknown>, key: string, path: string): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw badRun(`${path}.${key} must be a non-negative number`);
  return v;
}

function reqNonNegInt(obj: Record<string, unknown>, key: string, path: string): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw badRun(`${path}.${key} must be a non-negative integer`);
  return v;
}

export interface ValidateRunOptions {
  /** Require UTC `Z` ISO-8601 timestamps (default true, enforced on POST / writeRunRecord). */
  requireUtc?: boolean;
}

function isValidTimestamp(ts: string, requireUtc: boolean): boolean {
  if (!Number.isFinite(Date.parse(ts))) return false;
  return requireUtc ? UTC_ISO_RE.test(ts) : true;
}

/** Validate an untrusted run payload strictly before persisting. Rejects schemaVersion !== 1 and > 2000 steps. */
export function validateRunRecord(raw: unknown, opts: ValidateRunOptions = {}): RunRecord {
  const requireUtc = opts.requireUtc ?? true;
  checkNoForbiddenKeys(raw);
  const o = assertSafeObject(raw, 'run');
  if (o.schemaVersion !== RUN_SCHEMA_VERSION) {
    throw badRun(`schemaVersion must be ${RUN_SCHEMA_VERSION} (got ${JSON.stringify(o.schemaVersion)})`);
  }
  if (typeof o.id !== 'string') throw badRun('run.id must be a string');
  const id = assertValidRunId(o.id);
  const status = o.status as RunStatus;
  if (typeof status !== 'string' || !RUN_STATUSES.has(status)) throw badRun('run.status must be pass | fail | skip');
  const startedAt = reqStr(o, 'startedAt', 'run');
  if (!isValidTimestamp(startedAt, requireUtc)) {
    throw badRun(requireUtc ? 'run.startedAt must be a valid UTC ISO-8601 timestamp ending in Z' : 'run.startedAt must be a valid ISO timestamp');
  }
  const endedAt = reqStr(o, 'endedAt', 'run');
  if (!isValidTimestamp(endedAt, requireUtc)) {
    throw badRun(requireUtc ? 'run.endedAt must be a valid UTC ISO-8601 timestamp ending in Z' : 'run.endedAt must be a valid ISO timestamp');
  }
  const durationMs = reqNonNegNum(o, 'durationMs', 'run');
  const attempts = reqNonNegInt(o, 'attempts', 'run');
  const owner = reqStr(o, 'owner', 'run');
  const message = optStr(o, 'message', 'run');

  const fObj = assertSafeObject(o.flow, 'run.flow');
  const fPlatform = optStr(fObj, 'platform', 'run.flow');
  if (fPlatform !== undefined && !['android', 'ios', 'linux', 'other'].includes(fPlatform)) {
    throw badRun('run.flow.platform must be android | ios | linux | other');
  }
  const flow: RunFlowProvenance = {
    name: reqStr(fObj, 'name', 'run.flow'),
    ...(optStr(fObj, 'file', 'run.flow') !== undefined ? { file: optStr(fObj, 'file', 'run.flow') } : {}),
    fileDisplay: reqStr(fObj, 'fileDisplay', 'run.flow'),
    sha256: reqStr(fObj, 'sha256', 'run.flow'),
    ...(fPlatform ? { platform: fPlatform as Platform } : {}),
  };

  const sObj = assertSafeObject(o.source, 'run.source');
  const dirtyRaw = sObj.dirty;
  if (dirtyRaw !== true && dirtyRaw !== false && dirtyRaw !== 'unknown') {
    throw badRun('run.source.dirty must be boolean or "unknown"');
  }
  const source: RunSourceProvenance = {
    commit: reqStr(sObj, 'commit', 'run.source'),
    branch: reqStr(sObj, 'branch', 'run.source'),
    dirty: dirtyRaw,
  };

  const dObj = assertSafeObject(o.device, 'run.device');
  const dPlatform = reqStr(dObj, 'platform', 'run.device') as Platform | 'unknown';
  if (!PLATFORMS.has(dPlatform)) throw badRun('run.device.platform is invalid');
  const dKind = reqStr(dObj, 'kind', 'run.device') as DeviceKind | 'unknown';
  if (!KINDS.has(dKind)) throw badRun('run.device.kind is invalid');
  const device: RunDeviceProvenance = {
    id: reqStr(dObj, 'id', 'run.device'),
    name: reqStr(dObj, 'name', 'run.device'),
    platform: dPlatform,
    backend: reqStr(dObj, 'backend', 'run.device'),
    kind: dKind,
    osVersion: reqStr(dObj, 'osVersion', 'run.device'),
    model: reqStr(dObj, 'model', 'run.device'),
  };

  const aObj = assertSafeObject(o.app, 'run.app');
  const app: RunAppProvenance = {
    id: reqStr(aObj, 'id', 'run.app'),
    name: reqStr(aObj, 'name', 'run.app'),
    version: reqStr(aObj, 'version', 'run.app'),
    build: reqStr(aObj, 'build', 'run.app'),
  };

  if (!Array.isArray(o.steps)) throw badRun('run.steps must be an array');
  if (o.steps.length > MAX_RUN_STEPS) {
    throw badRun(`run.steps has ${o.steps.length} entries; maximum is ${MAX_RUN_STEPS}`);
  }
  const steps: RunStepRecord[] = o.steps.map((rawStep, i) => {
    const st = assertSafeObject(rawStep, `run.steps[${i}]`);
    const stStatus = st.status as RunStepStatus;
    if (typeof stStatus !== 'string' || !STEP_STATUSES.has(stStatus)) {
      throw badRun(`run.steps[${i}].status must be pass | fail | warn | skip`);
    }
    const stepMsg = optStr(st, 'message', `run.steps[${i}]`);
    const screenshot = optStr(st, 'screenshot', `run.steps[${i}]`);
    const beforeScreenshot = optStr(st, 'beforeScreenshot', `run.steps[${i}]`);
    return {
      index: reqNonNegInt(st, 'index', `run.steps[${i}]`),
      description: reqStr(st, 'description', `run.steps[${i}]`, true),
      status: stStatus,
      ms: reqNonNegNum(st, 'ms', `run.steps[${i}]`),
      ...(stepMsg !== undefined ? { message: stepMsg } : {}),
      ...(screenshot !== undefined ? { screenshot } : {}),
      ...(beforeScreenshot !== undefined ? { beforeScreenshot } : {}),
    };
  });

  let artifacts: RunArtifacts | undefined;
  if (o.artifacts !== undefined) {
    const artObj = assertSafeObject(o.artifacts, 'run.artifacts');
    const dir = optStr(artObj, 'dir', 'run.artifacts');
    const report = optStr(artObj, 'report', 'run.artifacts');
    let files: string[] | undefined;
    if (artObj.files !== undefined) {
      if (!Array.isArray(artObj.files) || !artObj.files.every((x) => typeof x === 'string')) {
        throw badRun('run.artifacts.files must be an array of strings');
      }
      files = artObj.files as string[];
    }
    artifacts = {
      ...(dir !== undefined ? { dir } : {}),
      ...(report !== undefined ? { report } : {}),
      ...(files !== undefined ? { files } : {}),
    };
  }

  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    id,
    status,
    startedAt,
    endedAt,
    durationMs,
    attempts,
    owner,
    ...(message !== undefined ? { message } : {}),
    flow,
    source,
    device,
    app,
    steps,
    ...(artifacts ? { artifacts } : {}),
  };
}

export function toRunSummary(r: RunRecord): RunSummary {
  return {
    schemaVersion: r.schemaVersion,
    id: r.id,
    status: r.status,
    startedAt: r.startedAt,
    durationMs: r.durationMs,
    attempts: r.attempts,
    owner: r.owner,
    ...(r.message !== undefined ? { message: r.message } : {}),
    flowName: r.flow.name,
    flowFile: r.flow.fileDisplay,
    deviceId: r.device.id,
    deviceName: r.device.name,
    platform: r.device.platform,
    osVersion: r.device.osVersion,
    appId: r.app.id,
    appVersion: r.app.version,
    appBuild: r.app.build,
    commit: r.source.commit,
    dirty: r.source.dirty,
    stepCount: r.steps.length,
    passedSteps: r.steps.filter((s) => s.status === 'pass').length,
    failedSteps: r.steps.filter((s) => s.status === 'fail').length,
    ...(r.artifacts?.report ? { report: r.artifacts.report } : {}),
  };
}

/** Write a validated run record atomically without ever overwriting an existing ID (409 conflict).
 *  Prunes oldest manifest files beyond PHONEDOCK_MAX_RUNS; never touches external artifact directories. */
export function writeRunRecord(record: RunRecord, dirOverride?: string): RunSummary {
  const valid = validateRunRecord(record);
  const dir = runsDir(dirOverride);
  const dest = join(dir, `${valid.id}.json`);
  if (existsSync(dest)) {
    throw new PhoneDockError('A run with this ID already exists', 'conflict', 409, undefined, `Run ${valid.id} already exists`);
  }
  const tmp = join(dir, `.${valid.id}.${randomUUID()}.tmp`);
  const payload = JSON.stringify(valid, null, 2) + '\n';
  if (Buffer.byteLength(payload) > MAX_RUN_BODY_BYTES) {
    throw new PhoneDockError('The run record is too large', 'too_large', 413, undefined, `Run record exceeds ${MAX_RUN_BODY_BYTES} bytes`);
  }
  try {
    writeFileSync(tmp, payload, { mode: 0o600 });
    try {
      linkSync(tmp, dest);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new PhoneDockError('A run with this ID already exists', 'conflict', 409, undefined, `Run ${valid.id} already exists`);
      }
      throw e;
    }
  } finally {
    try { unlinkSync(tmp); } catch { /* already removed */ }
  }
  pruneRuns(dir, maxRuns());
  return toRunSummary(valid);
}

function compareRunsDesc(a: { startedAt: string; id: string }, b: { startedAt: string; id: string }): number {
  const ta = Date.parse(a.startedAt);
  const tb = Date.parse(b.startedAt);
  const na = Number.isFinite(ta) ? ta : -Infinity;
  const nb = Number.isFinite(tb) ? tb : -Infinity;
  if (nb !== na) return nb - na;
  return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
}

/** Keep at most `keep` newest manifest files in `dir`. Never deletes non-manifest files or artifact dirs. */
export function pruneRuns(dir: string, keep: number): number {
  let entries: { name: string; startedAt: string; id: string }[];
  try {
    entries = readdirSync(dir)
      .filter((n) => n.endsWith('.json') && !n.startsWith('.'))
      .map((name) => {
        const id = name.slice(0, -5);
        try {
          const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { startedAt?: string };
          return { name, id, startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '' };
        } catch {
          return { name, id, startedAt: '' };
        }
      });
  } catch {
    return 0;
  }
  if (entries.length <= keep) return 0;
  entries.sort(compareRunsDesc);
  let removed = 0;
  for (const old of entries.slice(keep)) {
    try { unlinkSync(join(dir, old.name)); removed++; } catch { /* ignore */ }
  }
  return removed;
}

export function readRunRecord(id: string, dirOverride?: string): RunRecord | null {
  assertValidRunId(id);
  const file = join(runsDir(dirOverride), `${id}.json`);
  if (!existsSync(file)) return null;
  try {
    return validateRunRecord(JSON.parse(readFileSync(file, 'utf8')), { requireUtc: false });
  } catch {
    return null;
  }
}

export interface RunListFilter {
  device?: string;
  status?: RunStatus;
  flow?: string;
  appId?: string;
  limit?: number;
}

export function listRunSummaries(filter: RunListFilter = {}, dirOverride?: string): RunSummary[] {
  const dir = runsDir(dirOverride);
  let files: string[];
  try { files = readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('.')); } catch { return []; }
  const summaries: RunSummary[] = [];
  for (const name of files) {
    try {
      const parsed = validateRunRecord(JSON.parse(readFileSync(join(dir, name), 'utf8')), { requireUtc: false });
      summaries.push(toRunSummary(parsed));
    } catch { /* skip invalid or unreadable manifest */ }
  }
  summaries.sort(compareRunsDesc);

  const devQ = filter.device?.toLowerCase();
  const flowQ = filter.flow?.toLowerCase();
  const filtered = summaries.filter((s) => {
    if (devQ && s.deviceId.toLowerCase() !== devQ && s.deviceName.toLowerCase() !== devQ) return false;
    if (filter.status && s.status !== filter.status) return false;
    if (flowQ && !s.flowName.toLowerCase().includes(flowQ) && !s.flowFile.toLowerCase().includes(flowQ)) return false;
    if (filter.appId && s.appId !== filter.appId) return false;
    return true;
  });

  const limit = Math.max(1, Math.min(200, filter.limit ?? 50));
  return filtered.slice(0, limit);
}

// ── provenance helpers ───────────────────────────────────────────────────────
export interface GitProvenance extends RunSourceProvenance {
  gitRoot?: string;
}

/** Collect git commit, branch, dirty flag, and repo root using argv-only exec. Unknown outside git. */
export async function readGitProvenance(cwd = process.cwd()): Promise<GitProvenance> {
  const unknown: GitProvenance = { commit: 'unknown', branch: 'unknown', dirty: 'unknown' };
  const top = await run('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeoutMs: 3000, allowFail: true });
  if (top.code !== 0 || !top.stdout.trim()) return unknown;
  const gitRoot = top.stdout.trim();
  const [head, branchRes, statusRes] = await Promise.all([
    run('git', ['-C', gitRoot, 'rev-parse', 'HEAD'], { timeoutMs: 3000, allowFail: true }),
    run('git', ['-C', gitRoot, 'symbolic-ref', '--short', 'HEAD'], { timeoutMs: 3000, allowFail: true }),
    run('git', ['-C', gitRoot, 'status', '--porcelain'], { timeoutMs: 3000, allowFail: true }),
  ]);
  const commit = head.code === 0 && /^[0-9a-f]{7,64}$/i.test(head.stdout.trim()) ? head.stdout.trim() : 'unknown';
  const branch = branchRes.code === 0 && branchRes.stdout.trim() ? branchRes.stdout.trim() : (commit !== 'unknown' ? 'detached' : 'unknown');
  const dirty: boolean | 'unknown' = statusRes.code === 0 ? statusRes.stdout.trim().length > 0 : 'unknown';
  return { commit, branch, dirty, gitRoot };
}

/** Repo-relative POSIX path when inside `gitRoot`, bare filename otherwise, or 'unknown'. Never returns an absolute path. */
export function publicFlowPath(file: string | undefined, gitRoot?: string): string {
  if (!file) return 'unknown';
  if (gitRoot) {
    const absFile = resolve(file);
    const absRoot = resolve(gitRoot);
    const rel = relative(absRoot, absFile);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
      return rel.split(sep).join('/');
    }
  }
  return basename(file) || 'unknown';
}

export function sha256Hex(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

// ── public-safe Markdown export ──────────────────────────────────────────────
/** Ensure a display path or free-form message never leaks absolute local paths into public PR Markdown. */
function sanitizePublicPath(p: string): string {
  const trimmed = p.trim();
  if (!trimmed || trimmed === 'unknown') return 'unknown';
  if (
    trimmed.startsWith('/')
    || trimmed.startsWith('~/')
    || trimmed.startsWith('\\\\')
    || /^[A-Za-z]:[\\/]/.test(trimmed)
    || /^file:\/\//i.test(trimmed)
  ) {
    return basename(trimmed.replace(/^file:\/\/[^/]*/i, '').replace(/\\/g, '/')) || 'unknown';
  }
  return trimmed.replace(/\\/g, '/');
}

function sanitizePublicText(s: string): string {
  // Replace every absolute local path (file://..., UNC \\server\share\..., ~/..., any /-rooted path of 2+ segments,
  // and Windows drive paths) with its basename.
  // URLs like https://example.com/a/b are left intact because // has an empty first segment and path slashes follow alphanumeric chars.
  return s
    .replace(/file:\/\/[^\s)'"`,;:]+/gi, (m) => basename(m.replace(/^file:\/\/[^/]*/i, '').replace(/\\/g, '/')) || '[local-file]')
    .replace(/(?<![A-Za-z0-9._\\/-])\\\\[^\\\s)'"`,;:]+(?:\\[^\\\s)'"`,;:]+)+\\?/g, (m) => basename(m.replace(/\\/g, '/')) || '[local-path]')
    .replace(/(?<![A-Za-z0-9._/-])~\/[^\s)'"`,;:]+/g, (m) => basename(m) || '[local-path]')
    .replace(/(?<![A-Za-z0-9._/-])\/[^/\s)'"`,;:]+(?:\/[^/\s)'"`,;:]+)+\/?/g, (m) => basename(m) || '[local-path]')
    .replace(/(?<![A-Za-z0-9._/-])[A-Za-z]:[\\/][^\s)'"`,;:]+/g, (m) => basename(m.replace(/\\/g, '/')) || '[local-path]');
}

const mdCell = (s: string) => sanitizePublicText(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
const fmtDur = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);

/** Render a RunRecord as public-safe GitHub-flavored Markdown (no absolute local paths anywhere). */
export function formatRunMarkdown(r: RunRecord): string {
  const badge = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'SKIP';
  const flowFile = sanitizePublicPath(r.flow.fileDisplay);
  const flowSha = r.flow.sha256 === 'unknown' ? 'unknown' : r.flow.sha256.slice(0, 12);
  const commit = r.source.commit === 'unknown'
    ? 'unknown'
    : `${r.source.commit.slice(0, 12)}${r.source.dirty === true ? ' (dirty)' : r.source.dirty === false ? '' : ' (dirty: unknown)'}`;
  const appVer = r.app.version === 'unknown' && r.app.build === 'unknown'
    ? 'unknown'
    : `${r.app.version} (${r.app.build})`;

  const lines: string[] = [
    `### PhoneDock Run: ${mdCell(r.flow.name)} — ${badge}`,
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Status | **${badge}** (${r.steps.filter((s) => s.status === 'pass').length}/${r.steps.length} steps passed) |`,
    `| Run ID | \`${r.id}\` |`,
    `| Flow | \`${mdCell(flowFile)}\` (sha256 \`${flowSha}\`) |`,
    `| Device | ${mdCell(r.device.name)} (${mdCell(String(r.device.platform))} ${mdCell(r.device.osVersion)}, ${mdCell(r.device.model)}, \`${mdCell(r.device.backend)}\`) |`,
    `| App | \`${mdCell(r.app.id)}\` (${mdCell(r.app.name)}) · ${mdCell(appVer)} |`,
    `| Source | \`${commit}\` on \`${mdCell(r.source.branch)}\` |`,
    `| Duration | ${fmtDur(r.durationMs)} (${r.attempts} attempt${r.attempts === 1 ? '' : 's'}) |`,
    `| Started | ${r.startedAt} |`,
  ];

  if (r.message) {
    lines.push('', `> **Result:** ${mdCell(r.message)}`);
  }

  if (r.steps.length) {
    lines.push('', '| # | Status | Step | Time | Note |', '| ---: | --- | --- | ---: | --- |');
    for (const s of r.steps) {
      const note = s.message ? mdCell(s.message).slice(0, 200) : '';
      lines.push(`| ${s.index} | ${s.status.toUpperCase()} | ${mdCell(s.description)} | ${fmtDur(s.ms)} | ${note} |`);
    }
  }

  // Public-safe artifact listing: bare basenames only, never local directories.
  const artifactNames = new Set<string>();
  if (r.artifacts?.report) artifactNames.add(basename(r.artifacts.report));
  for (const f of r.artifacts?.files ?? []) {
    const b = basename(f);
    if (b) artifactNames.add(b);
  }
  if (artifactNames.size) {
    lines.push('', `Artifacts (local): ${[...artifactNames].sort().map((n) => `\`${n}\``).join(', ')}`);
  }

  return lines.join('\n') + '\n';
}
