// `phonedock runs`, `phonedock runs show <id>`, `phonedock runs export <id> [--format md|json] [-o file]`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { PhoneDockClient, RunRecord, RunStatus, RunSummary } from '../sdk/client.ts';
import { displayPath } from '../core/flow-runner.ts';
import { num, str, type ParsedArgs } from './args.ts';

export const RUNS_HELP = `Runs:       runs [--device ID] [--status pass|fail|skip] [--flow NAME] [--app ID] [--limit N]
            runs show <runId> | runs export <runId> [--format md|json] [-o file]`;

const err = (msg: string) => { process.stderr.write(`phonedock: ${msg}\n`); return 2; };
const fmtDur = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);

function fmtTable(rows: RunSummary[]): string {
  if (!rows.length) return 'No recorded flow runs.';
  const lines = rows.map((r) => {
    const app = r.appId === 'unknown' ? 'unknown' : `${r.appId}@${r.appVersion}(${r.appBuild})`;
    const rev = r.commit === 'unknown' ? 'unknown' : `${r.commit.slice(0, 8)}${r.dirty === true ? '*' : ''}`;
    return `${r.id}  ${r.status.toUpperCase().padEnd(4)}  ${r.flowName}  ${r.deviceName} (${r.platform} ${r.osVersion})  ${app}  ${rev}  ${r.passedSteps}/${r.stepCount}  ${fmtDur(r.durationMs)}`;
  });
  return lines.join('\n');
}

function fmtDetail(r: RunRecord): string {
  const lines = [
    `Run:       ${r.id}`,
    `Status:    ${r.status.toUpperCase()} (${r.steps.filter((s) => s.status === 'pass').length}/${r.steps.length} steps, ${fmtDur(r.durationMs)}, ${r.attempts} attempt${r.attempts === 1 ? '' : 's'})`,
    `Flow:      ${r.flow.name} (${r.flow.file ?? r.flow.fileDisplay})`,
    `Flow SHA:  ${r.flow.sha256}`,
    `Device:    ${r.device.name} (${r.device.id}) · ${r.device.platform} ${r.device.osVersion} · ${r.device.model} · ${r.device.backend}`,
    `App:       ${r.app.id} (${r.app.name}) · version ${r.app.version} · build ${r.app.build}`,
    `Source:    commit ${r.source.commit} · branch ${r.source.branch} · dirty ${String(r.source.dirty)}`,
    `Started:   ${r.startedAt}`,
    `Ended:     ${r.endedAt}`,
    `Owner:     ${r.owner}`,
  ];
  if (r.message) lines.push(`Message:   ${r.message}`);
  if (r.artifacts?.report) lines.push(`Report:    ${r.artifacts.report}`);
  if (r.artifacts?.dir) lines.push(`Artifacts: ${r.artifacts.dir}`);
  if (r.steps.length) {
    lines.push('', 'Steps:');
    for (const s of r.steps) {
      lines.push(`  ${String(s.index).padStart(2)}  ${s.status.toUpperCase().padEnd(4)}  ${s.description}  (${fmtDur(s.ms)})${s.message ? `\n          ${s.message}` : ''}`);
    }
  }
  return lines.join('\n');
}

export async function runsCmd(c: PhoneDockClient, a: ParsedArgs, json: boolean): Promise<number> {
  const p = a.positionals;
  const sub = p[1];
  const print = (s: string) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`);

  if (!sub || sub === 'ls' || sub === 'list') {
    const status = str(a.flags, 'status');
    if (status && status !== 'pass' && status !== 'fail' && status !== 'skip') {
      return err('--status must be pass, fail or skip');
    }
    const limit = num(a.flags, 'limit');
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
      return err('--limit must be an integer between 1 and 200');
    }
    const rows = await c.listRuns({
      device: str(a.flags, 'device'),
      status: status as RunStatus | undefined,
      flow: str(a.flags, 'flow'),
      appId: str(a.flags, 'app') ?? str(a.flags, 'appId'),
      limit,
    });
    if (json) print(JSON.stringify(rows, null, 2));
    else print(fmtTable(rows));
    return 0;
  }

  if (sub === 'show' || sub === 'get') {
    const runId = p[2];
    if (!runId) return err('Missing argument: runs show <runId>');
    const run = await c.getRun(runId);
    if (json) print(JSON.stringify(run, null, 2));
    else print(fmtDetail(run));
    return 0;
  }

  if (sub === 'export') {
    const runId = p[2];
    if (!runId) return err('Missing argument: runs export <runId> [--format md|json] [-o file]');
    const fmt = (str(a.flags, 'format') ?? 'md').toLowerCase();
    if (fmt !== 'md' && fmt !== 'json') return err('--format must be md or json');
    const out = await c.exportRun(runId, fmt);
    const outFile = str(a.flags, 'output');
    if (outFile) {
      const abs = resolve(outFile);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, out);
      if (json) print(JSON.stringify({ ok: true, id: runId, format: fmt, file: abs }, null, 2));
      else print(`Wrote ${displayPath(abs)} (${fmt})`);
    } else {
      process.stdout.write(out.endsWith('\n') ? out : `${out}\n`);
    }
    return 0;
  }

  return err(`Unknown runs subcommand "${sub}" (ls | show | export)`);
}
