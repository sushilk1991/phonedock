// Launch arguments and environment validation, platform mapping, and secret redaction.
// Values can be credentials/tokens and must never appear in action logs, flow save output, reports, or run records.
import { PhoneDockError, type LaunchArgs, type LaunchArgValue, type LaunchOptions } from './types.ts';

const MAX_ENTRIES = 64;
const MAX_KEY_LEN = 256;
const MAX_VALUE_LEN = 4096;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

function badLaunch(message: string, detail?: string): PhoneDockError {
  return new PhoneDockError(message, 'bad_request', 400, undefined, detail, 'not_sent');
}

function checkString(v: unknown, what: string, maxLen = MAX_VALUE_LEN): string {
  if (typeof v !== 'string') throw badLaunch(`${what} must be a string`);
  if (v.length > maxLen) throw badLaunch(`${what} is too long (max ${maxLen} characters)`);
  if (v.includes('\0')) throw badLaunch(`${what} must not contain NUL bytes`);
  return v;
}

function checkExtraValue(v: unknown, key: string): LaunchArgValue {
  if (typeof v === 'string') return checkString(v, `args[${JSON.stringify(key)}]`);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw badLaunch(`args[${JSON.stringify(key)}] must be a finite number`);
    if (Number.isInteger(v) && !Number.isSafeInteger(v)) {
      throw badLaunch(`args[${JSON.stringify(key)}] integer is outside safe 53-bit range`);
    }
    return v;
  }
  throw badLaunch(`args[${JSON.stringify(key)}] must be a string, number, or boolean`);
}

/** Validate and normalise launch `args` and `env`. Empty arrays/objects normalise to undefined. */
export function validateLaunchOptions(rawArgs: unknown, rawEnv: unknown): LaunchOptions | undefined {
  let args: LaunchArgs | undefined;
  if (rawArgs !== undefined && rawArgs !== null) {
    if (Array.isArray(rawArgs)) {
      if (rawArgs.length > MAX_ENTRIES) throw badLaunch(`Too many launch arguments (max ${MAX_ENTRIES})`);
      const list = rawArgs.map((item, i) => checkString(item, `args[${i}]`));
      if (list.length) args = list;
    } else if (isPlainObject(rawArgs)) {
      const entries = Object.entries(rawArgs);
      if (entries.length > MAX_ENTRIES) throw badLaunch(`Too many launch arguments (max ${MAX_ENTRIES})`);
      const map: Record<string, LaunchArgValue> = {};
      for (const [k, v] of entries) {
        if (!k || k.length > MAX_KEY_LEN || k.includes('\0')) throw badLaunch(`Invalid launch argument key ${JSON.stringify(k)}`);
        map[k] = checkExtraValue(v, k);
      }
      if (entries.length) args = map;
    } else {
      throw badLaunch('args must be an array of strings or a key-value object of string/number/boolean');
    }
  }

  let env: Record<string, string> | undefined;
  if (rawEnv !== undefined && rawEnv !== null) {
    if (!isPlainObject(rawEnv)) throw badLaunch('env must be an object mapping variable names to strings');
    const entries = Object.entries(rawEnv);
    if (entries.length > MAX_ENTRIES) throw badLaunch(`Too many launch environment variables (max ${MAX_ENTRIES})`);
    const map: Record<string, string> = {};
    for (const [k, v] of entries) {
      if (!ENV_KEY_RE.test(k)) throw badLaunch(`Invalid environment variable name ${JSON.stringify(k)} (expected [A-Za-z_][A-Za-z0-9_]*)`);
      map[k] = checkString(v, `env.${k}`);
    }
    if (entries.length) env = map;
  }

  if (!args && !env) return undefined;
  return { ...(args ? { args } : {}), ...(env ? { env } : {}) };
}

export function hasLaunchOptions(opts?: LaunchOptions): boolean {
  if (!opts) return false;
  const hasArgs = Array.isArray(opts.args) ? opts.args.length > 0 : !!opts.args && Object.keys(opts.args).length > 0;
  const hasEnv = !!opts.env && Object.keys(opts.env).length > 0;
  return hasArgs || hasEnv;
}

/** Convert LaunchArgs into iOS argv: string[] as-is; key-value map → ["-key", "value", ...] (NSUserDefaults/Maestro). */
export function iosLaunchArgv(args?: LaunchArgs): string[] {
  if (!args) return [];
  if (Array.isArray(args)) return [...args];
  const out: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    out.push(k.startsWith('-') ? k : `-${k}`, String(v));
  }
  return out;
}

/** Build a child-process env with SIMCTL_CHILD_* or DEVICECTL_CHILD_* prefixes on top of `base`. */
export function iosPrefixedEnv(prefix: 'SIMCTL_CHILD_' | 'DEVICECTL_CHILD_', base: NodeJS.ProcessEnv, env?: Record<string, string>): NodeJS.ProcessEnv {
  if (!env || !Object.keys(env).length) return base;
  const out: NodeJS.ProcessEnv = { ...base };
  for (const [k, v] of Object.entries(env)) out[`${prefix}${k}`] = v;
  return out;
}

/** Convert a validated key-value map into typed `am start` extra flags (--es / --ez / --ei / --el / --ef), shell-quoted. */
export function androidIntentExtraFlags(args: Record<string, LaunchArgValue>, quote: (s: string) => string): string[] {
  const out: string[] = [];
  for (const [k, raw] of Object.entries(args)) {
    if (!k || k.length > MAX_KEY_LEN || k.includes('\0')) throw badLaunch(`Invalid launch argument key ${JSON.stringify(k)}`);
    const v = checkExtraValue(raw, k);
    if (typeof v === 'boolean') {
      out.push('--ez', quote(k), v ? 'true' : 'false');
    } else if (typeof v === 'number') {
      if (Number.isInteger(v)) {
        out.push(v >= INT32_MIN && v <= INT32_MAX ? '--ei' : '--el', quote(k), String(v));
      } else {
        out.push('--ef', quote(k), String(v));
      }
    } else {
      out.push('--es', quote(k), quote(v));
    }
  }
  return out;
}

/** Sensitive string values from launch args/env for global error/log scrubbing (skips 1-char and true/false literals). */
export function launchSecretValues(opts?: { args?: unknown; env?: unknown }): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v !== 'string' || v.length < 2) return;
    if (v === 'true' || v === 'false') return;
    out.push(v);
  };
  if (Array.isArray(opts?.args)) {
    for (const v of opts.args) add(v);
  } else if (opts?.args && typeof opts.args === 'object') {
    for (const v of Object.values(opts.args as Record<string, unknown>)) add(v);
  }
  if (opts?.env && typeof opts.env === 'object' && !Array.isArray(opts.env)) {
    for (const v of Object.values(opts.env as Record<string, unknown>)) add(v);
  }
  return [...new Set(out)];
}

/** Safe action-log metadata for a launch call: never contains values. */
export function launchLogMeta(opts?: LaunchOptions): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (opts?.args) {
    if (Array.isArray(opts.args) && opts.args.length) {
      meta.hasArgs = true;
      meta.argCount = opts.args.length;
    } else if (!Array.isArray(opts.args) && Object.keys(opts.args).length) {
      meta.hasArgs = true;
      meta.argKeys = Object.keys(opts.args);
    }
  }
  if (opts?.env && Object.keys(opts.env).length) {
    meta.envKeys = Object.keys(opts.env);
  }
  return meta;
}

/** Short human summary suffix for launch output (never includes values). */
export function launchSummarySuffix(opts?: LaunchOptions): string {
  const bits: string[] = [];
  if (opts?.args) {
    const n = Array.isArray(opts.args) ? opts.args.length : Object.keys(opts.args).length;
    if (n) bits.push(`${n} arg${n === 1 ? '' : 's'}`);
  }
  if (opts?.env) {
    const n = Object.keys(opts.env).length;
    if (n) bits.push(`${n} env var${n === 1 ? '' : 's'}`);
  }
  return bits.length ? ` (with ${bits.join(', ')})` : '';
}

/** Mask every launch argument and environment value in a flow step before writing reports/results/manifests. */
export function redactLaunchStep<T>(step: T): T {
  if (!step || typeof step !== 'object' || (step as { kind?: string }).kind !== 'launch') return step;
  const s = step as Record<string, unknown>;
  if (s.arguments === undefined && s.env === undefined) return step;
  const copy: Record<string, unknown> = { ...s };
  if (Array.isArray(s.arguments)) {
    copy.arguments = s.arguments.map(() => '•••');
  } else if (s.arguments && typeof s.arguments === 'object') {
    copy.arguments = Object.fromEntries(Object.keys(s.arguments as Record<string, unknown>).map((k) => [k, '•••']));
  }
  if (s.env && typeof s.env === 'object' && !Array.isArray(s.env)) {
    copy.env = Object.fromEntries(Object.keys(s.env as Record<string, unknown>).map((k) => [k, '•••']));
  }
  return copy as T;
}
