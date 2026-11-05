// Tiny argv parser (no deps). `--flag value`, `--flag=value`, boolean flags, `--no-flag`, short aliases,
// and `--` to stop flag parsing. Negative numbers (e.g. `-33.8`) are positionals, not flags.

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
  rest: string[];          // everything after `--`
}

export interface ParseSpec {
  boolean?: string[];                  // flags that never take a value
  alias?: Record<string, string>;      // short → long, e.g. { o: 'output', n: 'lines' }
}

export const GLOBAL_BOOLEAN = ['json', 'help', 'wait', 'no-wait', 'window', 'cold', 'boot', 'auto-start', 'force', 'system', 'headless', 'no-ocr', 'load', 'quiet', 'debug', 'pool',
  'reset', 'secret', 'submit', 'full', 'all', 'restart-adb', 'android', 'dry-run', 'check', 'uninstall', 'launch', 'get'];
export const GLOBAL_ALIAS: Record<string, string> = { o: 'output', n: 'lines', h: 'help', j: 'json', q: 'quiet' };

const camel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

export function parseArgs(argv: string[], spec: ParseSpec = {}): ParsedArgs {
  const bool = new Set([...(spec.boolean ?? GLOBAL_BOOLEAN)]);
  const alias = spec.alias ?? GLOBAL_ALIAS;
  const out: ParsedArgs = { positionals: [], flags: {}, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out.rest = argv.slice(i + 1); break; }
    const isNum = /^-\d/.test(a) || /^-\.\d/.test(a);
    if (a.startsWith('--') && a.length > 2) {
      let name = a.slice(2); let val: string | boolean | undefined;
      const eq = name.indexOf('=');
      if (eq >= 0) { val = name.slice(eq + 1); name = name.slice(0, eq); }
      if (val === undefined && name.startsWith('no-') && !bool.has(name)) { out.flags[camel(name.slice(3))] = false; continue; }
      if (val === undefined) {
        if (bool.has(name)) val = true;
        else if (i + 1 < argv.length && (!argv[i + 1].startsWith('-') || /^-\.?\d/.test(argv[i + 1]))) val = argv[++i];
        else val = true;
      }
      out.flags[camel(name)] = val;
    } else if (a.startsWith('-') && a.length > 1 && !isNum) {
      const short = a.slice(1);
      const name = alias[short] ?? short;
      if (bool.has(name)) out.flags[camel(name)] = true;
      else if (i + 1 < argv.length) out.flags[camel(name)] = argv[++i];
      else out.flags[camel(name)] = true;
    } else out.positionals.push(a);
  }
  return out;
}

/** Read a flag as string (undefined when absent or boolean). */
export function str(flags: ParsedArgs['flags'], name: string): string | undefined {
  const v = flags[name]; return typeof v === 'string' ? v : undefined;
}

/** Read a flag as number; throws on garbage. */
export function num(flags: ParsedArgs['flags'], name: string): number | undefined {
  const v = flags[name];
  if (v === undefined || v === false) return undefined;
  const n = Number(v);
  if (v === true || !Number.isFinite(n)) throw new Error(`--${name} expects a number`);
  return n;
}

export function bool(flags: ParsedArgs['flags'], name: string): boolean | undefined {
  const v = flags[name];
  if (v === undefined) return undefined;
  if (typeof v === 'boolean') return v;
  return !['0', 'false', 'no', 'off'].includes(v.toLowerCase());
}

/** Render rows as an aligned text table. */
export function table(rows: Record<string, unknown>[], cols: string[]): string {
  if (!rows.length) return '(none)';
  const cell = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const data = rows.map((r) => cols.map((c) => cell(r[c])));
  const w = cols.map((c, i) => Math.min(60, Math.max(c.length, ...data.map((d) => d[i].length))));
  const fmt = (cells: string[]) => cells.map((c, i) => (c.length > w[i] ? c.slice(0, w[i] - 1) + '…' : c.padEnd(w[i]))).join('  ').trimEnd();
  return [fmt(cols.map((c) => c.toUpperCase())), ...data.map(fmt)].join('\n');
}
