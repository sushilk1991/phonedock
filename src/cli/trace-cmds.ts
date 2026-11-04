// `phonedock trace start|stop|status|ls|run` – performance traces (docs/API.md "Performance traces").
// `trace run` wraps a flow file end to end: start the trace, run the flow (src/core/flow-runner.ts), stop, summarize.
import { join, resolve } from 'node:path';
import type { PhoneDockClient, TraceStopResult } from '../sdk/client.ts';
import { collectFlowFiles, runFlowFiles } from '../core/flow-runner.ts';
import { phonedockHome } from '../sdk/client.ts';
import { str, num, table, type ParsedArgs } from './args.ts';

export const TRACE_USAGE = 'trace start <id> --app <bundle id|package> [--template T] [--time-limit S] [--launch]\n'
  + '            trace stop <id> [--compare <traceId>|none] [--top N] | trace status <id> | trace ls <id>\n'
  + '            trace run <id> --app <id> --flow <file.yaml> [--template T] [--time-limit S] [--launch]';

function print(json: boolean, data: unknown, human: string): void {
  process.stdout.write((json ? JSON.stringify(data, null, 2) : human) + '\n');
}
function stopOpts(a: ParsedArgs) {
  return { compareTo: str(a.flags, 'compare'), top: num(a.flags, 'top'), triageChars: num(a.flags, 'triageChars') };
}

export async function traceCmd(c: PhoneDockClient, a: ParsedArgs, json: boolean): Promise<number> {
  const p = a.positionals;
  const sub = p[1];
  const usage = () => { process.stderr.write(`Usage: phonedock ${TRACE_USAGE}\n`); return 2; };
  if (!sub || !p[2]) return usage();
  const d = await c.resolveDevice(p[2]);
  const startOpts = () => {
    const appId = str(a.flags, 'app');
    if (!appId) throw Object.assign(new Error('--app <bundle id|package> is required'), { usage: true });
    return { appId, template: str(a.flags, 'template'), timeLimitSec: num(a.flags, 'timeLimit'), launch: a.flags.launch === true };
  };
  switch (sub) {
    case 'start': {
      let o; try { o = startOpts(); } catch { return usage(); }
      const r = await c.startTrace(d.id, o);
      print(json, r, `Tracing ${r.appId}${r.process?.pid ? ` (pid ${r.process.pid})` : ''} on ${d.name}: ${r.tool} "${r.template}"${r.instruments.length ? ` + ${r.instruments.join(', ')}` : ''}, stops by itself after ${r.timeLimitSec} s (trace ${r.traceId}).\nDrive the flow, then: phonedock trace stop ${p[2]}`);
      return 0;
    }
    case 'stop': {
      const r = await c.stopTrace(d.id, stopOpts(a));
      print(json, r, r.text);
      return 0;
    }
    case 'status': {
      const r = await c.trace(d.id);
      print(json, r, r.active ? `tracing ${r.appId} since ${r.startedAt} (limit ${r.timeLimitSec} s, trace ${r.traceId})` : r.finished ? `not tracing; trace ${r.finished.traceId} ended (${r.finished.reason ?? 'stopped'}): collect it with phonedock trace stop ${p[2]}` : 'not tracing');
      return 0;
    }
    case 'ls': case 'list': {
      const list = await c.traces(d.id, { limit: num(a.flags, 'limit') });
      print(json, list, list.length ? table(list.map((t) => ({
        trace: t.traceId, app: t.appId, template: t.template, sec: String(t.metrics.durationSec),
        hangs: t.metrics.hangs ?? '', main_ms: t.metrics.mainThreadMs ?? '', janky_pct: t.metrics.jankyPct ?? '', p90_ms: t.metrics.frameP90Ms ?? '',
      })), ['trace', 'app', 'template', 'sec', 'hangs', 'main_ms', 'janky_pct', 'p90_ms']) : `No traces for ${d.name} yet.`);
      return 0;
    }
    case 'run': {
      let o; try { o = startOpts(); } catch { return usage(); }
      const flow = str(a.flags, 'flow');
      if (!flow) return usage();
      const files = collectFlowFiles([flow]);
      if (!files.length) { process.stderr.write(`phonedock: no flow file at ${flow}\n`); return 2; }
      const started = await c.startTrace(d.id, o);
      if (!json) process.stdout.write(`Tracing ${started.appId} on ${d.name} (${started.tool} "${started.template}", limit ${started.timeLimitSec} s)…\n`);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      let suite; let stopped: TraceStopResult | undefined;
      try {
        suite = await runFlowFiles(c, files, { deviceId: d.id, artifactsDir: resolve(join(phonedockHome(), 'test-runs', stamp)), log: json ? undefined : (l) => process.stdout.write(`${l}\n`) });
      } finally {
        stopped = await c.stopTrace(d.id, stopOpts(a));
      }
      const ok = suite.failed === 0 && suite.passed > 0;
      print(json, { ok, flows: suite, trace: stopped }, `\nFlow ${ok ? 'PASSED' : 'FAILED'} (${suite.passed} passed, ${suite.failed} failed) — the trace covers the whole run.\n${stopped.text}`);
      return ok ? 0 : 1;
    }
    default: return usage();
  }
}
