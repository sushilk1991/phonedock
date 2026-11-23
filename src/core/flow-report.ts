// Self-contained, script-free flow reports. Screen pixels cannot be reliably redacted: make that limit explicit.
import { existsSync, readFileSync, realpathSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { FlowResult, SuiteResult } from './flow-runner.ts';
import { expandSecretForms } from './secrets.ts';

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function redactText(s: string, secrets: readonly string[]): string {
  for (const secret of expandSecretForms(secrets)) s = s.replaceAll(secret, '•••');
  return s;
}
/** Redact all string values, including a secret echoed by a backend in an error or an assertion. */
export function redactValue<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === 'string') return redactText(value, secrets) as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, secrets)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, secrets)])) as T;
  return value;
}

const STYLE = `:root{color-scheme:light dark;font:15px system-ui,sans-serif}body{max-width:1080px;margin:32px auto;padding:0 20px;line-height:1.55}h1,h2,h3{line-height:1.25}article{border:1px solid #8886;border-radius:12px;margin:20px 0;padding:20px}ol{padding-left:28px}li{padding:8px;border-bottom:1px solid #8884}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#8881;padding:12px;border-radius:8px}img{max-width:100%;max-height:650px;object-fit:contain;vertical-align:middle}figure{display:inline-block;vertical-align:top;max-width:45%;margin:8px}.shot{position:relative;display:inline-block}.marker{position:absolute;width:12px;height:12px;background:#ee3939;border:2px solid white;box-shadow:0 0 0 2px #ee3939;border-radius:50%;transform:translate(-50%,-50%)}.pass{color:#268643}.fail{color:#c84545}.warn,.skip{color:#9b741d}small{color:#777}a{color:inherit}@media(max-width:600px){figure{max-width:100%}}`;
const inside = (root: string, path: string) => { const r = relative(root, path); return r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
interface ReportBudget { remaining: number }

function evidence(dir: string | undefined, secrets: readonly string[], omit: Set<string>, budget: ReportBudget): string {
  if (!dir || !existsSync(dir)) return '';
  const root = realpathSync(dir);
  const files = readdirSync(dir).filter((n) => !n.startsWith('.') && n !== 'result.json' && n !== 'report.html' && !omit.has(resolve(dir, n))).sort();
  const blocks: string[] = [];
  for (const name of files) {
    const path = resolve(dir, name);
    // Reports never follow an artifact symlink outside their own directory or embed unbounded files.
    let resolved: string;
    try { resolved = realpathSync(path); } catch { continue; }
    if (!inside(root, resolved) || !statSync(path).isFile()) continue;
    const size = statSync(path).size;
    const label = escapeHtml(redactText(name, secrets));
    if (size > 8 * 1024 * 1024 || size > budget.remaining) { blocks.push(`<p>Evidence omitted because of report size limit: ${label}</p>`); continue; }
    if (/\.png$/i.test(name)) { budget.remaining -= size; blocks.push(`<figure><figcaption>${label}</figcaption><img alt="${label}" src="data:image/png;base64,${readFileSync(path).toString('base64')}"></figure>`); }
    else if (/\.(txt|json|log)$/i.test(name)) { budget.remaining -= size; blocks.push(`<details><summary>${label}</summary><pre>${escapeHtml(redactText(readFileSync(path, 'utf8'), secrets))}</pre></details>`); }
  }
  return blocks.join('\n');
}

function stepImage(file: string | undefined, dir: string | undefined, label: string, budget: ReportBudget, point?: { x: number; y: number }): string {
  if (!file || !dir) return '';
  try {
    const path = realpathSync(file);
    const size = statSync(path).size;
    if (!inside(realpathSync(dir), path) || size > 8 * 1024 * 1024 || size > budget.remaining) return '<p>Screenshot omitted from this report.</p>';
    budget.remaining -= size;
    const png = readFileSync(path);
    let marker = '';
    if (point && png.length >= 24 && png.readUInt32BE(0) === 0x89504e47) {
      const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
      if (w && h && point.x >= 0 && point.x <= w && point.y >= 0 && point.y <= h) marker = `<span class="marker" role="img" aria-label="Action point" style="left:${point.x / w * 100}%;top:${point.y / h * 100}%"></span>`;
    }
    return `<figure><figcaption>${label}</figcaption><span class="shot"><img alt="${label}" src="data:image/png;base64,${png.toString('base64')}">${marker}</span></figure>`;
  } catch { return '<p>Screenshot is unavailable.</p>'; }
}

function flowSection(flow: FlowResult, secrets: readonly string[], budget: ReportBudget): string {
  const f = redactValue(flow, secrets);
  const used = new Set<string>();
  const steps = f.steps.map((s, i) => {
    const original = flow.steps[i];
    for (const p of [original.beforeScreenshot, original.screenshot]) if (p) used.add(resolve(p));
    return `<li class="${escapeHtml(s.status)}"><strong>${s.status.toUpperCase()}</strong> ${escapeHtml(s.description)} <small>${s.ms} ms</small>${s.message ? `<pre>${escapeHtml(s.message)}</pre>` : ''}<div>${stepImage(original.beforeScreenshot, flow.artifacts, 'Before', budget, original.actionPoint)}${stepImage(original.screenshot, flow.artifacts, original.beforeScreenshot ? 'After' : 'Checkpoint', budget)}</div></li>`;
  }).join('');
  return `<article><h2 class="${escapeHtml(f.status)}">${escapeHtml(f.name)} — ${f.status.toUpperCase()}</h2><p>${escapeHtml(f.device ?? 'No device')} · ${(f.ms / 1000).toFixed(2)} s · ${f.attempts} attempt(s)</p>${f.message ? `<pre>${escapeHtml(f.message)}</pre>` : ''}<ol>${steps}</ol>${evidence(flow.artifacts, secrets, used, budget)}</article>`;
}

export function writeFlowReport(path: string, flows: FlowResult[], secrets: readonly string[] = []): string {
  mkdirSync(dirname(path), { recursive: true });
  const budget = { remaining: 32 * 1024 * 1024 };
  const body = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>PhoneDock flow report</title><style>${STYLE}</style><body><h1>PhoneDock flow report</h1><p>${flows.filter((f) => f.status === 'pass').length} passed · ${flows.filter((f) => f.status === 'fail').length} failed · ${flows.filter((f) => f.status === 'skip').length} skipped</p><p><small>Known secret text is redacted. Screenshots contain original screen pixels and may contain private information; review before sharing. Pixel comparisons use full-resolution color by default; thumbnail mode uses 64px grayscale.</small></p>${flows.map((f) => flowSection(f, secrets, budget)).join('\n')}</body></html>`;
  writeFileSync(path, body);
  return path;
}

export function writeSuiteReport(suite: SuiteResult, secrets: readonly string[] = []): string {
  return writeFlowReport(resolve(suite.artifactsDir, 'report.html'), suite.flows, secrets);
}
