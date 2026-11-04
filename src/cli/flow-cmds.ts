// `phonedock flow save|check|export` and `phonedock test`: flows (src/core/flow.ts) from the CLI.
// Kept out of main.ts: main.ts only dispatches `flow` and `test` here.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { PhoneDockClient } from '../sdk/client.ts';
import type { Device } from '../core/types.ts';
import { FlowError, describeStep, parseFlow, toMaestro } from '../core/flow.ts';
import { collectFlowFiles, displayPath, junitXml, runFlowFiles } from '../core/flow-runner.ts';
import { diffThumbs, grayThumb } from '../daemon/media.ts';
import { phonedockHome } from '../sdk/client.ts';
import { str, num, type ParsedArgs } from './args.ts';

export const FLOW_HELP = `Flows:      flow save <id> [-o file] [--since 10m|ISO] [--until ISO] [--owner O] [--name N] [--app ID]
                   [--assert TEXT]… [--no-assert] [--keep-noise] [--format yaml|json]
            flow check <file|dir…> | flow export --maestro <file> [-o out.yaml]
            test <file|dir…> [--device ID] [--platform android|ios] [--junit out.xml] [--artifacts DIR]
                 [--retries N] [--timeout MS] [--env NAME=VALUE]…   (exit 0 only if every flow passed)`;

const err = (msg: string) => { process.stderr.write(`phonedock: ${msg}\n`); return 2; };
/** Every value of a repeatable flag (`--env A=1 --env B=2`). */
function many(argv: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${flag}` && i + 1 < argv.length) out.push(argv[++i]);
    else if (argv[i].startsWith(`--${flag}=`)) out.push(argv[i].slice(flag.length + 3));
  }
  return out;
}
const rel = displayPath;

export async function flowCmd(c: PhoneDockClient, a: ParsedArgs, argv: string[], json: boolean): Promise<number> {
  const p = a.positionals; const sub = p[1];
  const print = (s: string) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`);
  switch (sub) {
    case 'save': {
      if (!p[2]) return err('Missing argument: flow save <device> [-o file]');
      const d = await c.resolveDevice(p[2]);
      const asserts = many(argv, 'assert');
      const format = str(a.flags, 'format') === 'json' || /\.json$/i.test(str(a.flags, 'output') ?? '') ? 'json' : 'yaml';
      const r = await c.saveFlow(d.id, {
        since: str(a.flags, 'since'), until: str(a.flags, 'until'), owner: str(a.flags, 'owner'),
        name: str(a.flags, 'name'), appId: str(a.flags, 'app'),
        ...(asserts.length ? { assertions: asserts } : {}),
        autoAssert: a.flags.assert === false ? false : undefined, keepNoise: a.flags.keepNoise === true, format,
      });
      const file = str(a.flags, 'output');
      if (json) { print(JSON.stringify({ ...r, ...(file ? { file: resolve(file) } : {}) }, null, 2)); if (file) write(file, r.text); return 0; }
      const notes = [...r.warnings.map((w) => `note: ${w}`)];
      if (file) {
        write(file, r.text);
        print(`Saved ${rel(resolve(file))}: ${r.stats.steps} steps (${r.stats.assertions} assertion${r.stats.assertions === 1 ? '' : 's'}) from ${r.stats.entries} logged actions on ${d.name}.`);
        for (const n of notes) print(`  ${n}`);
        if (r.dropped.length) print(`  left out: ${r.dropped.join('; ')}`);
        print(`  Run it: phonedock test ${rel(resolve(file))} --device ${d.name}`);
      } else {
        process.stdout.write(r.text);
        for (const n of notes) process.stderr.write(`${n}\n`);
      }
      return r.stats.steps ? 0 : 1;
    }
    case 'check': case 'validate': {
      if (!p[2]) return err('Missing argument: flow check <file|dir…>');
      let bad = 0;
      for (const f of collectFlowFiles(p.slice(2))) {
        try {
          const fl = parseFlow(readFileSync(f, 'utf8'), f);
          const frag = fl.steps.filter((s) => s.fragile).length;
          print(`OK    ${rel(f)}: ${fl.name}${fl.platform ? ` [${fl.platform}${fl.minOS ? ` ${fl.minOS}+` : ''}]` : ''}, ${fl.steps.length} steps${frag ? ` (${frag} fragile: coordinates)` : ''}`);
          if (!json) fl.steps.forEach((s, i) => print(`        ${String(i + 1).padStart(2)}  ${describeStep(s)}${s.optional ? ' (optional)' : ''}`));
          for (const w of fl.warnings) print(`        note: ${w}`);
        } catch (e) { bad++; print(`FAIL  ${rel(f)}: ${(e as Error).message}`); }
      }
      return bad ? 1 : 0;
    }
    case 'export': {
      const file = typeof a.flags.maestro === 'string' ? a.flags.maestro : p[2];
      if (!file || !a.flags.maestro) return err('Usage: flow export --maestro <file> [-o out.maestro.yaml]   (Maestro is the only export format)');
      const fl = parseFlow(readFileSync(file, 'utf8'), file);
      const m = toMaestro(fl);
      const outFile = str(a.flags, 'output');
      if (outFile) { write(outFile, m.text); print(`Wrote ${rel(resolve(outFile))} (${fl.steps.length - m.unsupported.length}/${fl.steps.length} steps exported)`); }
      else process.stdout.write(m.text);
      for (const u of m.unsupported) process.stderr.write(`not exported: ${u}\n`);
      return 0;
    }
    default: return err(`Unknown flow subcommand "${sub ?? ''}" (save | check | export)`);
  }
}

function write(file: string, text: string) {
  mkdirSync(dirname(resolve(file)), { recursive: true });
  writeFileSync(file, text);
}

/** The device to test on: --device, $PHONEDOCK_DEVICE, else the only running device (of --platform). */
async function testDevice(c: PhoneDockClient, q: string | undefined, platform: string | undefined): Promise<Device> {
  const want = q ?? process.env.PHONEDOCK_DEVICE;
  if (want) return c.resolveDevice(want);
  const running = (await c.devices({ state: 'running', ...(platform ? { platform } : {}) }));
  if (running.length === 1) return running[0];
  throw new FlowError(running.length
    ? `Several devices are running (${running.map((d) => d.name).join(', ')}): pass --device <id>`
    : `No ${platform ? `${platform} ` : ''}device is running: boot one (phonedock boot <id>) or pass --device <id>`);
}

async function compareImages(a: Buffer, b: Buffer): Promise<number> {
  const [ta, tb] = await Promise.all([grayThumb(a, 64), grayThumb(b, 64)]);
  const d = diffThumbs(ta, tb);
  return d.cells / Math.max(1, tb.width * tb.height);
}

export async function testCmd(c: PhoneDockClient, a: ParsedArgs, argv: string[], json: boolean): Promise<number> {
  const paths = a.positionals.slice(1);
  if (!paths.length) return err('Usage: phonedock test <flow file|dir…> [--device ID] [--junit out.xml] [--artifacts DIR] [--retries N]');
  const platform = str(a.flags, 'platform');
  if (platform && platform !== 'android' && platform !== 'ios') return err('--platform is android or ios');
  let files: string[];
  try { files = collectFlowFiles(paths); } catch (e) { return err((e as Error).message); }
  if (!files.length) return err(`No flow files (*.yaml, *.yml, *.json) in ${paths.join(', ')}`);
  let device: Device;
  try { device = await testDevice(c, str(a.flags, 'device'), platform); }
  catch (e) { if (e instanceof FlowError) return err(e.message); throw e; }
  const env: Record<string, string> = {};
  for (const kv of many(argv, 'env')) {
    const i = kv.indexOf('=');
    if (i < 1) return err(`--env takes NAME=VALUE (got "${kv}")`);
    env[kv.slice(0, i)] = kv.slice(i + 1);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const artifactsDir = resolve(str(a.flags, 'artifacts') ?? join(phonedockHome(), 'test-runs', stamp));
  const ac = new AbortController();
  const onInt = () => { if (ac.signal.aborted) process.exit(130); ac.abort(); process.stderr.write('\nphonedock: stopping after this step (Ctrl-C again to quit now)\n'); };
  process.on('SIGINT', onInt);
  const log = json ? undefined : (l: string) => process.stdout.write(`${l}\n`);
  let suite;
  try {
    suite = await runFlowFiles(c, files, {
      deviceId: device.id, artifactsDir, platform: platform as 'android' | 'ios' | undefined, env, log, compareImages, signal: ac.signal,
      retries: num(a.flags, 'retries') ?? 0, timeoutMs: num(a.flags, 'timeout'),
    });
  } finally { process.off('SIGINT', onInt); }
  const junit = str(a.flags, 'junit');
  if (junit) write(junit, junitXml(suite));
  const ran = suite.passed + suite.failed;
  const ok = suite.failed === 0 && suite.passed > 0;
  if (json) process.stdout.write(JSON.stringify({ ok, ...suite, ...(junit ? { junit: resolve(junit) } : {}) }, null, 2) + '\n');
  else {
    const failedWith = suite.flows.filter((f) => f.artifacts);
    process.stdout.write(`${ok ? 'PASSED' : 'FAILED'}: ${suite.passed} passed, ${suite.failed} failed, ${suite.skipped} skipped (${suite.flows.length} flow${suite.flows.length === 1 ? '' : 's'}, ${(suite.ms / 1000).toFixed(1)}s) on ${device.name}\n`);
    if (!ran) process.stdout.write('No flow ran (all skipped): check --platform and the flows\' platform / minOS.\n');
    if (junit) process.stdout.write(`JUnit: ${rel(resolve(junit))}\n`);
    if (failedWith.length) process.stdout.write(`Artifacts: ${failedWith.map((f) => f.artifacts).join(', ')}\n`);
  }
  return ok ? 0 : 1;
}

