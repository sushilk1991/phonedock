// Managed component installer, verifier, lookup and pruning (ios-tools, axe, wda).
// Keeps downloaded runtimes under <PHONEDOCK_HOME>/components/<id>/<key>.
// Lock-free atomic activation: each install stages in stage-<random>, writes .ready.json inside staging,
// and activates via a single atomic rename(payload, <key>). A losing concurrent racer deletes its staging and adopts the winner.
import { createHash, randomBytes } from 'node:crypto';
import {
  accessSync, constants, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync,
  readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { run } from './exec.ts';
import { stateDir, which } from './paths.ts';
import {
  PhoneDockError,
  type ComponentId, type ComponentPhase, type ComponentProgress, type ComponentSource, type ComponentStatus,
} from './types.ts';
import {
  assertAllowedUrl, COMPONENT_IDS, componentKey, currentPlatformKey, envOverrideName, isComponentId, loadManifest, selectArtifact,
  type ComponentArtifact, type ComponentManifest, type ComponentSpec,
} from './components-manifest.ts';

export { COMPONENT_IDS, isComponentId } from './components-manifest.ts';

const READY_FILE = '.ready.json';
const LAST_USED_FILE = '.last-used';
const STAGE_PREFIX = 'stage-';
const TRASH_PREFIX = '.trash-';
const MAX_REDIRECTS = 5;
const PRUNE_UNUSED_MS = 30 * 86_400_000;
const STAGING_ORPHAN_MS = 24 * 3_600_000;
const DEFAULT_BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000];
const DEFAULT_PIP_INDEX_URL = 'https://pypi.org/simple';

interface ReadyMarker {
  key: string;
  version: string;
  activatedAt: string;
  sizeBytes: number;
  binaryRelPath: string;
}

interface RuntimeState {
  installing: boolean;
  progress?: ComponentProgress;
  jobId?: string;
  error?: { code: string; message: string; detail?: string };
  lastAttemptAt?: string;
  nextRetryAt?: number;
  consecutiveFailures: number;
  cachedExternal?: string | null;
  promise?: Promise<ComponentStatus>;
}

export interface ComponentManagerOptions {
  /** Override components root dir (defaults to stateDir('components')). */
  rootDir?: string;
  /** Override tools dir containing components.json and ios-tools.lock. */
  toolsDir?: string;
  /** Override platform key (e.g. 'darwin-arm64'). */
  platformKey?: string;
  /** Allow http://127.0.0.1 downloads (unit tests only). */
  allowLocalhost?: boolean;
  /** Override PyPI index URL (unit tests only; defaults to https://pypi.org/simple). */
  pipIndexUrl?: string;
  /** Override auto-install toggle (defaults to process.env.PHONEDOCK_COMPONENTS_AUTO !== '0'). */
  autoEnabled?: () => boolean;
  /** Override clock (unit tests). */
  now?: () => number;
  /** Override PID liveness check for staging/trash GC (unit tests). */
  pidAlive?: (pid: number) => boolean;
  /** Hook fired inside touchUsed() after ready check and before writing .last-used (unit tests). */
  onBeforeTouchWrite?: (id: ComponentId, key: string) => void;
  /** Hook fired inside prune() after reading stale timestamp and before trashing <key> (unit tests). */
  onBeforePruneTrash?: (id: ComponentId, key: string) => void;
  /** Hook fired inside prune() after trashing a fresh key and before restoring it to <key> (unit tests). */
  onBeforePruneRestore?: (id: ComponentId, key: string) => void;
  /** Hook fired during activation after observing <key> without .ready.json and before trashing it (unit tests). */
  onBeforeGarbageTrash?: (id: ComponentId, key: string) => void | Promise<void>;
  /** Hook fired during activation after trashing a concurrent ready winner and before restoring it to <key> (unit tests). */
  onBeforeGarbageRestore?: (id: ComponentId, key: string) => void | Promise<void>;
  /** Override external discovery for status reporting. */
  externalLookup?: (id: ComponentId) => string | undefined;
  /** Override env override lookup (PHONEDOCK_PYMD3_PYTHON / PHONEDOCK_AXE / PHONEDOCK_WDA_SOURCE). */
  envOverride?: (id: ComponentId) => string | undefined;
  /** Override backoff schedule in ms (unit tests). */
  backoffMs?: readonly number[];
  /** Override write stream factory (unit tests for filesystem error handling). */
  createWriteStream?: typeof createWriteStream;
  /** Extra pip args (unit tests). */
  pipExtraArgs?: string[];
  /** Called whenever a component's status changes (throttled for progress). */
  onChange?: (status: ComponentStatus) => void;
  /** Called after a component activates a new key. */
  onActivated?: (id: ComponentId, binaryPath: string) => void;
  /** Optional daemon job wrapper for auto-triggered installs so jobId is tracked idempotently. */
  startAutoJob?: (id: ComponentId, runFn: (onProgress: (line: string) => void, jobId: string) => Promise<ComponentStatus>) => string;
}

export function isExecutable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

function defaultPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Build a clean child environment for isolated Python venv creation and pip installs. */
export function isolatedPythonEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (v === undefined) continue;
    if (/^(PIP_|PYTHON)/i.test(k)) continue;
    out[k] = v;
  }
  out.PIP_CONFIG_FILE = '/dev/null';
  out.PYTHONNOUSERSITE = '1';
  out.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  return out;
}

/** Exact argv for bsdtar extraction: never pass -P so bsdtar enforces its secure defaults. */
export function tarExtractArgv(tarballPath: string, targetDir: string): string[] {
  return ['-xzf', tarballPath, '-C', targetDir, '--no-same-owner'];
}

/**
 * Hardened post-extraction walk:
 * - rejects anything other than a regular file, directory, or symlink (FIFOs, devices, sockets);
 * - rejects any regular file with nlink > 1 (hardlinks);
 * - rejects any symlink whose resolved realpath escapes rootDir (or is unresolvable/cyclic).
 */
export function verifyExtractedTree(rootDir: string): void {
  const rootReal = realpathSync(rootDir);
  const inside = (p: string) => p === rootReal || p.startsWith(rootReal + sep);
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        let real: string;
        try {
          real = realpathSync(full);
        } catch {
          throw new PhoneDockError(
            'Archive contains an unresolvable symlink',
            'unsafe_archive',
            502,
            undefined,
            `Unresolvable symlink: ${relative(rootReal, full)}`,
          );
        }
        if (!inside(real)) {
          throw new PhoneDockError(
            'Archive symlink resolves outside destination directory',
            'unsafe_archive',
            502,
            undefined,
            `${relative(rootReal, full)} -> ${real}`,
          );
        }
      } else if (st.isFile()) {
        if (st.nlink > 1) {
          throw new PhoneDockError(
            'Archive contains a hardlinked file',
            'unsafe_archive',
            502,
            undefined,
            `Rejected file with nlink=${st.nlink}: ${relative(rootReal, full)}`,
          );
        }
      } else if (st.isDirectory()) {
        walk(full);
      } else {
        throw new PhoneDockError(
          'Archive contains unsupported special file',
          'unsafe_archive',
          502,
          undefined,
          `Rejected non-regular entry: ${relative(rootReal, full)}`,
        );
      }
    }
  };
  walk(rootReal);
}

/** Extract a pinned tarball into a fresh empty staging dir with bsdtar's secure defaults (never -P), then verify the extracted tree. */
export async function safeExtractTarGz(
  tarballPath: string,
  targetDir: string,
  execFn: (cmd: string, args: string[], opts?: { timeoutMs?: number; failureMessage?: string }) => Promise<unknown> = run,
): Promise<void> {
  mkdirSync(targetDir, { recursive: true });
  await execFn('/usr/bin/tar', tarExtractArgv(tarballPath, targetDir), {
    timeoutMs: 120_000,
    failureMessage: 'Could not extract downloaded archive',
  });
  verifyExtractedTree(targetDir);
}

/** Compute total file size recursively (ignoring broken symlinks). */
function dirSizeBytes(root: string): number {
  let total = 0;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      let st;
      try { st = lstatSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) total += st.size;
    }
  };
  try { walk(root); } catch { /* ignore */ }
  return total;
}

/**
 * Make a Python venv built inside `stagePayloadDir` valid at `finalDir` before atomic rename:
 * - convert absolute symlinks inside `venv/bin/*` that point within `stagePayloadDir` to relative symlinks;
 * - rewrite staging paths to `finalDir` in `venv/pyvenv.cfg` and `#!` script headers in `venv/bin/*`.
 */
function relocateVenvForFinalDir(stagePayloadDir: string, finalDir: string): void {
  const stageReal = realpathSync(stagePayloadDir);
  const finalReal = join(realpathSync(dirname(finalDir)), relative(dirname(finalDir), finalDir));
  const venvDir = join(stagePayloadDir, 'venv');
  const venvBin = join(venvDir, 'bin');

  const rewritePathRefs = (text: string): string => text
    .replaceAll(stageReal, finalReal)
    .replaceAll(stagePayloadDir, finalDir);

  const cfgPath = join(venvDir, 'pyvenv.cfg');
  if (existsSync(cfgPath)) {
    writeFileSync(cfgPath, rewritePathRefs(readFileSync(cfgPath, 'utf8')), 'utf8');
  }

  if (existsSync(venvBin)) {
    const venvBinReal = realpathSync(venvBin);
    for (const name of readdirSync(venvBin)) {
      const full = join(venvBin, name);
      let st;
      try { st = lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) {
        const rawTarget = readlinkSync(full);
        if (!isAbsolute(rawTarget)) continue;
        let resolvedTarget = rawTarget;
        try { resolvedTarget = realpathSync(full); } catch { /* fall back to rawTarget */ }
        if (resolvedTarget === stageReal || resolvedTarget.startsWith(stageReal + sep)) {
          unlinkSync(full);
          symlinkSync(relative(venvBinReal, resolvedTarget), full);
        } else if (rawTarget === stagePayloadDir || rawTarget.startsWith(stagePayloadDir + sep)) {
          unlinkSync(full);
          symlinkSync(relative(venvBin, rawTarget), full);
        }
        continue;
      }
      if (!st.isFile() || st.size > 1024 * 1024) continue;
      if (/^activate(\.|$)/i.test(name)) {
        const text = readFileSync(full, 'utf8');
        if (text.includes(stagePayloadDir) || text.includes(stageReal)) {
          writeFileSync(full, rewritePathRefs(text), 'utf8');
        }
        continue;
      }
      const buf = readFileSync(full);
      if (buf.length < 2 || buf[0] !== 0x23 || buf[1] !== 0x21) continue; // not '#!'
      // Rewrite up to the first 4 lines to cover both `#!<python>` and pip's `#!/bin/sh\n'''exec' '<python>'` wrapper.
      let headerEnd = buf.length;
      let newlines = 0;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0a) {
          newlines++;
          if (newlines >= 4) { headerEnd = i; break; }
        }
      }
      const header = buf.subarray(0, headerEnd).toString('utf8');
      if (!header.includes(stagePayloadDir) && !header.includes(stageReal)) continue;
      const updated = rewritePathRefs(header);
      writeFileSync(full, Buffer.concat([Buffer.from(updated, 'utf8'), buf.subarray(headerEnd)]));
    }
  }
}

/** Python AST-based self-check: verifies pymobiledevice3 version and imports every pymobiledevice3* module used by the sidecars. */
const SIDECAR_SELF_CHECK_PY = [
  'import ast, importlib, importlib.metadata, pathlib, sys',
  'expected_ver = sys.argv[1]',
  'sidecars = [pathlib.Path(p) for p in sys.argv[2:]]',
  'actual_ver = importlib.metadata.version("pymobiledevice3")',
  'if expected_ver and actual_ver != expected_ver:',
  '    raise SystemExit(f"pymobiledevice3 version mismatch: expected {expected_ver}, got {actual_ver}")',
  'mods = {"pymobiledevice3"}',
  'for sc in sidecars:',
  '    tree = ast.parse(sc.read_text(encoding="utf-8"), filename=str(sc))',
  '    for node in ast.walk(tree):',
  '        if isinstance(node, ast.Import):',
  '            for a in node.names:',
  '                if a.name == "pymobiledevice3" or a.name.startswith("pymobiledevice3."):',
  '                    mods.add(a.name)',
  '        elif isinstance(node, ast.ImportFrom) and node.module:',
  '            if node.module == "pymobiledevice3" or node.module.startswith("pymobiledevice3."):',
  '                mods.add(node.module)',
  'for mod in sorted(mods):',
  '    importlib.import_module(mod)',
  'print(f"ok:{actual_ver}:{len(mods)}")',
].join('\n');

export class ComponentManager {
  private readonly opts: ComponentManagerOptions;
  private readonly runtime = new Map<ComponentId, RuntimeState>();
  private manifestCache?: { manifest: ComponentManifest; toolsDir: string };
  private pruneTimer?: NodeJS.Timeout;
  private lastEmitAt = new Map<ComponentId, number>();

  constructor(opts: ComponentManagerOptions = {}) {
    this.opts = opts;
    for (const id of COMPONENT_IDS) {
      this.runtime.set(id, { installing: false, consecutiveFailures: 0 });
    }
  }

  private now(): number { return (this.opts.now ?? Date.now)(); }
  private platformKey(): string { return this.opts.platformKey ?? currentPlatformKey(); }

  private rootDir(): string {
    if (this.opts.rootDir) {
      mkdirSync(this.opts.rootDir, { recursive: true });
      return this.opts.rootDir;
    }
    return stateDir('components');
  }

  private componentDir(id: ComponentId): string {
    const dir = join(this.rootDir(), id);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  load(): { manifest: ComponentManifest; toolsDir: string } {
    if (!this.manifestCache) {
      this.manifestCache = loadManifest(this.opts.toolsDir, { allowLocalhost: this.opts.allowLocalhost });
    }
    return this.manifestCache;
  }

  /** Reload manifest from disk (useful in tests or pin-bump verification). */
  reloadManifest(): void {
    this.manifestCache = undefined;
  }

  spec(id: ComponentId): ComponentSpec {
    const s = this.load().manifest.components[id];
    if (!s) {
      throw new PhoneDockError(`${id === 'wda' ? 'WebDriverAgent' : id} isn’t available in this PhoneDock’s components`, 'component_unavailable', 404,
        [id === 'wda' ? 'Update PhoneDock, or set PHONEDOCK_WDA_SOURCE to a WebDriverAgent source tree.' : 'Update PhoneDock.']);
    }
    return s;
  }

  /** The components this manifest has (one from before a component existed leaves it out). */
  private present(): ComponentId[] {
    const comps = this.load().manifest.components;
    return COMPONENT_IDS.filter((id) => comps[id]);
  }

  pinnedKey(id: ComponentId): { key: string; artifact: ComponentArtifact } | undefined {
    const s = this.spec(id);
    const artifact = selectArtifact(s, this.platformKey());
    if (!artifact) return undefined;
    return { key: componentKey(s, artifact), artifact };
  }

  autoInstallEnabled(): boolean {
    if (this.opts.autoEnabled) return this.opts.autoEnabled();
    return process.env.PHONEDOCK_COMPONENTS_AUTO !== '0';
  }

  private rawEnvOverride(id: ComponentId): string | undefined {
    if (this.opts.envOverride) return this.opts.envOverride(id);
    const raw = process.env[envOverrideName(id)];
    return raw !== undefined && raw !== '' ? raw : undefined;
  }

  private externalPath(id: ComponentId): string | undefined {
    if (this.opts.externalLookup) return this.opts.externalLookup(id);
    if (id === 'axe') return which('axe');
    return undefined;
  }

  /** Whether `path` can serve as this component: an executable, or for a source archive a directory holding the
   *  files its manifest requires (the Xcode project, the licence). */
  private usable(id: ComponentId, path: string): boolean {
    let spec: ComponentSpec | undefined;
    try { spec = this.spec(id); } catch { /* manifest unreadable: fall back to the executable check */ }
    if (spec?.kind !== 'source-archive') return isExecutable(path);
    try { if (!statSync(path).isDirectory()) return false; } catch { return false; }
    return (spec.verify.requiredFiles ?? []).every((f) => existsSync(join(path, f)));
  }

  private readReady(id: ComponentId, key: string): { marker: ReadyMarker; binaryPath: string } | undefined {
    const dir = join(this.componentDir(id), key);
    const markerFile = join(dir, READY_FILE);
    if (!existsSync(markerFile)) return undefined;
    try {
      const marker = JSON.parse(readFileSync(markerFile, 'utf8')) as ReadyMarker;
      if (!marker || marker.key !== key || typeof marker.binaryRelPath !== 'string') return undefined;
      const binaryPath = resolve(dir, marker.binaryRelPath);
      if (!binaryPath.startsWith(resolve(dir) + sep)) return undefined;
      if (!this.usable(id, binaryPath)) return undefined;
      return { marker, binaryPath };
    } catch {
      return undefined;
    }
  }

  private readLastUsedMs(keyDir: string, marker: Partial<ReadyMarker & { lastUsedAt?: string }>): number {
    const luFile = join(keyDir, LAST_USED_FILE);
    try {
      if (existsSync(luFile)) {
        const ts = Date.parse(readFileSync(luFile, 'utf8').trim());
        if (Number.isFinite(ts)) return ts;
      }
    } catch { /* fall back to marker */ }
    return Date.parse(marker.lastUsedAt ?? marker.activatedAt ?? '');
  }

  private listReadyKeys(id: ComponentId): { marker: ReadyMarker; binaryPath: string }[] {
    const dir = this.componentDir(id);
    const out: { marker: ReadyMarker; binaryPath: string }[] = [];
    let names: string[];
    try { names = readdirSync(dir); } catch { return out; }
    for (const name of names) {
      if (name.startsWith('.') || name.startsWith(STAGE_PREFIX)) continue;
      const entry = this.readReady(id, name);
      if (entry) out.push(entry);
    }
    out.sort((a, b) => Date.parse(b.marker.activatedAt || '') - Date.parse(a.marker.activatedAt || ''));
    return out;
  }

  /**
   * Managed-only lookup (steps 1–3 of lookup order):
   * 1. Env override (`PHONEDOCK_PYMD3_PYTHON` / `PHONEDOCK_AXE`);
   * 2. This daemon's pinned key, if ready;
   * 3. Most recently activated other ready managed key (keeps working during updates).
   * Returns undefined if caller should fall through to step 4 (external host discovery).
   */
  resolveManaged(id: ComponentId): { path: string; source: 'override' | 'managed'; key?: string; version?: string; isPinned: boolean } | undefined {
    const rawOverride = this.rawEnvOverride(id);
    if (rawOverride !== undefined) {
      return this.usable(id, rawOverride) ? { path: rawOverride, source: 'override', isPinned: true } : undefined;
    }
    let pin: { key: string; artifact: ComponentArtifact } | undefined;
    try { pin = this.pinnedKey(id); } catch { return undefined; }
    if (pin) {
      const exact = this.readReady(id, pin.key);
      if (exact) return { path: exact.binaryPath, source: 'managed', key: pin.key, version: exact.marker.version, isPinned: true };
    }
    const others = this.listReadyKeys(id);
    if (others.length > 0) {
      return { path: others[0].binaryPath, source: 'managed', key: others[0].marker.key, version: others[0].marker.version, isPinned: false };
    }
    return undefined;
  }

  /** Check whether a key dir's `activatedAt` or `.last-used` falls inside the 30-day keep window. */
  private isWithinPruneWindow(keyDir: string, now: number): boolean {
    const markerFile = join(keyDir, READY_FILE);
    let marker: Partial<ReadyMarker & { lastUsedAt?: string }> = {};
    try {
      if (existsSync(markerFile)) {
        marker = JSON.parse(readFileSync(markerFile, 'utf8')) as Partial<ReadyMarker & { lastUsedAt?: string }>;
      }
    } catch { /* ignore unreadable marker */ }
    const activatedMs = Date.parse(marker.activatedAt ?? '');
    if (Number.isFinite(activatedMs) && now - activatedMs <= PRUNE_UNUSED_MS) return true;
    const lastUsedMs = this.readLastUsedMs(keyDir, marker);
    if (Number.isFinite(lastUsedMs) && now - lastUsedMs <= PRUNE_UNUSED_MS) return true;
    return false;
  }

  /** Touch `.last-used` on the active managed key (separate file written atomically via tmp+rename, never creating directories). */
  touchUsed(id: ComponentId): void {
    const resolved = this.resolveManaged(id);
    if (!resolved || resolved.source !== 'managed' || !resolved.key) return;
    const keyDir = join(this.componentDir(id), resolved.key);
    if (!existsSync(join(keyDir, READY_FILE))) return;
    this.opts.onBeforeTouchWrite?.(id, resolved.key);
    const filePath = join(keyDir, LAST_USED_FILE);
    const tmp = join(keyDir, `${LAST_USED_FILE}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
    try {
      writeFileSync(tmp, new Date(this.now()).toISOString() + '\n', 'utf8');
      renameSync(tmp, filePath);
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* ignore */ }
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      /* best effort */
    }
  }

  /**
   * Prune sibling keys that are NOT this daemon's pin, NOT referenced by an env override, and haven't been used in 30 days.
   * Also garbage-collects dead-PID `stage-<pid>-*` dirs older than 24 h and dead-PID `.trash-*` dirs.
   */
  prune(id?: ComponentId): { removedKeys: string[]; removedStaging: string[]; removedTrash: string[] } {
    const ids = id ? [id] : this.present();
    const removedKeys: string[] = [];
    const removedStaging: string[] = [];
    const removedTrash: string[] = [];
    const pidAlive = this.opts.pidAlive ?? defaultPidAlive;
    const now = this.now();

    for (const cid of ids) {
      const dir = this.componentDir(cid);
      let pinned: string | undefined;
      try { pinned = this.pinnedKey(cid)?.key; } catch { pinned = undefined; }
      const rawOverride = this.rawEnvOverride(cid);
      const protectedOverrides: string[] = [];
      if (rawOverride) {
        protectedOverrides.push(resolve(rawOverride));
        try { protectedOverrides.push(realpathSync(rawOverride)); } catch { /* may not exist */ }
      }
      const isProtectedByOverride = (keyDir: string): boolean => {
        if (!protectedOverrides.length) return false;
        const candidates = [resolve(keyDir)];
        try { candidates.push(realpathSync(keyDir)); } catch { /* ignore */ }
        return candidates.some((kd) => protectedOverrides.some((ov) => ov === kd || ov.startsWith(kd + sep)));
      };

      let names: string[];
      try { names = readdirSync(dir); } catch { continue; }
      for (const name of names) {
        const entryPath = join(dir, name);
        // Clean up leftover .trash-* directories owned by dead PIDs (skip live pruners' in-flight trash).
        if (name.startsWith(TRASH_PREFIX)) {
          const tm = /^\.trash-(\d+)-/.exec(name);
          if (tm && pidAlive(Number(tm[1]))) continue;
          try {
            rmSync(entryPath, { recursive: true, force: true });
            removedTrash.push(`${cid}/${name}`);
          } catch { /* ignore */ }
          continue;
        }
        // Clean up abandoned stage-<pid>-<rand> directories ONLY when the owning PID is dead AND older than 24 h.
        if (name.startsWith(STAGE_PREFIX)) {
          const sm = /^stage-(\d+)-/.exec(name);
          if (!sm) continue;
          if (pidAlive(Number(sm[1]))) continue;
          try {
            const st = statSync(entryPath);
            if (now - st.mtimeMs > STAGING_ORPHAN_MS) {
              rmSync(entryPath, { recursive: true, force: true });
              removedStaging.push(`${cid}/${name}`);
            }
          } catch { /* ignore */ }
          continue;
        }
        if (name.startsWith('.')) continue;
        if (pinned && name === pinned) continue; // never prune this daemon's pin
        if (isProtectedByOverride(entryPath)) continue; // never prune a key an active override points into
        const markerFile = join(entryPath, READY_FILE);
        if (!existsSync(markerFile)) continue;
        try {
          const marker = JSON.parse(readFileSync(markerFile, 'utf8')) as Partial<ReadyMarker & { lastUsedAt?: string }>;
          const lastUsed = this.readLastUsedMs(entryPath, marker);
          const activated = Date.parse(marker.activatedAt ?? '');
          const hasTimestamp = Number.isFinite(lastUsed) || Number.isFinite(activated);
          if (!hasTimestamp || this.isWithinPruneWindow(entryPath, now)) continue;

          this.opts.onBeforePruneTrash?.(cid, name);

          // Rename to .trash-<pid>-<random> first; a losing concurrent pruner gets ENOENT and ignores it.
          const trashDir = join(dir, `${TRASH_PREFIX}${process.pid}-${randomBytes(4).toString('hex')}`);
          try {
            renameSync(entryPath, trashDir);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw err;
          }

          // Re-check the trashed copy's activatedAt and .last-used in case another process reinstalled it while we paused.
          if (this.isWithinPruneWindow(trashDir, this.now())) {
            this.opts.onBeforePruneRestore?.(cid, name);
            try {
              renameSync(trashDir, entryPath);
            } catch (err) {
              const code = (err as NodeJS.ErrnoException).code;
              if (code === 'ENOTEMPTY' || code === 'EEXIST') {
                // Another process already placed a copy at <key>; discard the duplicate trash.
                rmSync(trashDir, { recursive: true, force: true });
              } else {
                throw err;
              }
            }
            continue;
          }

          rmSync(trashDir, { recursive: true, force: true });
          removedKeys.push(`${cid}/${name}`);
        } catch { /* ignore unreadable marker or race */ }
      }
    }
    return { removedKeys, removedStaging, removedTrash };
  }

  /** Start lifecycle hooks: touch active keys, prune stale unused keys & GC abandoned staging/trash, and repeat daily. */
  startLifecycle(): void {
    for (const id of this.present()) this.touchUsed(id);
    this.prune();
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = setInterval(() => {
      for (const id of this.present()) this.touchUsed(id);
      this.prune();
    }, 86_400_000);
    this.pruneTimer.unref();
  }

  stopLifecycle(): void {
    if (this.pruneTimer) { clearInterval(this.pruneTimer); this.pruneTimer = undefined; }
  }

  /** Compute current ComponentStatus snapshot for one component. */
  status(id: ComponentId): ComponentStatus {
    const s = this.spec(id);
    const rt = this.runtime.get(id)!;
    const pin = this.pinnedKey(id);
    const rawOverride = this.rawEnvOverride(id);

    // An explicitly set override that is missing or not executable stops auto-install and reports invalid override.
    if (rawOverride !== undefined && !this.usable(id, rawOverride)) {
      const envName = envOverrideName(id);
      return {
        id,
        displayName: s.displayName,
        description: s.description,
        state: 'failed',
        pinnedVersion: s.version,
        source: 'override',
        updateAvailable: false,
        estimatedBytes: s.estimatedDiskBytes,
        ...(pin ? { downloadBytes: pin.artifact.size } : {}),
        detail: s.kind === 'source-archive'
          ? `${envName} is set to a path that isn’t a ${s.displayName} source folder.`
          : `${envName} is set to a missing or non-executable path.`,
        error: {
          code: 'invalid_override',
          message: `Configured ${envName} override is not executable`,
          detail: `${envName}=${rawOverride}`,
        },
      };
    }

    const managed = this.resolveManaged(id);
    // Never run synchronous external probes repeatedly on progress ticks while installing.
    const external = !managed
      ? (rt.installing && rt.cachedExternal !== undefined ? (rt.cachedExternal ?? undefined) : this.externalPath(id))
      : undefined;

    let source: ComponentSource = 'none';
    let installedVersion: string | undefined;
    let sizeBytes: number | undefined;
    let updateAvailable = false;
    let detail: string | undefined;

    if (managed) {
      source = managed.source;
      installedVersion = managed.source === 'override' ? undefined : managed.version;
      if (managed.source === 'managed' && managed.key) {
        sizeBytes = this.readReady(id, managed.key)?.marker.sizeBytes;
        updateAvailable = Boolean(pin && managed.key !== pin.key);
      }
    } else if (external) {
      source = 'external';
      updateAvailable = false;
      detail = 'Using the copy installed on this Mac. PhoneDock installs its own pinned copy when needed.';
    }

    let state: ComponentStatus['state'];
    if (rt.installing) {
      state = 'installing';
    } else if (managed) {
      state = 'ready';
    } else if (rt.error) {
      state = 'failed';
    } else if (external) {
      state = 'ready';
    } else {
      state = 'missing';
    }

    return {
      id,
      displayName: s.displayName,
      description: s.description,
      state,
      pinnedVersion: s.version,
      ...(installedVersion ? { installedVersion } : {}),
      source,
      updateAvailable,
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      estimatedBytes: s.estimatedDiskBytes,
      ...(pin ? { downloadBytes: pin.artifact.size } : {}),
      ...(rt.installing && rt.progress ? { progress: { ...rt.progress } } : {}),
      ...(rt.installing && rt.jobId ? { jobId: rt.jobId } : {}),
      ...(detail && !rt.installing ? { detail } : {}),
      ...(rt.error && !rt.installing ? { error: { ...rt.error } } : {}),
      ...(rt.lastAttemptAt ? { lastAttemptAt: rt.lastAttemptAt } : {}),
      ...(rt.nextRetryAt && rt.nextRetryAt > this.now() ? { nextRetryAt: new Date(rt.nextRetryAt).toISOString() } : {}),
    };
  }

  listStatuses(): ComponentStatus[] {
    return this.present().map((id) => this.status(id));
  }

  /** Whether this component is already at the daemon's pinned key (or overridden by env). */
  isCurrent(id: ComponentId): boolean {
    if (this.rawEnvOverride(id) !== undefined) return true;
    const resolved = this.resolveManaged(id);
    return Boolean(resolved && resolved.isPinned);
  }

  /** In-flight job id if installing. */
  activeJobId(id: ComponentId): string | undefined {
    const rt = this.runtime.get(id);
    return rt?.installing ? rt.jobId : undefined;
  }

  private emitStatus(id: ComponentId, force = false): ComponentStatus | undefined {
    if (!this.opts.onChange) return force ? this.status(id) : undefined;
    const now = this.now();
    const last = this.lastEmitAt.get(id) ?? 0;
    if (!force && now - last < 350) return undefined;
    this.lastEmitAt.set(id, now);
    const st = this.status(id);
    try { this.opts.onChange(st); } catch { /* best effort */ }
    return st;
  }

  /**
   * Non-blocking automatic install trigger with dedupe and exponential backoff.
   * Respects PHONEDOCK_COMPONENTS_AUTO=0 and never triggers when an env override is set (valid or invalid).
   */
  triggerAuto(id: ComponentId, opts: { startJob?: (id: ComponentId, runFn: (onProgress: (line: string) => void, jobId: string) => Promise<ComponentStatus>) => string } = {}): boolean {
    if (!this.autoInstallEnabled()) return false;
    if (this.rawEnvOverride(id) !== undefined) return false;
    if (this.isCurrent(id)) return false;
    const rt = this.runtime.get(id)!;
    if (rt.installing) return false;
    if (rt.nextRetryAt && this.now() < rt.nextRetryAt) return false;
    if (!this.pinnedKey(id)) return false; // unsupported platform
    const wrap = opts.startJob ?? this.opts.startAutoJob;
    if (wrap) {
      const jobId = wrap(id, (onProgress, jid) => this.install(id, { reason: 'auto', jobId: jid, onProgress }));
      rt.jobId = jobId;
    } else {
      void this.install(id, { reason: 'auto' }).catch(() => undefined);
    }
    return true;
  }

  /**
   * Install (or update) a component to the daemon's pinned key.
   * Idempotent while an install is already running in-process; manual calls bypass backoff.
   */
  install(
    id: ComponentId,
    opts: { reason?: 'auto' | 'manual'; jobId?: string; onProgress?: (line: string) => void } = {},
  ): Promise<ComponentStatus> {
    const rt = this.runtime.get(id)!;
    if (rt.installing && rt.promise) {
      return rt.promise;
    }
    if (opts.reason !== 'auto') {
      rt.nextRetryAt = undefined;
      rt.consecutiveFailures = 0;
    }

    const promise = this.runInstall(id, opts);
    rt.promise = promise;
    return promise;
  }

  private async runInstall(
    id: ComponentId,
    opts: { reason?: 'auto' | 'manual'; jobId?: string; onProgress?: (line: string) => void },
  ): Promise<ComponentStatus> {
    const rt = this.runtime.get(id)!;
    const spec = this.spec(id);
    const pin = this.pinnedKey(id);
    if (!pin) {
      throw new PhoneDockError(
        `${spec.displayName} is not available for this platform (${this.platformKey()})`,
        'unsupported_platform',
        501,
      );
    }
    const { key, artifact } = pin;

    // Fast path: already ready at pinned key.
    if (this.readReady(id, key)) {
      this.touchUsed(id);
      rt.error = undefined;
      rt.consecutiveFailures = 0;
      rt.nextRetryAt = undefined;
      return this.emitStatus(id, true)!;
    }

    rt.installing = true;
    rt.jobId = opts.jobId;
    rt.error = undefined;
    rt.cachedExternal = this.externalPath(id) ?? null;
    rt.lastAttemptAt = new Date(this.now()).toISOString();

    const setProgress = (phase: ComponentPhase, percent?: number, bytesDone?: number, bytesTotal?: number, detail?: string, force = false) => {
      rt.progress = {
        phase,
        ...(percent !== undefined ? { percent: Math.max(0, Math.min(100, Math.round(percent))) } : {}),
        ...(bytesDone !== undefined ? { bytesDone } : {}),
        ...(bytesTotal !== undefined ? { bytesTotal } : {}),
        ...(detail ? { detail } : {}),
      };
      if (detail && opts.onProgress) opts.onProgress(detail);
      this.emitStatus(id, force);
    };

    setProgress('queued', 0, 0, artifact.size, `Preparing ${spec.displayName} ${spec.version}…`, true);

    let stageDir: string | undefined;

    try {
      const compDir = this.componentDir(id);
      const finalDir = join(compDir, key);
      stageDir = join(compDir, `${STAGE_PREFIX}${process.pid}-${randomBytes(6).toString('hex')}`);
      mkdirSync(stageDir, { recursive: true });

      const archivePath = join(stageDir, artifact.filename || 'archive.tar.gz');
      const payloadDir = join(stageDir, 'payload');
      const dlWeight = spec.kind === 'python-venv' ? 40 : 70;

      // 1. Download (streamed, size-capped, host-allowlisted) + incremental sha256
      setProgress('downloading', 1, 0, artifact.size, `Downloading ${spec.displayName}…`, true);
      const actualSha = await this.downloadVerified(artifact, archivePath, (done, total) => {
        const frac = total > 0 ? Math.min(1, done / total) : 0;
        setProgress('downloading', 1 + frac * (dlWeight - 1), done, total);
      });

      // 2. Verify sha256
      setProgress('verifying', dlWeight, artifact.size, artifact.size, 'Verifying checksum…', true);
      if (actualSha !== artifact.sha256) {
        throw new PhoneDockError(
          `Checksum mismatch while downloading ${spec.displayName}`,
          'checksum_mismatch',
          502,
          ['Try again; the downloaded file was rejected.'],
          `Expected sha256 ${artifact.sha256}, got ${actualSha}`,
        );
      }

      // 3. Extract inside staging using bsdtar secure defaults (never -P) + hardened post-extraction walk
      setProgress('extracting', dlWeight + 5, artifact.size, artifact.size, 'Extracting archive…', true);
      await safeExtractTarGz(archivePath, payloadDir);
      rmSync(archivePath, { force: true });

      // 4. Component-specific build & self-check inside staging
      let binaryRelPath: string;
      if (spec.kind === 'python-venv') {
        binaryRelPath = await this.buildAndVerifyPythonVenv(spec, payloadDir, (phase, pct, detail) => {
          setProgress(phase, pct, artifact.size, artifact.size, detail, true);
        });
        // Rewrite venv paths from staging to finalDir so the single atomic rename activates a working venv.
        relocateVenvForFinalDir(payloadDir, finalDir);
      } else if (spec.kind === 'source-archive') {
        binaryRelPath = this.verifySourceArchive(spec, payloadDir, (phase, pct, detail) => {
          setProgress(phase, pct, artifact.size, artifact.size, detail, true);
        });
      } else {
        binaryRelPath = await this.verifyBinaryArchive(spec, payloadDir, (phase, pct, detail) => {
          setProgress(phase, pct, artifact.size, artifact.size, detail, true);
        });
      }

      // 5. Write .ready.json and .last-used INSIDE staging BEFORE the single atomic rename.
      const nowIso = new Date(this.now()).toISOString();
      const marker: ReadyMarker = {
        key,
        version: spec.version,
        activatedAt: nowIso,
        sizeBytes: dirSizeBytes(payloadDir),
        binaryRelPath,
      };
      writeFileSync(join(payloadDir, READY_FILE), JSON.stringify(marker, null, 2) + '\n', 'utf8');
      writeFileSync(join(payloadDir, LAST_USED_FILE), nowIso + '\n', 'utf8');

      // 6. Atomic activation: rename(payloadDir, finalDir). If another process won the race, adopt theirs.
      // Defensive: if finalDir exists WITHOUT .ready.json (garbage), trash it and retry activation once.
      const tryActivate = (): boolean => {
        try {
          renameSync(payloadDir, finalDir);
          return true;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOTEMPTY' || code === 'EEXIST') return false;
          throw err;
        }
      };

      if (!tryActivate()) {
        if (this.readReady(id, key)) {
          this.touchUsed(id);
        } else if (!existsSync(join(finalDir, READY_FILE))) {
          await this.opts.onBeforeGarbageTrash?.(id, key);
          const trashDir = join(compDir, `${TRASH_PREFIX}${process.pid}-${randomBytes(4).toString('hex')}`);
          let trashed = false;
          try {
            renameSync(finalDir, trashDir);
            trashed = true;
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          }

          if (trashed && existsSync(join(trashDir, READY_FILE))) {
            // A concurrent winner cleared the garbage and activated a ready key before our rename: restore and adopt it.
            await this.opts.onBeforeGarbageRestore?.(id, key);
            try {
              renameSync(trashDir, finalDir);
              this.touchUsed(id);
            } catch (err) {
              const code = (err as NodeJS.ErrnoException).code;
              if (code === 'ENOTEMPTY' || code === 'EEXIST') {
                rmSync(trashDir, { recursive: true, force: true });
                if (this.readReady(id, key)) {
                  this.touchUsed(id);
                } else {
                  throw new PhoneDockError(`Could not activate ${spec.displayName}`, 'install_failed', 500);
                }
              } else {
                throw err;
              }
            }
          } else {
            if (trashed) rmSync(trashDir, { recursive: true, force: true });
            if (!tryActivate()) {
              if (this.readReady(id, key)) {
                this.touchUsed(id);
              } else {
                throw new PhoneDockError(`Could not activate ${spec.displayName}`, 'install_failed', 500);
              }
            }
          }
        } else {
          throw new PhoneDockError(`Could not activate ${spec.displayName}`, 'install_failed', 500);
        }
      }

      const ready = this.readReady(id, key);
      if (!ready) {
        throw new PhoneDockError(`Activated ${spec.displayName} is not executable`, 'install_failed', 500);
      }

      rt.installing = false;
      rt.progress = undefined;
      rt.jobId = undefined;
      rt.cachedExternal = undefined;
      rt.error = undefined;
      rt.consecutiveFailures = 0;
      rt.nextRetryAt = undefined;
      rt.promise = undefined;

      this.opts.onActivated?.(id, ready.binaryPath);
      return this.emitStatus(id, true)!;
    } catch (err) {
      const pe = err instanceof PhoneDockError ? err : new PhoneDockError(
        `Couldn’t install ${spec.displayName}`,
        'install_failed',
        502,
        undefined,
        err instanceof Error ? err.message : String(err),
      );
      rt.installing = false;
      rt.progress = undefined;
      rt.jobId = undefined;
      rt.cachedExternal = undefined;
      rt.promise = undefined;
      rt.error = { code: pe.code, message: pe.message, ...(pe.detail ? { detail: pe.detail } : {}) };
      rt.consecutiveFailures += 1;
      const schedule = this.opts.backoffMs ?? DEFAULT_BACKOFF_MS;
      const delay = schedule[Math.min(rt.consecutiveFailures - 1, schedule.length - 1)] ?? 30_000;
      rt.nextRetryAt = this.now() + delay;
      this.emitStatus(id, true);
      throw pe;
    } finally {
      if (stageDir) {
        try { rmSync(stageDir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
  }

  /** Stream download over HTTPS with per-hop allowlist check, strict byte cap, and streaming sha256. */
  private async downloadVerified(
    artifact: ComponentArtifact,
    destPath: string,
    onBytes: (done: number, total: number) => void,
  ): Promise<string> {
    const allowedHosts = this.load().manifest.allowedHosts;
    let currentUrl = assertAllowedUrl(artifact.url, allowedHosts, this.opts.allowLocalhost);
    let res: Response | undefined;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      res = await fetch(currentUrl, {
        redirect: 'manual',
        headers: { 'User-Agent': 'PhoneDock/components' },
        signal: AbortSignal.timeout(180_000),
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new PhoneDockError('Download redirect missing Location header', 'download_failed', 502);
        const nextUrl = new URL(loc, currentUrl);
        currentUrl = assertAllowedUrl(nextUrl.toString(), allowedHosts, this.opts.allowLocalhost);
        continue;
      }
      break;
    }

    if (!res || !res.ok || !res.body) {
      throw new PhoneDockError(
        `Download failed (HTTP ${res?.status ?? 'error'})`,
        'download_failed',
        502,
        ['Check your internet connection and try again.'],
        `GET ${currentUrl.toString()} -> HTTP ${res?.status ?? 'no response'}`,
      );
    }

    const cl = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(cl) && cl > artifact.size) {
      throw new PhoneDockError(
        'Downloaded file exceeds expected size',
        'size_exceeded',
        502,
        undefined,
        `Content-Length ${cl} exceeds pinned size ${artifact.size}`,
      );
    }

    const hash = createHash('sha256');
    const out = (this.opts.createWriteStream ?? createWriteStream)(destPath, { mode: 0o644 });
    // Attach persistent error handler before reading any network chunks so ENOSPC / open errors never crash the daemon.
    let streamErr: PhoneDockError | undefined;
    let rejectStream!: (err: PhoneDockError) => void;
    const streamFailed = new Promise<never>((_res, rej) => { rejectStream = rej; });
    streamFailed.catch(() => { /* observed via Promise.race / streamErr checks */ });
    out.on('error', (err: Error) => {
      if (!streamErr) {
        streamErr = new PhoneDockError(
          'Could not write downloaded component to disk',
          'download_write_failed',
          500,
          ['Check free disk space and folder permissions, then try again.'],
          err.message,
        );
        rejectStream(streamErr);
      }
    });

    let bytesDone = 0;
    const reader = res.body.getReader();

    try {
      while (true) {
        if (streamErr) throw streamErr;
        const { done, value } = await Promise.race([reader.read(), streamFailed]);
        if (streamErr) throw streamErr;
        if (done) break;
        const chunk = Buffer.from(value);
        bytesDone += chunk.length;
        if (bytesDone > artifact.size) {
          throw new PhoneDockError(
            'Downloaded file exceeded expected size limit',
            'size_exceeded',
            502,
            undefined,
            `Received ${bytesDone} bytes, cap is ${artifact.size}`,
          );
        }
        hash.update(chunk);
        if (!out.write(chunk)) {
          await Promise.race([
            new Promise<void>((resolveWrite) => { out.once('drain', resolveWrite); }),
            streamFailed,
          ]);
        }
        if (streamErr) throw streamErr;
        onBytes(bytesDone, artifact.size);
      }
      await Promise.race([
        new Promise<void>((resolveEnd) => {
          out.once('finish', resolveEnd);
          out.end();
        }),
        streamFailed,
      ]);
      if (streamErr) throw streamErr;
    } catch (e) {
      out.destroy();
      try { await reader.cancel(); } catch { /* ignore */ }
      try { rmSync(destPath, { force: true }); } catch { /* ignore */ }
      throw e;
    }

    if (bytesDone !== artifact.size) {
      throw new PhoneDockError(
        'Downloaded file size did not match manifest',
        'checksum_mismatch',
        502,
        ['Try again; the download was incomplete.'],
        `Expected ${artifact.size} bytes, got ${bytesDone}`,
      );
    }
    return hash.digest('hex');
  }

  private async buildAndVerifyPythonVenv(
    spec: ComponentSpec,
    payloadDir: string,
    onStep: (phase: ComponentPhase, pct: number, detail: string) => void,
  ): Promise<string> {
    const pyBin = [
      join(payloadDir, 'python', 'bin', 'python3'),
      join(payloadDir, 'bin', 'python3'),
      join(payloadDir, 'python', 'bin', 'python'),
    ].find((p) => isExecutable(p));
    if (!pyBin) {
      throw new PhoneDockError('Extracted Python runtime is missing python3', 'install_failed', 502);
    }

    const env = isolatedPythonEnv();
    const venvDir = join(payloadDir, 'venv');
    onStep('installing', 50, 'Creating Python virtual environment…');
    await run(pyBin, ['-I', '-m', 'venv', venvDir], {
      env,
      timeoutMs: 120_000,
      failureMessage: 'Could not create Python virtual environment',
    });

    const venvPython = join(venvDir, 'bin', 'python');
    if (!isExecutable(venvPython)) {
      throw new PhoneDockError('Python virtual environment is missing bin/python', 'install_failed', 502);
    }

    const { toolsDir } = this.load();
    const lockPath = join(toolsDir, spec.lockFile!);
    const indexUrl = this.opts.pipIndexUrl ?? DEFAULT_PIP_INDEX_URL;

    onStep('installing', 60, `Installing ${spec.verify.package ?? 'pymobiledevice3'} ${spec.version}…`);
    const pipArgs = [
      '-I', '-m', 'pip', 'install',
      '--isolated',
      '--index-url', indexUrl,
      '--require-hashes',
      '--only-binary=:all:',
      '--no-deps',
      '--no-input',
      '--disable-pip-version-check',
      ...(this.opts.pipExtraArgs ?? []),
      '-r', lockPath,
    ];
    await run(venvPython, pipArgs, {
      env,
      timeoutMs: 300_000,
      failureMessage: `Could not install ${spec.displayName} packages`,
    });

    // Self-check: AST-walk sidecars to collect every pymobiledevice3* module and import each with python -I.
    onStep('checking', 92, 'Verifying iPhone helpers…');
    const sidecarPaths = (spec.verify.sidecars ?? []).map((name) => join(toolsDir, name));
    for (const sc of sidecarPaths) {
      if (!existsSync(sc)) {
        throw new PhoneDockError('iPhone helper script missing for verification', 'self_check_failed', 500, undefined, `Missing ${sc}`);
      }
    }
    await run(venvPython, ['-I', '-c', SIDECAR_SELF_CHECK_PY, spec.verify.version ?? spec.version, ...sidecarPaths], {
      env,
      timeoutMs: 60_000,
      failureMessage: `${spec.displayName} self-check failed`,
    });

    return join('venv', 'bin', 'python');
  }

  /** A source archive is usable when its one top directory holds every required file; that directory becomes the
   *  component path (what resolveManaged returns). Nothing in it is run. */
  private verifySourceArchive(
    spec: ComponentSpec,
    payloadDir: string,
    onStep: (phase: ComponentPhase, pct: number, detail: string) => void,
  ): string {
    onStep('checking', 90, `Verifying ${spec.displayName}…`);
    const top = spec.verify.sourceDir!;
    const entries = readdirSync(payloadDir).filter((n) => n !== '.DS_Store');
    if (entries.length !== 1 || entries[0] !== top || !statSync(join(payloadDir, top)).isDirectory()) {
      throw new PhoneDockError(`Extracted archive doesn’t hold ${spec.displayName}`, 'self_check_failed', 502, undefined,
        `Expected one top directory "${top}", got: ${entries.slice(0, 5).join(', ') || '(nothing)'}`);
    }
    const missing = (spec.verify.requiredFiles ?? []).filter((f) => !existsSync(join(payloadDir, top, f)));
    if (missing.length) {
      throw new PhoneDockError(`Extracted ${spec.displayName} is incomplete`, 'self_check_failed', 502, undefined, `Missing: ${missing.join(', ')}`);
    }
    return top;
  }

  private async verifyBinaryArchive(
    spec: ComponentSpec,
    payloadDir: string,
    onStep: (phase: ComponentPhase, pct: number, detail: string) => void,
  ): Promise<string> {
    const binName = spec.verify.binary ?? spec.id;
    let relPath: string | undefined;
    if (isExecutable(join(payloadDir, binName))) {
      relPath = binName;
    } else if (isExecutable(join(payloadDir, 'bin', binName))) {
      relPath = join('bin', binName);
    } else {
      for (const entry of readdirSync(payloadDir)) {
        const cand = join(payloadDir, entry, binName);
        if (isExecutable(cand)) { relPath = join(entry, binName); break; }
      }
    }
    if (!relPath) {
      throw new PhoneDockError(`Extracted archive is missing executable "${binName}"`, 'self_check_failed', 502);
    }

    onStep('checking', 90, `Verifying ${spec.displayName}…`);
    const binPath = join(payloadDir, relPath);
    const args = spec.verify.versionArgs ?? ['--version'];
    const res = await run(binPath, args, {
      timeoutMs: 15_000,
      failureMessage: `${spec.displayName} self-check failed`,
    });
    const actual = res.stdout.trim().replace(/^v/i, '');
    const expected = (spec.verify.expectedVersion ?? spec.version).replace(/^v/i, '');
    if (actual !== expected) {
      throw new PhoneDockError(
        `${spec.displayName} version mismatch`,
        'self_check_failed',
        502,
        undefined,
        `Expected ${expected}, got "${res.stdout.trim()}"`,
      );
    }
    return relPath;
  }
}

let defaultManager: ComponentManager | undefined;

export function getComponentManager(): ComponentManager {
  if (!defaultManager) {
    defaultManager = new ComponentManager();
  }
  return defaultManager;
}

export function setComponentManager(manager: ComponentManager | undefined): void {
  defaultManager = manager;
}

/** The WebDriverAgent source folder to build: PHONEDOCK_WDA_SOURCE, else the pinned managed copy, else the newest
 *  other managed copy. Never a git clone of upstream HEAD. */
export function resolveWdaSource(manager: ComponentManager = getComponentManager()): { path: string; version?: string; source: 'override' | 'managed' } | undefined {
  const r = manager.resolveManaged('wda');
  return r ? { path: r.path, version: r.version, source: r.source } : undefined;
}

/** Resolve AXe binary using the standard 4-step lookup order (override -> pinned -> newest managed -> PATH). */
export function resolveAxeBinary(manager: ComponentManager = getComponentManager()): string | undefined {
  const env = process.env.PHONEDOCK_AXE;
  if (env !== undefined && env !== '') return isExecutable(env) ? env : undefined;
  const managed = manager.resolveManaged('axe');
  if (managed) return managed.path;
  return which('axe');
}
