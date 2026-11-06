// The daemon's start-up skill refresh: where it finds the app's skill, and that only the main daemon (or a scratch
// setup home) runs it. Nothing here touches the real home: PHONEDOCK_SETUP_HOME points setup at a temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveContext, runSetup } from '../cli/setup.ts';
import { bundleResources, refreshAgentSkills } from './skills.ts';

delete process.env.PHONEDOCK_SETUP_HOME;
delete process.env.PHONEDOCK_BUNDLE_RESOURCES;

test('bundleResources: the app layout (Resources/daemon next to bin/phonedock and skills), else none; the env wins', () => {
  const res = join(mkdtempSync(join(tmpdir(), 'pd-res-')), 'Resources');
  mkdirSync(join(res, 'daemon'), { recursive: true });
  assert.equal(bundleResources({}, join(res, 'daemon')), undefined);
  mkdirSync(join(res, 'bin')); writeFileSync(join(res, 'bin', 'phonedock'), '#!/bin/sh\n');
  mkdirSync(join(res, 'skills', 'phonedock'), { recursive: true });
  assert.equal(bundleResources({}, join(res, 'daemon')), res);
  assert.equal(bundleResources({}, new URL('.', import.meta.url).pathname), undefined, 'the repo is not an app bundle');
  assert.equal(bundleResources({ PHONEDOCK_BUNDLE_RESOURCES: '/x/Resources' }, join(res, 'daemon')), '/x/Resources');
});

test('refreshAgentSkills: a test daemon on another port does nothing; with a setup home it updates the installed skill', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pd-skills-'));
  const home = join(root, 'home'); mkdirSync(home);
  const cli = join(root, 'bin', 'phonedock'); mkdirSync(join(root, 'bin')); writeFileSync(cli, '#!/bin/sh\n'); chmodSync(cli, 0o755);
  const skill = join(root, 'skill'); mkdirSync(skill); writeFileSync(join(skill, 'SKILL.md'), 'v1\n');
  await runSetup(await resolveContext({ PHONEDOCK_SETUP_HOME: home, PATH: '' }, { pathDirs: [], searchDirs: [], cliPath: cli, skillSrc: skill, serverEnv: {} }), { agents: ['claude'], verify: false });
  const installed = join(home, '.claude', 'skills', 'phonedock', 'SKILL.md');
  assert.equal(readFileSync(installed, 'utf8'), 'v1\n');
  writeFileSync(join(skill, 'SKILL.md'), 'v2\n');

  process.env.PHONEDOCK_CLI_PATH = cli; process.env.PHONEDOCK_SKILL_SRC = skill;
  const lines: string[] = [];
  await refreshAgentSkills(47443, (l) => lines.push(l));
  assert.equal(lines.length, 0);
  assert.equal(readFileSync(installed, 'utf8'), 'v1\n');

  process.env.PHONEDOCK_SETUP_HOME = home;
  try { await refreshAgentSkills(47443, (l) => lines.push(l)); } finally { delete process.env.PHONEDOCK_SETUP_HOME; }
  assert.equal(readFileSync(installed, 'utf8'), 'v2\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[phonedockd\] skill for Claude Code: updated: ~\/\.claude\/skills\/phonedock: update 1 file$/);
});
