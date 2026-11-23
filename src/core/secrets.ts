import { launchSecretValues } from './launch-options.ts';

/** Values explicitly marked secret by the caller, plus launch args/env values. An empty secret still masks structured field contents. */
export function inputSecretValues(body: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (o.secret === true) for (const key of ['text', 'value']) if (typeof o[key] === 'string') out.push(o[key]);
    for (const child of Object.values(o)) if (child && typeof child === 'object') visit(child);
  };
  visit(body);
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const b = body as Record<string, unknown>;
    if ('args' in b || 'env' in b) out.push(...launchSecretValues({ args: b.args, env: b.env }));
  }
  return [...new Set(out)];
}
/** Expand each secret with its JSON-string-escaped form (e.g. `abc"def` → `abc\"def`) so JSON.stringify diagnostics cannot bypass redaction. */
export function expandSecretForms(secrets: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const s of secrets) {
    if (!s) continue;
    forms.add(s);
    const escaped = JSON.stringify(s).slice(1, -1);
    if (escaped && escaped !== s) forms.add(escaped);
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

/** Redact secret substrings (and their JSON-escaped forms) recursively without blanking unrelated field names. */
export function redactSecretStrings<T>(value: T, secrets: readonly string[]): T {
  const forms = expandSecretForms(secrets);
  if (!forms.length) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      let out = v;
      for (const secret of forms) out = out.split(secret).join('•••');
      return out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** Redact diagnostics and structured field contents without ever storing the request body. */
export function redactInputValue<T>(value: T, secrets: readonly string[], key = ''): T {
  if (typeof value === 'string') {
    if (secrets.length && /^(text|value|previousValue|finalValue|label)$/.test(key)) return '•••' as T;
    let out: string = value;
    for (const secret of expandSecretForms(secrets)) out = out.split(secret).join('•••');
    return out as T;
  }
  if (Array.isArray(value)) return value.map((v) => redactInputValue(v, secrets)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactInputValue(v, secrets, k)])) as T;
  return value;
}
