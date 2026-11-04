// MCP tools for flows: save_flow (this session's actions → a flow file) and run_flow (run flow files, PASS/FAIL per
// step). Registered from createMcpServer() via registerFlowTools(). Format and conversion: src/core/flow.ts.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { parseFlow } from '../core/flow.ts';
import { collectFlowFiles, displayPath, junitXml, runFlow, runFlowFiles, type SuiteResult } from '../core/flow-runner.ts';
import { phonedockHome } from '../sdk/client.ts';
import type { ToolKit } from './server.ts';

const expandHome = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') ? homedir() + p.slice(1) : p);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'flow';
const rel = displayPath;

export function registerFlowTools(k: ToolKit): void {
  const { tool, c, target, text } = k;

  tool('save_flow', 'Save what you just did on a device as a regression test (a PhoneDock flow: readable YAML that `phonedock test` and run_flow replay, e.g. in CI). Built from the daemon\'s log of your actions: taps by text become text selectors, fill stays one step, repeated reads, timed-out waits, failed scroll_tos and taps you undid are left out, and assertions are added for the first screen after each launch and for the final screen. Pass `assertions` with the texts that prove the flow worked (e.g. ["Hello, Ada!"]); they replace the automatic final check. Covers your own actions in this session by default (since your last acquire/lease, else after the last 15-minute pause); use `since` ("10m" or an ISO time) to cut it. Returns the file path and its contents: read them and fix anything that looks wrong.', {
    device: k.deviceParam,
    path: z.string().optional().describe('Where to write the flow (default flows/<name>.yaml in the current directory; .json for JSON)'),
    name: z.string().optional().describe('Flow name, e.g. "Sign in and open settings"'),
    assertions: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).optional()
      .describe('Final checks: texts that must be visible ("!text" = must NOT be visible), or flow steps such as {"assert_text": {"field": "id:status", "equals": "On"}}'),
    since: z.string().optional().describe('Start of the range: ISO time or a duration back from now ("10m", "1h")'),
    until: z.string().optional().describe('End of the range (default now)'),
    owner: z.string().optional().describe('Whose actions: default your own; "all" for everyone\'s (e.g. you and a person on the same device)'),
    app_id: z.string().optional().describe('The app under test (default: the first app launched)'),
    auto_assert: z.boolean().optional().describe('Add assertions automatically (default true)'),
    keep_noise: z.boolean().optional().describe('Keep undone taps (default false)'),
    overwrite: z.boolean().optional().describe('Replace an existing file at path (default false)'),
  }, async (a) => {
    const d = await target(a.device);
    const asJson = /\.json$/i.test(a.path ?? '');
    const r = await c.saveFlow(d.id, {
      since: a.since, until: a.until, owner: a.owner === 'all' ? undefined : a.owner ?? c.owner, name: a.name, appId: a.app_id,
      assertions: a.assertions, autoAssert: a.auto_assert, keepNoise: a.keep_noise, format: asJson ? 'json' : 'yaml',
    });
    if (!r.stats.steps) {
      return { content: [text(`Nothing to save: no actions by ${r.range.owner ?? 'anyone'} on ${d.name} since ${r.range.since ?? 'the start of the log'}.${r.warnings.length ? `\n${r.warnings.join('\n')}` : ''}\nPass since="30m" (or owner="all" if someone else drove the device).`)], isError: true };
    }
    const file = resolve(expandHome(a.path ?? join('flows', `${slug(a.name ?? r.flow.appId ?? 'flow')}.${asJson ? 'json' : 'yaml'}`)));
    if (existsSync(file) && !a.overwrite) throw new Error(`${file} already exists: pass overwrite=true or another path`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, r.text);
    const lines = [
      `Saved ${file}: ${r.stats.steps} steps, ${r.stats.assertions} assertion${r.stats.assertions === 1 ? '' : 's'} (from ${r.stats.entries} logged actions${r.range.owner ? ` by ${r.range.owner}` : ''} since ${r.range.since ?? 'the start'}).`,
      ...r.warnings.map((w) => `Note: ${w}`),
      ...(r.dropped.length ? [`Left out: ${r.dropped.join('; ')}`] : []),
      `Run it: run_flow(path="${rel(file)}") here, or \`phonedock test ${rel(file)} --device ${d.name}\` in a terminal / CI.`,
      '', r.text.trimEnd(),
    ];
    return { content: [text(lines.join('\n'))] };
  });

  tool('run_flow', 'Run PhoneDock flows (YAML/JSON regression tests, e.g. from save_flow) on a device and report PASS/FAIL per step with timings. Each step waits for its element (default 10 s) and the screen settles between steps. On failure you get the step, what was expected and what was on screen, plus a folder with a screenshot, the UI tree and recent logs. Pass `path` (a file or a folder of flows) or `flow` (the YAML text itself).', {
    device: k.deviceParam,
    path: z.string().optional().describe('Flow file, or a folder of flows (*.yaml, *.yml, *.json)'),
    flow: z.string().optional().describe('Alternative to path: the flow YAML itself'),
    artifacts_dir: z.string().optional().describe('Where failure artifacts go (default <PhoneDock home>/test-runs/<time>)'),
    junit: z.string().optional().describe('Also write JUnit XML to this file'),
    retries: z.number().int().min(0).max(5).optional().describe('Run a failed flow again up to N times (default 0)'),
    timeout_ms: z.number().int().min(100).max(120_000).optional().describe('Default wait for elements and assertions (default 10000)'),
    env: z.record(z.string(), z.string()).optional().describe('Values for ${VAR} in the flow'),
  }, async (a, extra) => {
    if (!a.path === !a.flow) throw new Error('Pass path (a flow file or folder) or flow (the YAML text), not both');
    const d = await target(a.device);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const artifactsDir = resolve(expandHome(a.artifacts_dir ?? join(phonedockHome(), 'test-runs', stamp)));
    const lines: string[] = []; let n = 0;
    const token = extra?._meta?.progressToken;
    const log = (l: string) => {
      lines.push(l);
      if (token !== undefined && extra?.sendNotification && /^\s+(PASS|FAIL|WARN)\s/.test(l)) {
        void extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++n, message: l.trim().split('\n')[0] } }).catch(() => {});
      }
    };
    const opts = { deviceId: d.id, artifactsDir, retries: a.retries, timeoutMs: a.timeout_ms, env: a.env, log, signal: extra?.signal };
    let suite: SuiteResult;
    if (a.flow) {
      const f = parseFlow(a.flow, join(tmpdir(), 'inline-flow.yaml'));
      f.file = undefined;
      const t0 = Date.now(); const r = await runFlow(c, f, opts);
      suite = { flows: [r], passed: r.status === 'pass' ? 1 : 0, failed: r.status === 'fail' ? 1 : 0, skipped: r.status === 'skip' ? 1 : 0, ms: Date.now() - t0, artifactsDir };
      lines.push(`${r.status.toUpperCase()}  ${r.name}${r.message && r.status !== 'pass' ? `: ${r.message.split('\n')[0]}` : ''}`);
    } else {
      const files = collectFlowFiles([resolve(expandHome(a.path!))]);
      if (!files.length) throw new Error(`No flow files (*.yaml, *.yml, *.json) in ${a.path}`);
      suite = await runFlowFiles(c, files, opts);
    }
    if (a.junit) { const j = resolve(expandHome(a.junit)); mkdirSync(dirname(j), { recursive: true }); writeFileSync(j, junitXml(suite)); lines.push(`JUnit: ${j}`); }
    const ok = suite.failed === 0 && suite.passed > 0;
    const head = `${ok ? 'PASSED' : 'FAILED'}: ${suite.passed} passed, ${suite.failed} failed, ${suite.skipped} skipped on ${d.name} (${(suite.ms / 1000).toFixed(1)} s).`;
    const arts = suite.flows.filter((f) => f.artifacts).map((f) => `Artifacts for "${f.name}": ${f.artifacts} (failure.png, ui.txt, logs.txt, steps.txt)`);
    return { content: [text([head, ...arts, '', ...lines].join('\n').trimEnd())], ...(ok ? {} : { isError: true }) };
  });
}

