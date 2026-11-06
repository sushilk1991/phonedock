// When the daemon starts, bring the agent skill copies that `phonedock setup` installed up to date with this version.
// An app update replaces the MCP server agents run (it lives in the app), but not their copies of the skill in
// ~/.claude/skills and ~/.agents/skills, so agents kept reading the old instructions until someone ran Set Up again.
// After an update the app replaces the old daemon with this one, so this runs once per update. refreshSkills
// (src/cli/setup.ts) decides what it may touch.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_NAMES, refreshSkills, resolveContext } from '../cli/setup.ts';

/**
 * The app's Resources folder when this daemon runs from the app. The app starts Resources/daemon/phonedockd.mjs
 * directly, without the bin/phonedock wrapper that sets PHONEDOCK_BUNDLE_RESOURCES.
 */
export function bundleResources(env: NodeJS.ProcessEnv = process.env, here = dirname(fileURLToPath(import.meta.url))): string | undefined {
  if (env.PHONEDOCK_BUNDLE_RESOURCES) return env.PHONEDOCK_BUNDLE_RESOURCES;
  const res = resolve(here, '..');
  return existsSync(join(res, 'bin', 'phonedock')) && existsSync(join(res, 'skills')) ? res : undefined;
}

export async function refreshAgentSkills(port: number, log: (line: string) => void = console.log): Promise<void> {
  // Only the main daemon (the app's, on 47420). Test and worker daemons on other ports leave the user's agents
  // alone; PHONEDOCK_SETUP_HOME (dev/test) points setup at a scratch home, so any port may run it there.
  if (port !== 47420 && !process.env.PHONEDOCK_SETUP_HOME) return;
  const res = bundleResources();
  const env = res ? { ...process.env, PHONEDOCK_BUNDLE_RESOURCES: res } : process.env;
  // Setup asks the login shell for PATH only to link `phonedock`, which this doesn't do: skip that.
  const ctx = await resolveContext(env, { pathDirs: (env.PATH ?? '').split(':').filter(Boolean) });
  for (const c of refreshSkills(ctx)) {
    const who = c.agents.map((a) => AGENT_NAMES[a]).join(', ');
    const what = c.action === 'update' ? 'updated' : c.action === 'conflict' ? 'left alone' : c.action === 'error' ? 'couldn’t update' : c.action;
    log(`[phonedockd] skill for ${who}: ${what}: ${c.detail}`);
  }
}
