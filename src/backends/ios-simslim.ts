// Optional SimSlim integration for iOS simulators (https://github.com/sushilk1991/simslim).
// Disables unused simulator background daemons (widgets, Siri, Spotlight, telemetry, ...) to cut
// simulator RAM/CPU ~40% and process count by ~80 while keeping UI testing, Safari/WebView, StoreKit,
// Photos and iCloud intact. Always falls back cleanly to stock `xcrun simctl` when simslim is absent
// or fails on a simulator.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run, type RunOptions } from '../core/exec.ts';
import { stateDir, toolEnv, which } from '../core/paths.ts';
import { PhoneDockError, type ExecResult } from '../core/types.ts';

/** Matches ~/.agents/skills/simslim/profiles/ui.json: preserves Safari/WKWebView, StoreKit, Photos, iCloud and Share Sheets. */
export const DEFAULT_SIMSLIM_EXCEPT: readonly string[] = ['store', 'web', 'photos', 'icloud', 'other'];
const CATEGORY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const UDID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

export interface SimslimSetting {
  enabled: boolean;
  except: string[];
  profilePath: string | null;
  source: 'env' | 'setting' | 'default';
  savedEnabled?: boolean;
}

export interface SimslimStatus extends SimslimSetting {
  available: boolean;
  binary?: string;
  version?: string;
  defaultExcept: readonly string[];
}

export interface SimslimDeviceInfo {
  slimmed: boolean;
  disabledCount?: number;
  managedTotal?: number;
  footprintMB?: number;
  processCount?: number;
  profile?: string;
  except?: string[];
  checkedAt: string;
  fallbackReason?: string;
  raw?: Record<string, unknown>;
}

export interface SimslimDeps {
  resolveBinary(): string | undefined;
  runCmd(cmd: string, args: string[], opts?: RunOptions): Promise<ExecResult>;
  exists(path: string): boolean;
  settingPath(): string;
  env: NodeJS.ProcessEnv;
}

export function resolveSimslimBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.PHONEDOCK_SIMSLIM?.trim();
  if (override) return existsSync(override) ? override : undefined;
  return which('simslim');
}

const defaultDeps: SimslimDeps = {
  resolveBinary: () => resolveSimslimBinary(),
  runCmd: (cmd, args, opts) => run(cmd, args, { env: toolEnv(), ...opts }),
  exists: existsSync,
  settingPath: () => join(stateDir(), 'simslim.json'),
  env: process.env,
};

function parseBoolEnv(v: string | undefined): boolean | undefined {
  if (!v) return undefined;
  const s = v.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return undefined;
}

export function validateSimslimCategories(list: unknown): string[] {
  if (!Array.isArray(list)) throw new PhoneDockError('except must be an array of simslim category IDs', 'bad_request', 400);
  if (list.length > 32) throw new PhoneDockError('Too many simslim categories (max 32)', 'bad_request', 400);
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string' || !CATEGORY_RE.test(item.trim())) {
      throw new PhoneDockError(`Invalid simslim category ID: ${JSON.stringify(item)}`, 'bad_request', 400);
    }
    const clean = item.trim().toLowerCase();
    if (!out.includes(clean)) out.push(clean);
  }
  return out;
}

export function validateProfilePath(p: unknown, exists: (path: string) => boolean = existsSync): string | null {
  if (p === null || p === undefined || p === '') return null;
  if (typeof p !== 'string' || /[\0\r\n]/.test(p) || p.length > 1024) {
    throw new PhoneDockError('Invalid simslim profile path', 'bad_request', 400);
  }
  const trimmed = p.trim();
  if (!exists(trimmed)) throw new PhoneDockError(`SimSlim profile file not found: ${trimmed}`, 'not_found', 404);
  return trimmed;
}

interface SavedSimslim { v: 1; enabled: boolean; except?: string[]; profilePath?: string | null; updatedAt?: string }

function readSaved(deps: SimslimDeps): SavedSimslim | null {
  try {
    const raw = JSON.parse(readFileSync(deps.settingPath(), 'utf8')) as Partial<SavedSimslim>;
    if (!raw || typeof raw.enabled !== 'boolean') return null;
    const except = Array.isArray(raw.except) && raw.except.every((x) => typeof x === 'string' && CATEGORY_RE.test(x))
      ? raw.except : [...DEFAULT_SIMSLIM_EXCEPT];
    const profilePath = typeof raw.profilePath === 'string' && raw.profilePath.trim() ? raw.profilePath.trim() : null;
    return { v: 1, enabled: raw.enabled, except, profilePath };
  } catch { return null; }
}

export function simslimSetting(deps: SimslimDeps = defaultDeps): SimslimSetting {
  const file = readSaved(deps);
  const except = file?.except ?? [...DEFAULT_SIMSLIM_EXCEPT];
  const profilePath = file?.profilePath ?? null;
  const envVal = parseBoolEnv(deps.env.PHONEDOCK_SIMSLIM_ENABLED);
  if (envVal !== undefined) {
    return { enabled: envVal, except, profilePath, source: 'env', ...(file ? { savedEnabled: file.enabled } : {}) };
  }
  if (file) return { enabled: file.enabled, except, profilePath, source: 'setting' };
  return { enabled: false, except, profilePath, source: 'default' };
}

export function setSimslimSetting(
  patch: { enabled?: boolean; except?: string[]; profilePath?: string | null },
  deps: SimslimDeps = defaultDeps,
): SimslimSetting {
  const cur = readSaved(deps);
  const enabled = patch.enabled !== undefined ? !!patch.enabled : (cur?.enabled ?? false);
  const except = patch.except !== undefined ? validateSimslimCategories(patch.except) : (cur?.except ?? [...DEFAULT_SIMSLIM_EXCEPT]);
  const profilePath = patch.profilePath !== undefined ? validateProfilePath(patch.profilePath, deps.exists) : (cur?.profilePath ?? null);
  const file = deps.settingPath();
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: 1, enabled, except, profilePath, updatedAt: new Date().toISOString() }, null, 2) + '\n');
  renameSync(tmp, file);
  return simslimSetting(deps);
}

let versionCache: { bin: string; version?: string; at: number } | undefined;

export async function simslimStatus(deps: SimslimDeps = defaultDeps): Promise<SimslimStatus> {
  const setting = simslimSetting(deps);
  const bin = deps.resolveBinary();
  let version: string | undefined;
  if (bin) {
    if (deps === defaultDeps && versionCache && versionCache.bin === bin && Date.now() - versionCache.at < 60_000) {
      version = versionCache.version;
    } else {
      const r = await deps.runCmd(bin, ['--version'], { allowFail: true, timeoutMs: 5_000 }).catch(() => undefined);
      version = r?.code === 0 ? r.stdout.trim().split('\n')[0]?.trim() || undefined : undefined;
      if (deps === defaultDeps) versionCache = { bin, version, at: Date.now() };
    }
  }
  return {
    ...setting,
    available: !!bin,
    ...(bin ? { binary: bin } : {}),
    ...(version ? { version } : {}),
    defaultExcept: DEFAULT_SIMSLIM_EXCEPT,
  };
}

// ── per-device cached state ────────────────────────────────────────────────

const deviceSlimCache = new Map<string, SimslimDeviceInfo>();

export function cachedSimslimStatus(udid: string): SimslimDeviceInfo | undefined {
  return deviceSlimCache.get(udid);
}

export function clearSimslimStatus(udid: string): void {
  deviceSlimCache.delete(udid);
}

export function simslimProfileArgs(opts: { profilePath?: string | null; except?: string[] }): string[] {
  if (opts.profilePath) return ['--profile', opts.profilePath];
  const except = opts.except ?? [...DEFAULT_SIMSLIM_EXCEPT];
  return except.length ? ['--except', except.join(',')] : [];
}

function parseJsonSafe(raw: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch { return undefined; }
}

function asNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function parseSimslimReport(
  raw: Record<string, unknown> | undefined,
  meta: { profile?: string; except?: string[] } = {},
): SimslimDeviceInfo {
  const disabledCount = asNum(raw?.managedDisabled) ?? asNum(raw?.disabled) ?? asNum(raw?.disabledCount) ?? asNum(raw?.disabledDaemons)
    ?? (Array.isArray(raw?.disabledLabels) ? raw.disabledLabels.length : undefined);
  const managedTotal = asNum(raw?.managedTotal) ?? asNum(raw?.total) ?? asNum(raw?.managed);
  const footprintMB = asNum(raw?.footprintMB) ?? asNum(raw?.physFootprintMB) ?? asNum(raw?.memoryMB)
    ?? (asNum(raw?.bytes) !== undefined ? Math.round((asNum(raw?.bytes)! / (1024 * 1024)) * 10) / 10 : undefined)
    ?? (asNum(raw?.footprintBytes) !== undefined ? Math.round((asNum(raw?.footprintBytes)! / (1024 * 1024)) * 10) / 10 : undefined)
    ?? (asNum(raw?.physFootprintBytes) !== undefined ? Math.round((asNum(raw?.physFootprintBytes)! / (1024 * 1024)) * 10) / 10 : undefined);
  const processCount = asNum(raw?.processes) ?? asNum(raw?.processCount) ?? asNum(raw?.runningProcesses)
    ?? (Array.isArray(raw?.processList) ? raw.processList.length : undefined);
  const slimmed = typeof raw?.slim === 'boolean' ? raw.slim
    : typeof raw?.slimmed === 'boolean' ? raw.slimmed
    : (disabledCount !== undefined ? disabledCount > 0 : false);
  return {
    slimmed,
    ...(disabledCount !== undefined ? { disabledCount } : {}),
    ...(managedTotal !== undefined ? { managedTotal } : {}),
    ...(footprintMB !== undefined ? { footprintMB } : {}),
    ...(processCount !== undefined ? { processCount } : {}),
    ...(meta.profile ? { profile: meta.profile } : {}),
    ...(meta.except?.length ? { except: meta.except } : {}),
    checkedAt: new Date().toISOString(),
    ...(raw ? { raw } : {}),
  };
}

export interface SlimBootPlan {
  want: boolean;
  explicit: boolean;
  profilePath: string | null;
  except: string[];
}

/** Decide whether a simulator boot should use SimSlim and with which profile.
 *  Precedence: explicit boot option > device spec.options.slim > global setting (managed simulators only). */
export function resolveSlimBootPlan(
  opts: { bootSlim?: boolean | string; specSlim?: unknown; managed: boolean },
  deps: SimslimDeps = defaultDeps,
): SlimBootPlan {
  const setting = simslimSetting(deps);
  const fromVal = (v: unknown): { want: boolean; profilePath: string | null } | undefined => {
    if (v === true) return { want: true, profilePath: setting.profilePath };
    if (v === false) return { want: false, profilePath: null };
    if (typeof v === 'string' && v.trim()) return { want: true, profilePath: v.trim() };
    return undefined;
  };
  const explicitBoot = fromVal(opts.bootSlim);
  if (explicitBoot) return { ...explicitBoot, explicit: true, except: setting.except };
  const fromSpec = fromVal(opts.specSlim);
  if (fromSpec) return { ...fromSpec, explicit: true, except: setting.except };
  if (opts.managed && setting.enabled) {
    return { want: true, explicit: false, profilePath: setting.profilePath, except: setting.except };
  }
  return { want: false, explicit: false, profilePath: null, except: setting.except };
}

export interface SlimBootOutcome {
  applied: boolean;
  info?: SimslimDeviceInfo;
  fallbackReason?: string;
}

/** Attempt to boot/slim `udid` with SimSlim. Never throws: on any missing binary or simslim failure,
 *  cleans up with `simslim off --preserve-boot-state` (best effort) and returns `applied: false` so
 *  the caller falls back to stock `xcrun simctl boot`. */
export async function prepareSimslimBoot(
  udid: string,
  opts: { bootSlim?: boolean | string; specSlim?: unknown; managed: boolean; alreadyBooted: boolean; onProgress?: (line: string) => void },
  deps: SimslimDeps = defaultDeps,
): Promise<SlimBootOutcome> {
  const plan = resolveSlimBootPlan(opts, deps);
  if (!plan.want) return { applied: false };

  const bin = deps.resolveBinary();
  if (!bin) {
    const fallbackReason = 'simslim is not installed; booted stock simulator';
    if (plan.explicit) {
      opts.onProgress?.(fallbackReason);
      const info: SimslimDeviceInfo = { slimmed: false, checkedAt: new Date().toISOString(), fallbackReason };
      deviceSlimCache.set(udid, info);
      return { applied: false, info, fallbackReason };
    }
    return { applied: false, fallbackReason };
  }

  if (plan.profilePath && !deps.exists(plan.profilePath)) {
    const fallbackReason = `SimSlim profile not found (${plan.profilePath}); booted stock simulator`;
    opts.onProgress?.(fallbackReason);
    const info: SimslimDeviceInfo = { slimmed: false, checkedAt: new Date().toISOString(), fallbackReason };
    deviceSlimCache.set(udid, info);
    return { applied: false, info, fallbackReason };
  }

  const profileArgs = simslimProfileArgs({ profilePath: plan.profilePath, except: plan.except });
  const args = ['--boot-timeout', '3m', 'on', udid, ...profileArgs, ...(opts.alreadyBooted ? ['--no-reboot'] : [])];
  opts.onProgress?.(`slimming simulator with simslim${plan.profilePath ? ` (${plan.profilePath})` : ''}…`);

  const res = await deps.runCmd(bin, args, { allowFail: true, timeoutMs: 210_000 }).catch((e: unknown) => ({
    code: 1, stdout: '', stderr: e instanceof Error ? e.message : String(e),
  }));

  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout || `exit ${res.code}`).trim().slice(0, 240);
    const fallbackReason = `simslim failed (${detail}); falling back to stock simulator boot`;
    opts.onProgress?.(fallbackReason);
    // Best-effort restore so the simulator isn't left half-slimmed.
    await deps.runCmd(bin, ['off', udid, '--preserve-boot-state'], { allowFail: true, timeoutMs: 60_000 }).catch(() => undefined);
    const info: SimslimDeviceInfo = { slimmed: false, checkedAt: new Date().toISOString(), fallbackReason };
    deviceSlimCache.set(udid, info);
    return { applied: false, info, fallbackReason };
  }

  const stRes = await deps.runCmd(bin, ['status', udid, '--json'], { allowFail: true, timeoutMs: 15_000 }).catch(() => undefined);
  const raw = stRes?.code === 0 ? parseJsonSafe(stRes.stdout) : undefined;
  const info = parseSimslimReport(raw, { profile: plan.profilePath ?? undefined, except: plan.profilePath ? undefined : plan.except });
  info.slimmed = true;
  deviceSlimCache.set(udid, info);
  if (info.disabledCount !== undefined) {
    opts.onProgress?.(`simslim active (${info.disabledCount}${info.managedTotal ? `/${info.managedTotal}` : ''} background daemons disabled)`);
  }
  return { applied: true, info };
}

export async function simslimDeviceAction(
  udid: string,
  action: 'status' | 'measure' | 'on' | 'off',
  opts: { except?: string[]; profilePath?: string | null; noReboot?: boolean } = {},
  deps: SimslimDeps = defaultDeps,
): Promise<SimslimDeviceInfo> {
  if (!UDID_RE.test(udid)) throw new PhoneDockError('Invalid simulator UDID', 'bad_request', 400);
  const bin = deps.resolveBinary();
  if (!bin) {
    throw new PhoneDockError('SimSlim is not installed on this Mac', 'not_supported', 501,
      ['Install simslim (e.g. `brew install sushilk1991/tap/simslim`) or set PHONEDOCK_SIMSLIM.']);
  }

  const setting = simslimSetting(deps);
  const profilePath = opts.profilePath !== undefined ? validateProfilePath(opts.profilePath, deps.exists) : setting.profilePath;
  const except = opts.except !== undefined ? validateSimslimCategories(opts.except) : setting.except;

  if (action === 'on') {
    const args = ['--boot-timeout', '3m', 'on', udid, ...simslimProfileArgs({ profilePath, except }), ...(opts.noReboot ? ['--no-reboot'] : [])];
    const r = await deps.runCmd(bin, args, { allowFail: true, timeoutMs: 210_000 });
    if (r.code !== 0) {
      throw new PhoneDockError('SimSlim could not slim this simulator', 'simslim_failed', 500,
        ['Check that the simulator runtime is supported by simslim, or boot it stock without --slim.'],
        (r.stderr || r.stdout).trim().slice(0, 600));
    }
  } else if (action === 'off') {
    const r = await deps.runCmd(bin, ['--boot-timeout', '3m', 'off', udid], { allowFail: true, timeoutMs: 210_000 });
    if (r.code !== 0) {
      throw new PhoneDockError('SimSlim could not restore this simulator to stock', 'simslim_failed', 500, undefined,
        (r.stderr || r.stdout).trim().slice(0, 600));
    }
    const info: SimslimDeviceInfo = { slimmed: false, disabledCount: 0, checkedAt: new Date().toISOString() };
    deviceSlimCache.set(udid, info);
    return info;
  }

  const [stRes, measRes] = await Promise.all([
    deps.runCmd(bin, ['status', udid, '--json'], { allowFail: true, timeoutMs: 15_000 }).catch(() => undefined),
    action === 'measure'
      ? deps.runCmd(bin, ['measure', udid, '--json'], { allowFail: true, timeoutMs: 30_000 }).catch(() => undefined)
      : Promise.resolve(undefined),
  ]);

  if (action === 'measure' && (!measRes || measRes.code !== 0)) {
    throw new PhoneDockError('SimSlim could not measure this simulator (is it booted?)', 'simslim_failed', 409,
      ['Boot the simulator first, then run simslim measure.'],
      (measRes?.stderr || measRes?.stdout || '').trim().slice(0, 600));
  }

  const stJson = stRes?.code === 0 ? parseJsonSafe(stRes.stdout) : undefined;
  const measJson = measRes?.code === 0 ? parseJsonSafe(measRes.stdout) : undefined;
  const merged = stJson || measJson ? { ...(stJson ?? {}), ...(measJson ?? {}) } : undefined;
  const info = parseSimslimReport(merged, { profile: profilePath ?? undefined, except: profilePath ? undefined : except });
  if (action === 'on') info.slimmed = true;
  deviceSlimCache.set(udid, info);
  return info;
}
