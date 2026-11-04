// MCP tools for performance traces: start_trace / stop_trace (the daemon's /trace routes). Registered from
// createMcpServer() via registerTraceTools(). The loop they teach: start_trace → drive the slow flow (batch / run_flow /
// taps) → stop_trace → read the summary → change the code, rebuild, reinstall → repeat and compare.
import { z } from 'zod';
import type { ToolKit } from './server.ts';

export function registerTraceTools(k: ToolKit): void {
  const { tool, c, target, text } = k;

  tool('start_trace', 'Start a performance trace of one app, to measure a slow flow and compare runs. iOS (simulator or iPhone): an Instruments recording (xctrace, template "Time Profiler" by default, with Hangs added) attached to the running app. Android: a perfetto system trace plus frame stats (dumpsys gfxinfo) for the same window. The loop: start_trace → drive the slow flow (batch, run_flow or taps) → stop_trace → read the summary (hangs and main-thread hot spots on iOS, janky frames and frame-time percentiles on Android) → change the code, rebuild, reinstall → start_trace again with the same app and template → stop_trace shows each metric before → after. One trace per device; it stops by itself after time_limit_sec. Open the app first (or pass launch=true). On a real iPhone the app must be a development build.', {
    device: k.deviceParam,
    app_id: z.string().describe('Bundle id (iOS) or package name (Android) of the app to trace'),
    template: z.string().optional().describe('iOS only: Instruments template, e.g. "Time Profiler" (default), "Animation Hitches", "SwiftUI", "System Trace", "Allocations" (see `xcrun xctrace list templates`). Keep it the same across runs you compare.'),
    time_limit_sec: z.number().int().min(2).max(600).optional().describe('Stop recording after this long (default 60, max 600). Keep the traced flow short and repeatable.'),
    launch: z.boolean().optional().describe('Start the app first if it is not running (default false: error if it is not running)'),
  }, async (a) => {
    const d = await target(a.device);
    const r = await c.startTrace(d.id, { appId: a.app_id, template: a.template, timeLimitSec: a.time_limit_sec, launch: a.launch });
    const extra = r.instruments.length ? ` + ${r.instruments.join(', ')}` : '';
    const proc = r.process?.pid ? ` (pid ${r.process.pid})` : '';
    return { content: [text(`Tracing ${r.appId}${proc} on ${d.name}: ${r.tool} "${r.template}"${extra}, trace ${r.traceId}, stops by itself after ${r.timeLimitSec} s.${r.launched ? ' The app was launched for it.' : ''}\nNow drive the flow you want to measure (batch / run_flow / taps), then call stop_trace${a.device ? ` (device="${a.device}")` : ''} for the summary.`)] };
  });

  tool('stop_trace', 'Stop the performance trace started with start_trace, check the trace file opens, and return a compact summary (same keys every run): duration; iOS: hangs by severity with the longest, main-thread CPU time, the heaviest main-thread functions (self time) and the heaviest functions in the app\'s own code, plus the capped `xctrace triage --style hangs` report; Android: frames rendered, janky frames and %, p50/p90/p95/p99 frame times. It also compares with the previous trace of the same app and template on this device ("hangs 2 → 0 (−2)"). The Metrics line is one JSON object: diff it between runs. File paths (the .trace / .perfetto-trace, summary.json) are included for deeper digging with `xcrun xctrace show` / `xctrace help` or ui.perfetto.dev. Also returns a trace that already hit its time limit.', {
    device: k.deviceParam,
    compare_to: z.string().optional().describe('traceId of an earlier trace to compare with (default: the previous trace of this app + template on this device; "none" for no comparison)'),
    top: z.number().int().min(0).max(25).optional().describe('How many hot spots to list (default 5)'),
    triage_chars: z.number().int().min(0).max(20000).optional().describe('iOS: how much of the hangs triage report to include (default 1200 characters; 0 = none)'),
  }, async (a) => {
    const d = await target(a.device);
    const r = await c.stopTrace(d.id, { compareTo: a.compare_to, top: a.top, triageChars: a.triage_chars });
    return { content: [text(r.text)] };
  });
}
