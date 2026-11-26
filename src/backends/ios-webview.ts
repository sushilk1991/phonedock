// Read-only Safari & WKWebView Web Inspector diagnostics for iOS Simulators.
// Connects directly to the simulator's `RWI_LISTEN_SOCKET` via `tools/pd-ios-sim-webview.py`
// (Python 3 stdlib only, no external dependencies, no DOM mutations).
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../core/exec.ts';
import { toolEnv } from '../core/paths.ts';
import { PhoneDockError } from '../core/types.ts';
import {
  diagnosticUrl,
  measureExpression,
  parseMeasureResult,
  parseSnapshotResult,
  snapshotExpression,
  validateWebViewOptions,
  type WebViewNetwork,
  type WebViewOptions,
  type WebViewResult,
  type WebViewTarget,
} from './android-webview.ts';

export interface IosSimWebViewDeps {
  resolveSocket(udid: string): Promise<string | undefined>;
  runHelper(scriptPath: string, payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>>;
  scriptPath(): string | undefined;
}

export function iosSimWebViewScript(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const cands = [
    process.env.PHONEDOCK_IOS_SIM_WEBVIEW_HELPER,
    resolve(here, '..', '..', 'tools', 'pd-ios-sim-webview.py'),
    resolve(here, '..', 'tools', 'pd-ios-sim-webview.py'),
    resolve(process.cwd(), 'tools', 'pd-ios-sim-webview.py'),
  ];
  return cands.find((c) => c && existsSync(c));
}

async function resolveSimulatorRwiSocket(udid: string): Promise<string | undefined> {
  const r = await run('xcrun', ['simctl', 'getenv', udid, 'RWI_LISTEN_SOCKET'], {
    env: toolEnv(),
    allowFail: true,
    timeoutMs: 10_000,
  });
  const path = r.code === 0 ? r.stdout.trim() : '';
  return path && existsSync(path) ? path : undefined;
}

async function runPythonHelper(scriptPath: string, payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  const r = await run('python3', [scriptPath], {
    env: toolEnv(),
    input: JSON.stringify(payload),
    allowFail: true,
    timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout || '{}');
  } catch {
    throw new PhoneDockError('The iOS Simulator Web Inspector returned an invalid response', 'webview_debug_failed', 502, undefined,
      (r.stderr || r.stdout).trim().slice(0, 500));
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PhoneDockError('The iOS Simulator Web Inspector returned an invalid response', 'webview_debug_failed', 502);
  }
  return parsed as Record<string, unknown>;
}

const defaultDeps: IosSimWebViewDeps = {
  resolveSocket: resolveSimulatorRwiSocket,
  runHelper: runPythonHelper,
  scriptPath: iosSimWebViewScript,
};

export async function inspectIosSimWebView(
  udid: string,
  options: WebViewOptions,
  overrides: Partial<IosSimWebViewDeps> = {},
): Promise<WebViewResult> {
  const deps: IosSimWebViewDeps = { ...defaultDeps, ...overrides };
  validateWebViewOptions(options, { requireAppId: false });
  if (typeof udid !== 'string' || !udid || udid.length > 100 || /[\r\n\0]/.test(udid)) {
    throw new PhoneDockError('A valid iOS Simulator UDID is required', 'bad_request', 400);
  }
  const script = deps.scriptPath();
  if (!script) {
    throw new PhoneDockError('iOS Simulator Web Inspector helper is missing', 'not_supported', 501);
  }
  const socketPath = await deps.resolveSocket(udid);
  if (!socketPath) {
    throw new PhoneDockError('The iOS Simulator Web Inspector socket is not available', 'offline', 409,
      ['Make sure the simulator is booted and has Safari or a debuggable WKWebView open.']);
  }

  const max = options.maxElements ?? 200;
  const captureMs = options.captureMs ?? 2000;
  const expression = options.action === 'snapshot'
    ? snapshotExpression(max)
    : options.action === 'measure'
      ? measureExpression(options.selector!, max)
      : undefined;

  const reply = await deps.runHelper(script, {
    socketPath,
    action: options.action,
    ...(options.appId ? { appId: options.appId } : {}),
    ...(options.targetId ? { targetId: options.targetId } : {}),
    ...(expression ? { expression } : {}),
    captureMs,
  }, options.action === 'network' ? captureMs + 12_000 : 12_000);

  if (reply.ok !== true) {
    const code = typeof reply.code === 'string' ? reply.code : 'webview_debug_failed';
    const msg = typeof reply.error === 'string' ? reply.error : 'iOS Simulator Web Inspector failed';
    if (code === 'not_supported') {
      throw new PhoneDockError(msg, 'not_supported', 501, [
        'Open a webpage in Safari (e.g. `open_url`) or open a debuggable WKWebView (`isInspectable = true`) in your app.',
      ]);
    }
    if (code === 'ambiguous_target') {
      const available = Array.isArray(reply.availableTargets)
        ? reply.availableTargets.slice(0, 20).map((t: any) => ({
            id: String(t?.id ?? '').slice(0, 200),
            ...(typeof t?.appId === 'string' && t.appId ? { appId: t.appId.slice(0, 200) } : {}),
            title: String(t?.title ?? '').slice(0, 200),
            url: diagnosticUrl(t?.url),
          }))
        : [];
      throw new PhoneDockError('Choose one inspectable Safari tab or WebView target', 'ambiguous_target', 409,
        ['Pass targetId from the availableTargets error detail (or filter with appId).'],
        JSON.stringify({ availableTargets: available }));
    }
    throw new PhoneDockError(msg, code, code === 'bad_request' ? 400 : 502);
  }

  const rawTarget = (reply.target ?? {}) as Record<string, unknown>;
  const target: WebViewTarget = {
    id: String(rawTarget.id ?? '').slice(0, 200),
    ...(typeof rawTarget.appId === 'string' && rawTarget.appId ? { appId: rawTarget.appId.slice(0, 200) } : {}),
    title: String(rawTarget.title ?? '').slice(0, 200),
    url: diagnosticUrl(rawTarget.url),
  };

  if (options.action === 'snapshot') {
    return parseSnapshotResult(reply.value, target, options.bounds);
  }
  if (options.action === 'measure') {
    return parseMeasureResult(reply.value, target, options.selector!, options.bounds);
  }
  const rawReqs = Array.isArray(reply.requests) ? reply.requests : [];
  const requests = rawReqs.slice(0, 500).map((r: any) => ({
    method: typeof r?.method === 'string' ? r.method.slice(0, 16) : '?',
    url: diagnosticUrl(r?.url),
    ...(typeof r?.status === 'number' && Number.isFinite(r.status) ? { status: r.status } : {}),
    ...(typeof r?.durationMs === 'number' && Number.isFinite(r.durationMs) ? { durationMs: r.durationMs } : {}),
    ...(r?.failed === true ? { failed: true } : {}),
  }));
  return {
    action: 'network',
    source: 'webview-cdp',
    target,
    captureMs,
    requests,
    truncated: reply.truncated === true || rawReqs.length > 500,
    warnings: ['Only requests observed during this Web Inspector session are included. URL paths may still contain sensitive information; review before sharing.'],
  } satisfies WebViewNetwork;
}
