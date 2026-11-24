// Both native iPhone sidecars must run in the same pymobiledevice3 environment. Discovery never contacts a device.
// Lookup order:
//   1. PHONEDOCK_PYMD3_PYTHON override
//   2. Managed ios-tools pinned key, if ready
//   3. Most recently activated other ready managed ios-tools key
//   4. Host discovery (pymobiledevice3 launcher on PATH, uv, pipx)
import { accessSync, constants, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { which } from '../core/paths.ts';
import { getComponentManager } from '../core/components.ts';

/** pip/uv quote a long interpreter path in a /bin/sh trampoline. Never execute or source a launcher. */
export function launcherPythonCandidates(source: string): string[] {
  const lines = source.slice(0, 4096).split(/\r?\n/);
  const direct = /^#!\s*(\S+)\s*$/.exec(lines[0] ?? '')?.[1];
  const candidates: string[] = [];
  if (direct && !/\/(?:env|(?:ba|z|da|k)?sh)$/.test(direct)) candidates.push(direct);
  const trampoline = /^'''exec'\s+(?:'([^']+)'|"([^"]+)"|([^\s]+))\s/.exec(lines[1] ?? '');
  if (trampoline) candidates.push(trampoline[1] ?? trampoline[2] ?? trampoline[3]);
  return candidates;
}
const executable = (path: string): boolean => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } };

export function discoverPymd3Python(opts: {
  override?: string;
  managed?: string;
  launcher?: string;
  home: string;
  accept?: (path: string) => boolean;
}): string | undefined {
  const accepted = (path: string) => executable(path) && (opts.accept?.(path) ?? true);
  if (opts.override) return accepted(opts.override) ? opts.override : undefined;
  const candidates: string[] = [];
  if (opts.managed) candidates.push(opts.managed);
  if (opts.launcher) { try { candidates.push(...launcherPythonCandidates(readFileSync(opts.launcher, 'utf8'))); } catch { /* no launcher */ } }
  candidates.push(
    join(opts.home, '.local/share/uv/tools/pymobiledevice3/bin/python'),
    join(opts.home, '.local/pipx/venvs/pymobiledevice3/bin/python'),
    join(opts.home, '.local/share/pipx/venvs/pymobiledevice3/bin/python'),
  );
  return candidates.find(accepted);
}

function acceptPython311(candidate: string): boolean {
  // The sidecars use asyncio.timeout (3.11+); macOS's /usr/bin/python3 can still be 3.9.
  const probe = spawnSync(candidate, ['-I', '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'], { timeout: 2000, stdio: 'ignore' });
  return probe.status === 0;
}

let externalCached: { key: string; at: number; path?: string } | undefined;

/** External host discovery only (PATH/uv/pipx, skipping managed components). Cached briefly to avoid repeated spawnSync probes. */
export function externalPymd3Python(): string | undefined {
  const key = [process.env.PATH, process.env.HOME].join('\n');
  if (externalCached?.key === key && Date.now() - externalCached.at < 5000 && (!externalCached.path || executable(externalCached.path))) {
    return externalCached.path;
  }
  const path = discoverPymd3Python({
    launcher: which('pymobiledevice3'),
    home: process.env.HOME ?? '',
    accept: acceptPython311,
  });
  externalCached = { key, at: Date.now(), path };
  return path;
}

/** Cached by environment, with short negative caching so installing a tool doesn't require a daemon restart. */
let cached: { key: string; at: number; path?: string } | undefined;

/** Clear the lookup cache immediately after a managed ios-tools install completes. */
export function invalidatePymd3PythonCache(): void {
  cached = undefined;
  externalCached = undefined;
}

export function pymd3Python(): string | undefined {
  let managedPath: string | undefined;
  try {
    const m = getComponentManager().resolveManaged('ios-tools');
    if (m?.source === 'managed') managedPath = m.path;
  } catch { /* manifest unavailable */ }
  const key = [process.env.PHONEDOCK_PYMD3_PYTHON, managedPath, process.env.PATH, process.env.HOME].join('\n');
  if (cached?.key === key && Date.now() - cached.at < 5000 && (!cached.path || executable(cached.path))) return cached.path;
  const path = discoverPymd3Python({
    override: process.env.PHONEDOCK_PYMD3_PYTHON,
    managed: managedPath,
    launcher: which('pymobiledevice3'),
    home: process.env.HOME ?? '',
    accept: acceptPython311,
  });
  cached = { key, at: Date.now(), path };
  return path;
}
