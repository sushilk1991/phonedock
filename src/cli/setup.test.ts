// `phonedock setup` with a temporary HOME: JSON and TOML merges, idempotency, conflicts, uninstall and the PATH link
// rules. Nothing here reads or writes the real home: every context gets its own folder, fake client CLIs and a fake
// phonedock CLI; the verification stages are off (verify: false) or stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_TOOL_TIMEOUT_SEC, PI_TIMEOUT_SEC, formatReport, resolveContext, runSetup, type Exec, type SetupContext } from './setup.ts';
import { readTomlServer, removeTomlServer, setTomlServerKey, tomlServerBlock, upsertTomlServer } from './setup-files.ts';

const SKILL = '---\nname: phonedock\ndescription: test skill\n---\n\n# PhoneDock\n';

function sandbox(): { root: string; home: string; cli: string; skill: string; bin: string } {
  const root = mkdtempSync(join(tmpdir(), 'pd-setup-'));
  const home = join(root, 'home'); const bin = join(home, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  const cli = join(root, 'app', 'bin', 'phonedock');
  mkdirSync(join(root, 'app', 'bin'), { recursive: true });
  writeFileSync(cli, '#!/bin/sh\necho phonedock\n'); chmodSync(cli, 0o755);
  const skill = join(root, 'skill');
  mkdirSync(join(skill, 'references'), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), SKILL);
  writeFileSync(join(skill, 'references', 'cli.md'), '# CLI\n');
  return { root, home, cli, skill, bin };
}

/** A context with no client binaries (file merges only) unless `exec`/`searchDirs` say otherwise. */
async function ctxFor(s: ReturnType<typeof sandbox>, over: Partial<SetupContext> = {}): Promise<SetupContext> {
  const ctx = await resolveContext({ PHONEDOCK_SETUP_HOME: s.home, SHELL: '/bin/zsh', PATH: s.bin }, {
    pathDirs: [s.bin], searchDirs: [s.bin], cliPath: s.cli, skillSrc: s.skill, serverEnv: {}, now: new Date('2026-11-04T10:00:00Z'), ...over,
  });
  assert.equal(ctx.home, s.home);
  return ctx;
}

const read = (p: string) => readFileSync(p, 'utf8');
const json = (p: string) => JSON.parse(read(p));
const actions = (r: { changes: { item: string; agents: string[]; action: string }[] }) => r.changes.map((c) => `${c.item}:${c.agents.join('+') || 'path'}:${c.action}`);

/** Every file under a folder with its content, to prove a run changed nothing. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n); const st = lstatSync(p);
      if (st.isSymbolicLink()) out[p] = '-> ' + readlinkSync(p);
      else if (st.isDirectory()) walk(p);
      else out[p] = read(p);
    }
  };
  walk(dir); return out;
}

test('TOML: reads [mcp_servers.phonedock] with an env table, edits only that table, keeps comments and other tables', () => {
  const text = [
    '# my codex config', 'model = "o5"', '',
    '[mcp_servers.other]', 'command = "other-mcp"', 'args = [', '  "--flag", # a comment', '  "x",', ']', '',
    '[mcp_servers.phonedock]', 'command = "/Apps/PhoneDock.app/Contents/Resources/bin/phonedock"', 'args = ["mcp"]', '',
    '[mcp_servers.phonedock.env]', 'PHONEDOCK_PORT = "47560"', '',
    '[profiles.fast]', "model = 'o5-mini'", '',
  ].join('\n');
  const s = readTomlServer(text, 'phonedock')!;
  assert.equal(s.command, '/Apps/PhoneDock.app/Contents/Resources/bin/phonedock');
  assert.deepEqual(s.args, ['mcp']);
  assert.deepEqual(s.env, { PHONEDOCK_PORT: '47560' });
  assert.equal(s.tool_timeout_sec, undefined);
  assert.deepEqual(readTomlServer(text, 'other')!.args, ['--flag', 'x']);

  const withTimeout = setTomlServerKey(text, 'phonedock', 'tool_timeout_sec', '960')!;
  assert.equal(readTomlServer(withTimeout, 'phonedock')!.tool_timeout_sec, 960);
  assert.match(withTimeout, /args = \["mcp"\]\ntool_timeout_sec = 960\n/);
  assert.equal(setTomlServerKey(withTimeout, 'phonedock', 'tool_timeout_sec', '960'), withTimeout);   // already set: same text
  assert.equal(setTomlServerKey(text, 'missing', 'tool_timeout_sec', '960'), undefined);

  const removed = removeTomlServer(withTimeout, 'phonedock');
  assert.equal(removed, text.replace(/\[mcp_servers\.phonedock\][\s\S]*?(?=\[profiles)/, ''));
  assert.ok(removed.includes('# a comment') && removed.includes("model = 'o5-mini'") && removed.startsWith('# my codex config'));
  assert.equal(readTomlServer(removed, 'phonedock'), undefined);

  const inline = 'x = 1\n[mcp_servers."phonedock"]\ncommand = "/a/phonedock"\nargs = ["mcp"]\nenv = { PHONEDOCK_HOME = "/h", "A B" = "c" }\n';
  assert.deepEqual(readTomlServer(inline, 'phonedock')!.env, { PHONEDOCK_HOME: '/h', 'A B': 'c' });

  const block = tomlServerBlock('phonedock', '/p/a "b"/phonedock', ['mcp'], { K: 'v' }, CODEX_TOOL_TIMEOUT_SEC);
  const up = upsertTomlServer('model = "o5"\n', 'phonedock', block);
  assert.deepEqual(readTomlServer(up, 'phonedock'), { command: '/p/a "b"/phonedock', args: ['mcp'], env: { K: 'v' }, tool_timeout_sec: 960, other: [], unreadable: [] });
  assert.ok(up.startsWith('model = "o5"\n\n[mcp_servers.phonedock]'));
  assert.equal(upsertTomlServer(up, 'phonedock', block), up);   // upsert of the same block: identical
});

test('install by file merge (no client CLIs): keeps unrelated entries, writes the entry, skill and link; a second run changes nothing', async () => {
  const s = sandbox();
  mkdirSync(join(s.home, '.cursor'), { recursive: true });
  writeFileSync(join(s.home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } }, theme: 'dark' }));
  mkdirSync(join(s.home, '.codex'), { recursive: true });
  writeFileSync(join(s.home, '.codex', 'config.toml'), '# keep me\nmodel = "o5"\n\n[mcp_servers.other]\ncommand = "x"\n');
  writeFileSync(join(s.home, '.claude.json'), JSON.stringify({ numStartups: 3, mcpServers: { foo: { type: 'stdio', command: 'foo' } } }));
  mkdirSync(join(s.home, '.claude', 'skills', 'phonedock-phone'), { recursive: true });
  writeFileSync(join(s.home, '.claude', 'skills', 'phonedock-phone', 'SKILL.md'), 'personal skill');
  const ctx = await ctxFor(s);

  const r1 = await runSetup(ctx, { agents: ['claude', 'codex', 'cursor', 'pi'], verify: false });
  assert.ok(r1.ok, formatReport(r1));
  assert.deepEqual(actions(r1), ['mcp:claude:add', 'mcp:codex:add', 'mcp:cursor:add', 'mcp:pi:add', 'skill:claude:add', 'skill:codex+cursor+pi:add', 'path:path:add']);

  const cursor = json(join(s.home, '.cursor', 'mcp.json'));
  assert.deepEqual(cursor, { mcpServers: { github: { command: 'gh-mcp' }, phonedock: { command: s.cli, args: ['mcp'] } }, theme: 'dark' });
  const claude = json(join(s.home, '.claude.json'));
  assert.equal(claude.numStartups, 3); assert.deepEqual(claude.mcpServers.foo, { type: 'stdio', command: 'foo' });
  assert.deepEqual(claude.mcpServers.phonedock, { type: 'stdio', command: s.cli, args: ['mcp'] });
  const toml = read(join(s.home, '.codex', 'config.toml'));
  assert.ok(toml.startsWith('# keep me\nmodel = "o5"\n\n[mcp_servers.other]\ncommand = "x"\n'));
  assert.equal(readTomlServer(toml, 'phonedock')!.tool_timeout_sec, CODEX_TOOL_TIMEOUT_SEC);
  assert.equal(json(join(s.home, '.pi', 'agent', 'mcp.json')).mcpServers.phonedock.timeout, PI_TIMEOUT_SEC);
  assert.equal(read(join(s.home, '.claude', 'skills', 'phonedock', 'SKILL.md')), SKILL);
  assert.equal(read(join(s.home, '.agents', 'skills', 'phonedock', 'references', 'cli.md')), '# CLI\n');
  assert.ok(!existsSync(join(s.home, '.pi', 'agent', 'skills')), 'Pi reads ~/.agents/skills: no second copy');
  assert.equal(readlinkSync(join(s.bin, 'phonedock')), s.cli);
  assert.equal(read(join(s.home, '.claude', 'skills', 'phonedock-phone', 'SKILL.md')), 'personal skill');
  // Backups of the three files that existed, with their old content.
  const bk = join(s.home, 'Library', 'Application Support', 'PhoneDock', 'setup-backups', '2026-11-04T10-00-00-000Z');
  assert.deepEqual(JSON.parse(read(join(bk, '.cursor', 'mcp.json'))).mcpServers, { github: { command: 'gh-mcp' } });
  assert.ok(read(join(bk, '.codex', 'config.toml')).includes('# keep me'));
  assert.equal(r1.backups.length, 3);

  const before = snapshot(s.home);
  const r2 = await runSetup(await ctxFor(s, { now: new Date('2026-11-04T11:00:00Z') }), { agents: ['claude', 'codex', 'cursor', 'pi'], verify: false });
  assert.ok(r2.ok);
  assert.ok(r2.changes.every((c) => c.action === 'none'), actions(r2).join(' '));
  assert.deepEqual(r2.backups, []);
  assert.deepEqual(snapshot(s.home), before, 'second run must not touch a file');
  assert.ok(r2.clients.every((c) => c.registered === 'yes'));
});

test('dry run writes nothing and lists the exact edits', async () => {
  const s = sandbox();
  const before = snapshot(s.home);
  const r = await runSetup(await ctxFor(s), { agents: ['cursor', 'codex'], dryRun: true, verify: false });
  assert.deepEqual(snapshot(s.home), before);
  assert.equal(r.dryRun, true);
  const out = formatReport(r);
  assert.match(out, /Proposed changes \(nothing was written\)/);
  assert.match(out, /set mcpServers\.phonedock in ~\/\.cursor\/mcp\.json/);
  assert.match(out, /tool_timeout_sec = 960/);
  assert.match(out, /\$ ln -s /);
});

test('conflicts: another copy registered as "phonedock" is left alone (ok=false) until --force, which backs it up', async () => {
  const s = sandbox();
  mkdirSync(join(s.home, '.cursor'), { recursive: true });
  const other = { command: '/Users/x/old/PhoneDock.app/Contents/Resources/bin/phonedock', args: ['mcp'] };
  writeFileSync(join(s.home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { phonedock: other } }));
  const r = await runSetup(await ctxFor(s), { agents: ['cursor'], verify: false });
  assert.equal(r.ok, false);
  const c = r.changes.find((x) => x.item === 'mcp')!;
  assert.equal(c.action, 'conflict'); assert.ok(c.forceable);
  assert.match(c.detail, /runs \/Users\/x\/old\/PhoneDock\.app.*no longer exists.*--force/);
  assert.deepEqual(json(join(s.home, '.cursor', 'mcp.json')).mcpServers.phonedock, other);
  assert.equal(r.clients.find((x) => x.id === 'cursor')!.registered, 'other');

  const f = await runSetup(await ctxFor(s), { agents: ['cursor'], force: true, verify: false });
  assert.ok(f.ok);
  assert.equal(f.changes.find((x) => x.item === 'mcp')!.action, 'update');
  assert.equal(json(join(s.home, '.cursor', 'mcp.json')).mcpServers.phonedock.command, s.cli);
  assert.deepEqual(JSON.parse(read(join(f.backups[0]))).mcpServers.phonedock, other);
});

test('an entry for this CLI with stale env, or Codex without the timeout, is updated in place (not a conflict)', async () => {
  const s = sandbox();
  mkdirSync(join(s.home, '.codex'), { recursive: true });
  writeFileSync(join(s.home, '.codex', 'config.toml'), `[mcp_servers.phonedock]\ncommand = "${s.cli}"\nargs = ["mcp"]\n`);
  mkdirSync(join(s.home, '.cursor'), { recursive: true });
  writeFileSync(join(s.home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { phonedock: { command: s.cli, args: ['mcp'], env: { PHONEDOCK_PORT: '1' } } } }));
  const r = await runSetup(await ctxFor(s), { agents: ['codex', 'cursor'], verify: false });
  assert.ok(r.ok, formatReport(r));
  assert.match(r.changes[0].detail, /raise tool_timeout_sec to 960/);
  assert.equal(read(join(s.home, '.codex', 'config.toml')), `[mcp_servers.phonedock]\ncommand = "${s.cli}"\nargs = ["mcp"]\ntool_timeout_sec = 960\n`);
  assert.deepEqual(json(join(s.home, '.cursor', 'mcp.json')).mcpServers.phonedock, { command: s.cli, args: ['mcp'] });
});

test('a bare "phonedock" command that PATH resolves to this CLI counts as registered', async () => {
  const s = sandbox();
  symlinkSync(s.cli, join(s.bin, 'phonedock'));
  mkdirSync(join(s.home, '.cursor'), { recursive: true });
  writeFileSync(join(s.home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { phonedock: { command: 'phonedock', args: ['mcp'] } } }));
  const r = await runSetup(await ctxFor(s), { agents: ['cursor'], verify: false });
  assert.equal(r.changes.find((c) => c.item === 'mcp')!.action, 'none');
  assert.equal(r.changes.find((c) => c.item === 'path')!.action, 'none');
});

test('skills: a file the user edited is kept (reported, not a failure); --force replaces it with a backup', async () => {
  const s = sandbox();
  await runSetup(await ctxFor(s), { agents: ['claude'], verify: false });
  const mine = join(s.home, '.claude', 'skills', 'phonedock', 'SKILL.md');
  writeFileSync(mine, SKILL + '\nMy own notes.\n');
  writeFileSync(join(s.skill, 'SKILL.md'), SKILL + '\nNew upstream text.\n');   // a newer PhoneDock
  const r = await runSetup(await ctxFor(s), { agents: ['claude'], verify: false });
  const sk = r.changes.find((c) => c.item === 'skill')!;
  assert.equal(sk.action, 'conflict'); assert.match(sk.detail, /you edited SKILL\.md/);
  assert.ok(r.ok, 'an edited skill is not a failure');
  assert.match(read(mine), /My own notes/);
  const f = await runSetup(await ctxFor(s, { now: new Date('2026-11-04T12:00:00Z') }), { agents: ['claude'], force: true, verify: false });
  assert.equal(f.changes.find((c) => c.item === 'skill')!.action, 'update');
  assert.match(read(mine), /New upstream text/);
  assert.match(read(join(f.backups[0], 'SKILL.md')), /My own notes/);
});

test('skills: a folder named phonedock that setup did not install is never overwritten without --force', async () => {
  const s = sandbox();
  const dir = join(s.home, '.agents', 'skills', 'phonedock');
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'SKILL.md'), 'someone else');
  const r = await runSetup(await ctxFor(s), { agents: ['codex'], verify: false });
  assert.equal(r.changes.find((c) => c.item === 'skill')!.action, 'conflict');
  assert.equal(read(join(dir, 'SKILL.md')), 'someone else');
});

test('uninstall removes only what setup added', async () => {
  const s = sandbox();
  mkdirSync(join(s.home, '.cursor'), { recursive: true });
  writeFileSync(join(s.home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } } }));
  writeFileSync(join(s.home, '.claude.json'), JSON.stringify({ numStartups: 3, mcpServers: { foo: { command: 'foo' } } }));
  mkdirSync(join(s.home, '.claude', 'skills', 'phonedock-phone'), { recursive: true });
  writeFileSync(join(s.home, '.claude', 'skills', 'phonedock-phone', 'SKILL.md'), 'personal skill');
  const other = join(s.bin, 'other-tool'); writeFileSync(other, '#!/bin/sh\n'); chmodSync(other, 0o755);
  const all = ['claude', 'codex', 'cursor', 'pi'] as const;
  await runSetup(await ctxFor(s), { agents: [...all], verify: false });
  // The user adds a note file next to the installed skill: uninstall leaves it (and so the folder).
  writeFileSync(join(s.home, '.agents', 'skills', 'phonedock', 'NOTES.md'), 'mine');

  // Removing one client keeps the shared skill and the PATH link for the others.
  const one = await runSetup(await ctxFor(s), { agents: ['pi'], uninstall: true });
  assert.ok(one.ok, formatReport(one));
  assert.deepEqual(actions(one), ['mcp:pi:remove', 'skill:pi:none', 'path:path:none']);
  assert.match(one.changes[1].detail, /Codex and Cursor still use it/);
  assert.deepEqual(json(join(s.home, '.pi', 'agent', 'mcp.json')), { mcpServers: {} });

  const r = await runSetup(await ctxFor(s), { agents: ['claude', 'codex', 'cursor'], uninstall: true });
  assert.ok(r.ok, formatReport(r));
  assert.deepEqual(json(join(s.home, '.cursor', 'mcp.json')), { mcpServers: { github: { command: 'gh-mcp' } } });
  assert.deepEqual(json(join(s.home, '.claude.json')), { numStartups: 3, mcpServers: { foo: { command: 'foo' } } });
  assert.equal(readTomlServer(read(join(s.home, '.codex', 'config.toml')), 'phonedock'), undefined);
  assert.ok(!existsSync(join(s.home, '.claude', 'skills', 'phonedock')));
  assert.deepEqual(readdirSync(join(s.home, '.agents', 'skills', 'phonedock')), ['NOTES.md']);
  assert.equal(read(join(s.home, '.claude', 'skills', 'phonedock-phone', 'SKILL.md')), 'personal skill');
  assert.ok(!existsSync(join(s.bin, 'phonedock')), 'our link is gone');
  assert.ok(existsSync(other));

  const again = await runSetup(await ctxFor(s), { agents: ['claude', 'codex', 'cursor', 'pi'], uninstall: true });
  assert.ok(again.changes.every((c) => c.action === 'none'), actions(again).join(' '));
});

test('uninstall leaves an entry that runs another copy, unless --force', async () => {
  const s = sandbox();
  mkdirSync(join(s.home, '.cursor'), { recursive: true });
  writeFileSync(join(s.home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { phonedock: { command: '/elsewhere/phonedock', args: ['mcp'] } } }));
  const r = await runSetup(await ctxFor(s), { agents: ['cursor'], uninstall: true });
  assert.equal(r.changes[0].action, 'conflict');
  assert.equal(json(join(s.home, '.cursor', 'mcp.json')).mcpServers.phonedock.command, '/elsewhere/phonedock');
});

test('PATH: link into the first writable preferred folder on PATH; never replace another phonedock; else print the shell line', async () => {
  // (a) ~/.local/bin isn't on PATH, ~/bin is: the link goes to ~/bin.
  const a = sandbox(); const homeBin = join(a.home, 'bin'); mkdirSync(homeBin);
  let r = await runSetup(await ctxFor(a, { pathDirs: ['/usr/bin', homeBin], searchDirs: [homeBin] }), { agents: ['cursor'], verify: false });
  assert.equal(r.changes.at(-1)!.action, 'add');
  assert.equal(readlinkSync(join(homeBin, 'phonedock')), a.cli);

  // (b) Another phonedock earlier on PATH: reported, nothing created or replaced, not a failure.
  const b = sandbox(); const early = join(b.home, 'early'); mkdirSync(early);
  writeFileSync(join(early, 'phonedock'), '#!/bin/sh\necho other\n'); chmodSync(join(early, 'phonedock'), 0o755);
  r = await runSetup(await ctxFor(b, { pathDirs: [early, b.bin] }), { agents: ['cursor'], verify: false });
  const p = r.changes.at(-1)!;
  assert.equal(p.action, 'conflict'); assert.match(p.detail, /another phonedock: left it alone/);
  assert.ok(r.ok);
  assert.equal(read(join(early, 'phonedock')), '#!/bin/sh\necho other\n');
  assert.ok(!existsSync(join(b.bin, 'phonedock')));

  // (c) A dangling link named phonedock in ~/.local/bin is skipped (never replaced); no other folder → shell line.
  const c = sandbox();
  symlinkSync(join(c.root, 'gone', 'phonedock'), join(c.bin, 'phonedock'));
  r = await runSetup(await ctxFor(c), { agents: ['cursor'], verify: false });
  const m = r.changes.at(-1)!;
  assert.equal(m.action, 'manual');
  assert.match(m.detail, /phonedock exists/);
  assert.equal(m.steps[0], `echo 'export PATH="${join(c.root, 'app', 'bin')}:$PATH"' >> ~/.zshrc`);
  assert.equal(readlinkSync(join(c.bin, 'phonedock')), join(c.root, 'gone', 'phonedock'));

  // (d) Nothing writable on PATH at all.
  const d = sandbox();
  r = await runSetup(await ctxFor(d, { pathDirs: ['/usr/bin', '/bin'] }), { agents: ['cursor'], verify: false });
  assert.equal(r.changes.at(-1)!.action, 'manual');
});

test('PATH under PHONEDOCK_SETUP_HOME: folders outside that home are never linked into, looked at or cleaned up', async () => {
  const s = sandbox();
  const outside = join(s.root, 'outside-bin'); mkdirSync(outside);
  // A writable folder outside the home, first on PATH, holding a link to this very CLI (as a real ~/.local/bin might).
  symlinkSync(s.cli, join(outside, 'phonedock'));
  const ctx = await ctxFor(s, { pathDirs: [outside, s.bin] });
  const r = await runSetup(ctx, { agents: ['cursor'], verify: false });
  assert.equal(r.changes.at(-1)!.action, 'add');
  assert.equal(r.changes.at(-1)!.target, join(s.bin, 'phonedock'));
  const un = await runSetup(ctx, { agents: ['cursor'], uninstall: true });
  assert.deepEqual(un.changes.filter((c) => c.item === 'path').map((c) => c.target), [join(s.bin, 'phonedock')]);
  assert.ok(!existsSync(join(s.bin, 'phonedock')));
  assert.equal(readlinkSync(join(outside, 'phonedock')), s.cli, 'the link outside the setup home is untouched');
});

/** Stand-ins for the real client CLIs: they write what the real ones write (checked against the real ones under a
 *  fake HOME), and `codex mcp list --json` reads config.toml back like Codex does. */
function fakeClients(s: ReturnType<typeof sandbox>, opts: { codexMisreads?: boolean } = {}): { exec: Exec; calls: string[] } {
  for (const b of ['claude', 'codex', 'pi']) { writeFileSync(join(s.bin, b), '#!/bin/sh\n'); chmodSync(join(s.bin, b), 0o755); }
  const calls: string[] = [];
  const exec: Exec = async (cmd, args, o) => {
    const home = o?.env?.HOME ?? '';
    const name = cmd.split('/').pop();
    calls.push(`${name} ${args.join(' ')} HOME=${home === s.home ? '<tmp>' : home}`);
    const tail = args.slice(args.indexOf('--') + 1);
    const toml = join(home, '.codex', 'config.toml');
    if (name === 'codex' && args[1] === 'list') {
      const t = existsSync(toml) ? readTomlServer(read(toml), 'phonedock') : undefined;
      // codexMisreads: Codex sees setup's own edit differently (a form of the table setup can't parse, say).
      const seen = t && !(opts.codexMisreads && !t.other.includes('codex_wrote'));
      const list = seen ? [{ name: 'phonedock', enabled: true, transport: { type: 'stdio', command: t.command, args: t.args, env: Object.keys(t.env ?? {}).length ? t.env : null }, tool_timeout_sec: t.tool_timeout_sec ?? null }] : [];
      return { code: 0, stdout: JSON.stringify(list), stderr: '' };
    }
    if (name === 'codex' && args[1] === 'add') {
      mkdirSync(join(home, '.codex'), { recursive: true });
      // Like the real `codex mcp add`: rewrites the whole file and drops comments.
      const kept = (existsSync(toml) ? read(toml) : '').split('\n').map((l) => l.replace(/\s*#.*$/, '')).join('\n');
      writeFileSync(toml, upsertTomlServer(kept, 'phonedock', tomlServerBlock('phonedock', tail[0], tail.slice(1), {}).replace('args =', 'codex_wrote = true\nargs =')));
    } else if (name === 'codex' && args[1] === 'remove') {
      writeFileSync(toml, removeTomlServer(read(toml), 'phonedock'));
    } else if ((name === 'pi' || name === 'claude') && args[1] === 'add') {
      const f = name === 'pi' ? join(home, '.pi', 'agent', 'mcp.json') : join(home, '.claude.json');
      mkdirSync(join(f, '..'), { recursive: true });
      const j = existsSync(f) ? json(f) : {};
      j.mcpServers = { ...(j.mcpServers ?? {}), phonedock: { command: tail[0], args: tail.slice(1) } };
      writeFileSync(f, JSON.stringify(j));
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { exec, calls };
}

test('client CLIs: claude and pi add with their own command; Codex gets only its table edited, then reads it back', async () => {
  const s = sandbox();
  mkdirSync(join(s.home, '.codex'), { recursive: true });
  const seed = '# my settings\nmodel = "o5"\n\n[mcp_servers.docs]\ncommand = "docs"\nargs = ["x"] # keep this comment\n';
  writeFileSync(join(s.home, '.codex', 'config.toml'), seed);
  const { exec, calls } = fakeClients(s);
  const r = await runSetup(await ctxFor(s, { exec }), { verify: false });
  assert.deepEqual(r.agents, ['claude', 'codex', 'pi']);
  assert.ok(r.ok, formatReport(r));
  assert.deepEqual(calls, [
    `claude mcp add --scope user phonedock -- ${s.cli} mcp HOME=<tmp>`,
    'codex mcp list --json HOME=<tmp>',
    `pi mcp add phonedock --description Android and iOS phones, emulators and simulators: create devices, read the screen, tap and type, test apps -- ${s.cli} mcp HOME=<tmp>`,
  ]);
  const toml = read(join(s.home, '.codex', 'config.toml'));
  assert.ok(toml.startsWith(seed), 'the user\'s text, comments included, is untouched');
  assert.equal(readTomlServer(toml, 'phonedock')!.tool_timeout_sec, 960);
  assert.equal(json(join(s.home, '.pi', 'agent', 'mcp.json')).mcpServers.phonedock.timeout, 960);
  calls.length = 0;
  const again = await runSetup(await ctxFor(s, { exec }), { verify: false });
  assert.ok(again.changes.every((c) => c.action === 'none'));
  assert.deepEqual(calls, [], 'nothing to do: no client command runs');

  const un = await runSetup(await ctxFor(s, { exec }), { agents: ['codex'], uninstall: true });
  assert.ok(un.ok, formatReport(un));
  assert.equal(read(join(s.home, '.codex', 'config.toml')), seed);
});

test('Codex reads the edited file differently: setup puts the file back and lets codex mcp add write it', async () => {
  const s = sandbox();
  mkdirSync(join(s.home, '.codex'), { recursive: true });
  writeFileSync(join(s.home, '.codex', 'config.toml'), 'model = "o5" # mine\n');
  const { exec, calls } = fakeClients(s, { codexMisreads: true });
  const r = await runSetup(await ctxFor(s, { exec }), { agents: ['codex'], verify: false });
  assert.ok(r.ok, formatReport(r));
  assert.deepEqual(calls, ['codex mcp list --json HOME=<tmp>', `codex mcp add phonedock -- ${s.cli} mcp HOME=<tmp>`, 'codex mcp list --json HOME=<tmp>']);
  const t = readTomlServer(read(join(s.home, '.codex', 'config.toml')), 'phonedock')!;
  assert.equal(t.tool_timeout_sec, 960);
  assert.ok(t.other.includes('codex_wrote'));
});

test('skills: an edit to a file this version doesn\'t change is just kept; uninstall keeps edited files and says so next time', async () => {
  const s = sandbox();
  await runSetup(await ctxFor(s), { agents: ['codex'], verify: false });
  const dir = join(s.home, '.agents', 'skills', 'phonedock');
  writeFileSync(join(dir, 'SKILL.md'), SKILL + 'mine\n');
  writeFileSync(join(s.skill, 'references', 'cli.md'), '# CLI v2\n');   // a newer PhoneDock changes another file
  const r = await runSetup(await ctxFor(s), { agents: ['codex'], verify: false });
  const sk = r.changes.find((c) => c.item === 'skill')!;
  assert.equal(sk.action, 'update');
  assert.match(sk.detail, /update 1 file; your edits to SKILL\.md are kept/);
  assert.equal(read(join(dir, 'references', 'cli.md')), '# CLI v2\n');
  assert.match(read(join(dir, 'SKILL.md')), /mine/);
  const same = await runSetup(await ctxFor(s), { agents: ['codex'], verify: false });
  assert.equal(same.changes.find((c) => c.item === 'skill')!.action, 'none');

  const un = await runSetup(await ctxFor(s), { agents: ['codex'], uninstall: true });
  assert.match(un.changes.find((c) => c.item === 'skill')!.detail, /keep SKILL\.md, which you edited/);
  assert.deepEqual(readdirSync(dir).sort(), ['.phonedock-skill.json', 'SKILL.md']);
  const un2 = await runSetup(await ctxFor(s), { agents: ['codex'], uninstall: true });
  const sk2 = un2.changes.find((c) => c.item === 'skill')!;
  assert.equal(sk2.action, 'none');
  assert.match(sk2.detail, /only SKILL\.md, which you edited, is left: kept \(--force removes it\)/);
  await runSetup(await ctxFor(s), { agents: ['codex'], uninstall: true, force: true });
  assert.ok(!existsSync(dir));
});

test('verification stages: a stubbed probe fills stages 1-6 and picks the try-it prompt from the ready platforms', async () => {
  const s = sandbox();
  const ctx = await ctxFor(s);
  await runSetup(ctx, { agents: ['cursor'], verify: false });
  const r = await runSetup(ctx, { agents: ['cursor'], check: true, probe: async () => ({
    service: { ok: true, detail: 'answers' }, mcp: { ok: true, detail: '54 tools' },
    platforms: [{ id: 'ios-simulator', name: 'iPhone simulators', ready: false, detail: 'Xcode missing', fix: 'Install Xcode' }, { id: 'android-emulator', name: 'Android emulators', ready: true, detail: '1 image' }],
  }) });
  assert.deepEqual(r.stages.map((x) => `${x.n}:${x.id}:${x.status}`), ['1:cli:ok', '2:service:ok', '3:mcp:ok', '4:client:ok', '5:platforms:warn', '6:try:ok']);
  assert.match(r.tryPrompt!, /Android phone/);
  assert.match(r.stages[4].fix!, /iPhone simulators: Install Xcode/);
  assert.ok(r.ok);
  assert.ok(r.restart.some((x) => x.agent === 'cursor'));
});
