// Managed component installer, verifier, lookup, locking and pruning (ios-tools, axe).
// Keeps downloaded runtimes under <PHONEDOCK_HOME>/components/<id>/<key> with atomic activation and cross-process locks.
import { createHash, randomBytes } from 'node:crypto';
import {
  accessSync, constants, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync,
  readlinkSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { run, sleep } from './exec.ts';
import { stateDir, which } from './paths.ts';
import {
  PhoneDockError,
  type ComponentId, type ComponentPhase, type ComponentProgress, type ComponentSource, type ComponentStatus,
} from './types.ts';
import {
  assertAllowedUrl, COMPONENT_IDS, componentKey, currentPlatformKey, isComponentId, loadManifest, selectArtifact,
  type ComponentArtifact, type ComponentManifest, type ComponentSpec,
} from './components-manifest.ts';

export { COMPONENT_IDS, isComponentId } from './components-manifest.ts';

const READY_FILE = '.ready.json';
const LOCK_DIR_NAME = '.lock';
const LOCK_OWNER_FILE = 'owner.json';
const STAGING_DIR_NAME = '.staging';
const MAX_REDIRECTS = 5;
const PRUNE_UNUSED_MS = 30 * 86_400_000;
const STAGING_ORPHAN_MS = 24 * 3_600_000;
const DEFAULT_LOCK_STALE_MS = 5 * 60_000;
const DEFAULT_LOCK_MISSING_GRACE_MS = 5_000;
const DEFAULT_LOCK_HEARTBEAT_MS = 10_000;
const DEFAULT_LOCK_POLL_MS = 500;
const DEFAULT_BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000];
const DEFAULT_PIP_INDEX_URL = 'https://pypi.org/simple';

interface ReadyMarker {
  key: string;
  version: string;
  activatedAt: string;
  lastUsedAt: string;
  sizeBytes: number;
  binaryRelPath: string;
}

interface LockOwner {
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  key: string;
}

interface RuntimeState {
  installing: boolean;
  progress?: ComponentProgress;
  jobId?: string;
  error?: { code: string; message: string; detail?: string };
  lastAttemptAt?: string;
  nextRetryAt?: number;
  consecutiveFailures: number;
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
  /** Override PID liveness check (unit tests). */
  pidAlive?: (pid: number) => boolean;
  /** Override external discovery for status reporting. */
  externalLookup?: (id: ComponentId) => string | undefined;
  /** Override env override lookup (PHONEDOCK_PYMD3_PYTHON / PHONEDOCK_AXE). */
  envOverride?: (id: ComponentId) => string | undefined;
  /** Override backoff schedule in ms (unit tests). */
  backoffMs?: readonly number[];
  /** Override cross-process lock timings (unit tests). */
  lockStaleMs?: number;
  lockMissingGraceMs?: number;
  lockHeartbeatMs?: number;
  lockPollMs?: number;
  lockWaitTimeoutMs?: number;
  /** Skip default network download / venv steps in unit tests when custom hooks provided. */
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
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function atomicWriteJson(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  renameSync(tmp, filePath);
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

/** Validate every tar entry path before extraction; rejects absolute paths, `..`, and special device nodes. */
export async function inspectTarSafety(tarballPath: string, targetDir: string): Promise<string[]> {
  const listRes = await run('/usr/bin/tar', ['-tzf', tarballPath], {
    timeoutMs: 30_000,
    failureMessage: 'Could not inspect downloaded archive',
  });
  const entries = listRes.stdout.split(/\r?\n/).filter((l) => l.length > 0);
  if (entries.length === 0) {
    throw new PhoneDockError('Downloaded archive is empty', 'unsafe_archive', 502);
  }
  const base = resolve(targetDir);
  for (const entry of entries) {
    if (entry.includes('\0')) {
      throw new PhoneDockError('Archive contains invalid filename', 'unsafe_archive', 502, undefined, `NUL byte in tar entry: ${entry}`);
    }
    if (entry.startsWith('/') || entry.startsWith('\\')) {
      throw new PhoneDockError('Archive contains an absolute path', 'unsafe_archive', 502, undefined, `Rejected absolute tar entry: ${entry}`);
    }
    const parts = entry.split(/[\\/]+/);
    if (parts.includes('..')) {
      throw new PhoneDockError('Archive contains a path traversal entry', 'unsafe_archive', 502, undefined, `Rejected tar traversal entry: ${entry}`);
    }
    const resolved = resolve(base, normalize(entry));
    if (resolved !== base && !resolved.startsWith(base + sep)) {
      throw new PhoneDockError('Archive entry escapes destination directory', 'unsafe_archive', 502, undefined, `Rejected escaping tar entry: ${entry}`);
    }
  }
  // Check verbose listing for device nodes or FIFOs.
  const verbRes = await run('/usr/bin/tar', ['-tvzf', tarballPath], {
    timeoutMs: 30_000,
    failureMessage: 'Could not inspect downloaded archive metadata',
  });
  for (const line of verbRes.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const modeChar = line[0];
    if (modeChar === 'b' || modeChar === 'c' || modeChar === 'p') {
      throw new PhoneDockError('Archive contains unsupported special file', 'unsafe_archive', 502, undefined, `Rejected tar entry: ${line}`);
    }
  }
  return entries;
}

/** Verify no extracted symlink points outside rootDir. */
export function verifyExtractedSymlinks(rootDir: string): void {
  const base = resolve(rootDir);
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        const target = readlinkSync(full);
        if (target.startsWith('/')) {
          throw new PhoneDockError('Archive contains an absolute symlink', 'unsafe_archive', 502, undefined, `Symlink ${relative(base, full)} -> ${target}`);
        }
        const resolved = resolve(dirname(full), target);
        if (resolved !== base && !resolved.startsWith(base + sep)) {
          throw new PhoneDockError('Archive contains an escaping symlink', 'unsafe_archive', 502, undefined, `Symlink ${relative(base, full)} -> ${target}`);
        }
      } else if (st.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(base);
}

/** Extract a tarball into targetDir after rejecting absolute paths, `..` traversal, and escaping symlinks. */
export async function safeExtractTarGz(tarballPath: string, targetDir: string): Promise<void> {
  mkdirSync(targetDir, { recursive: true });
  await inspectTarSafety(tarballPath, targetDir);
  await run('/usr/bin/tar', ['-xzf', tarballPath, '-C', targetDir, '--no-same-owner'], {
    timeoutMs: 120_000,
    failureMessage: 'Could not extract downloaded archive',
  });
  verifyExtractedSymlinks(targetDir);
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
  private pidAlive(pid: number): boolean { return (this.opts.pidAlive ?? defaultPidAlive)(pid); }
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
    return this.load().manifest.components[id];
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
    const raw = id === 'ios-tools' ? process.env.PHONEDOCK_PYMD3_PYTHON : process.env.PHONEDOCK_AXE;
    return raw !== undefined && raw !== '' ? raw : undefined;
  }

  private externalPath(id: ComponentId): string | undefined {
    if (this.opts.externalLookup) return this.opts.externalLookup(id);
    if (id === 'axe') return which('axe');
    return undefined;
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
      if (!isExecutable(binaryPath)) return undefined;
      return { marker, binaryPath };
    } catch {
      return undefined;
    }
  }

  private listReadyKeys(id: ComponentId): { marker: ReadyMarker; binaryPath: string }[] {
    const dir = this.componentDir(id);
    const out: { marker: ReadyMarker; binaryPath: string }[] = [];
    let names: string[];
    try { names = readdirSync(dir); } catch { return out; }
    for (const name of names) {
      if (name.startsWith('.')) continue;
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
      return isExecutable(rawOverride) ? { path: rawOverride, source: 'override', isPinned: true } : undefined;
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

  /** Touch `lastUsedAt` on the active managed key (at daemon startup and daily). */
  touchUsed(id: ComponentId): void {
    const resolved = this.resolveManaged(id);
    if (!resolved || resolved.source !== 'managed' || !resolved.key) return;
    const entry = this.readReady(id, resolved.key);
    if (!entry) return;
    const updated: ReadyMarker = { ...entry.marker, lastUsedAt: new Date(this.now()).toISOString() };
    try {
      atomicWriteJson(join(this.componentDir(id), resolved.key, READY_FILE), updated);
    } catch { /* best effort */ }
  }

  /** Prune sibling keys that are NOT this daemon's pin and haven't been used in 30 days, plus old orphaned staging dirs. */
  prune(id?: ComponentId): { removedKeys: string[]; removedStaging: string[] } {
    const ids = id ? [id] : [...COMPONENT_IDS];
    const removedKeys: string[] = [];
    const removedStaging: string[] = [];
    const now = this.now();

    for (const cid of ids) {
      const dir = this.componentDir(cid);
      let pinned: string | undefined;
      try { pinned = this.pinnedKey(cid)?.key; } catch { pinned = undefined; }
      let names: string[];
      try { names = readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (name.startsWith('.')) continue;
        if (pinned && name === pinned) continue; // never prune this daemon's pin
        const keyDir = join(dir, name);
        const markerFile = join(keyDir, READY_FILE);
        if (!existsSync(markerFile)) continue; // don't touch in-progress or foreign dirs without a marker
        try {
          const marker = JSON.parse(readFileSync(markerFile, 'utf8')) as Partial<ReadyMarker>;
          const lastUsed = Date.parse(marker.lastUsedAt ?? marker.activatedAt ?? '');
          if (Number.isFinite(lastUsed) && now - lastUsed > PRUNE_UNUSED_MS) {
            rmSync(keyDir, { recursive: true, force: true });
            removedKeys.push(`${cid}/${name}`);
          }
        } catch { /* ignore unreadable marker */ }
      }

      // Clean up abandoned .staging entries only when no lock is held.
      const lockDir = join(dir, LOCK_DIR_NAME);
      const stagingRoot = join(dir, STAGING_DIR_NAME);
      if (!existsSync(lockDir) && existsSync(stagingRoot)) {
        try {
          for (const entry of readdirSync(stagingRoot)) {
            const p = join(stagingRoot, entry);
            const st = statSync(p);
            if (now - st.mtimeMs > STAGING_ORPHAN_MS) {
              rmSync(p, { recursive: true, force: true });
              removedStaging.push(`${cid}/${entry}`);
            }
          }
        } catch { /* ignore */ }
      }
    }
    return { removedKeys, removedStaging };
  }

  /** Start lifecycle hooks: touch active keys, prune stale unused keys, and repeat daily. */
  startLifecycle(): void {
    for (const id of COMPONENT_IDS) this.touchUsed(id);
    this.prune();
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = setInterval(() => {
      for (const id of COMPONENT_IDS) this.touchUsed(id);
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
    const managed = this.resolveManaged(id);
    const external = !managed ? this.externalPath(id) : undefined;

    let source: ComponentSource = 'none';
    let installedVersion: string | undefined;
    let sizeBytes: number | undefined;
    let updateAvailable = false;

    if (managed) {
      source = managed.source;
      installedVersion = managed.source === 'override' ? undefined : managed.version;
      if (managed.source === 'managed' && managed.key) {
        sizeBytes = this.readReady(id, managed.key)?.marker.sizeBytes;
        updateAvailable = Boolean(pin && managed.key !== pin.key);
      }
    } else if (external) {
      source = 'external';
      updateAvailable = Boolean(pin);
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
      ...(rt.error && !rt.installing ? { error: { ...rt.error } } : {}),
      ...(rt.lastAttemptAt ? { lastAttemptAt: rt.lastAttemptAt } : {}),
      ...(rt.nextRetryAt && rt.nextRetryAt > this.now() ? { nextRetryAt: new Date(rt.nextRetryAt).toISOString() } : {}),
    };
  }

  listStatuses(): ComponentStatus[] {
    return COMPONENT_IDS.map((id) => this.status(id));
  }

  /** Whether this component is already at the daemon's pinned key (or overridden by env). */
  isCurrent(id: ComponentId): boolean {
    const resolved = this.resolveManaged(id);
    return Boolean(resolved && resolved.isPinned);
  }

  /** In-flight job id if installing. */
  activeJobId(id: ComponentId): string | undefined {
    const rt = this.runtime.get(id);
    return rt?.installing ? rt.jobId : undefined;
  }

  private emitStatus(id: ComponentId, force = false): ComponentStatus {
    const st = this.status(id);
    if (!this.opts.onChange) return st;
    const now = this.now();
    const last = this.lastEmitAt.get(id) ?? 0;
    if (force || now - last >= 350) {
      this.lastEmitAt.set(id, now);
      try { this.opts.onChange(st); } catch { /* best effort */ }
    }
    return st;
  }

  /**
   * Non-blocking automatic install trigger with dedupe and exponential backoff.
   * Respects PHONEDOCK_COMPONENTS_AUTO=0. Never throws or blocks callers.
   */
  triggerAuto(id: ComponentId, opts: { startJob?: (id: ComponentId, runFn: (onProgress: (line: string) => void, jobId: string) => Promise<ComponentStatus>) => string } = {}): boolean {
    if (!this.autoInstallEnabled()) return false;
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
      return this.emitStatus(id, true);
    }

    rt.installing = true;
    rt.jobId = opts.jobId;
    rt.error = undefined;
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

    let releaseLock: (() => void) | undefined;
    let stagingDir: string | undefined;
    let incompleteFinalDir: string | undefined;

    try {
      const acquired = await this.acquireLock(id, key, () => Boolean(this.readReady(id, key)));
      if (acquired === 'already-ready') {
        this.touchUsed(id);
        rt.installing = false;
        rt.progress = undefined;
        rt.jobId = undefined;
        rt.consecutiveFailures = 0;
        rt.nextRetryAt = undefined;
        rt.promise = undefined;
        const bin = this.readReady(id, key)!.binaryPath;
        this.opts.onActivated?.(id, bin);
        return this.emitStatus(id, true);
      }
      releaseLock = acquired.release;

      // Re-check inside the lock in case another process activated it just before we entered.
      if (this.readReady(id, key)) {
        this.touchUsed(id);
        rt.installing = false;
        rt.progress = undefined;
        rt.jobId = undefined;
        rt.consecutiveFailures = 0;
        rt.nextRetryAt = undefined;
        rt.promise = undefined;
        const bin = this.readReady(id, key)!.binaryPath;
        this.opts.onActivated?.(id, bin);
        return this.emitStatus(id, true);
      }

      const stagingRoot = join(this.componentDir(id), STAGING_DIR_NAME);
      mkdirSync(stagingRoot, { recursive: true });
      stagingDir = join(stagingRoot, `${key}-${process.pid}-${randomBytes(4).toString('hex')}`);
      mkdirSync(stagingDir, { recursive: true });

      const archivePath = join(stagingDir, artifact.filename || 'archive.tar.gz');
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

      // 3. Extract safely inside staging
      setProgress('extracting', dlWeight + 5, artifact.size, artifact.size, 'Extracting archive…', true);
      const payloadDir = join(stagingDir, 'payload');
      await safeExtractTarGz(archivePath, payloadDir);
      rmSync(archivePath, { force: true });

      const finalDir = join(this.componentDir(id), key);
      let binaryRelPath: string;

      if (spec.kind === 'python-venv') {
        // Python venvs embed absolute paths into symlinks, pyvenv.cfg and script shebangs.
        // Move the verified extracted runtime to finalDir (still invisible until .ready.json is written atomically),
        // then build and self-check the venv at its permanent path. Any failure deletes finalDir in finally.
        if (existsSync(finalDir) && !existsSync(join(finalDir, READY_FILE))) {
          rmSync(finalDir, { recursive: true, force: true });
        }
        renameSync(payloadDir, finalDir);
        incompleteFinalDir = finalDir;
        binaryRelPath = await this.buildAndVerifyPythonVenv(spec, finalDir, (phase, pct, detail) => {
          setProgress(phase, pct, artifact.size, artifact.size, detail, true);
        });
      } else {
        // Binary archives are relocatable: self-check inside staging, then atomically rename into place.
        binaryRelPath = await this.verifyBinaryArchive(spec, payloadDir, (phase, pct, detail) => {
          setProgress(phase, pct, artifact.size, artifact.size, detail, true);
        });
        if (existsSync(finalDir) && !existsSync(join(finalDir, READY_FILE))) {
          rmSync(finalDir, { recursive: true, force: true });
        }
        if (!existsSync(finalDir)) {
          renameSync(payloadDir, finalDir);
          incompleteFinalDir = finalDir;
        }
      }

      // 5. Atomic activation: write .ready.json via tmp+rename LAST so readers never see a half-built key.
      const nowIso = new Date(this.now()).toISOString();
      const marker: ReadyMarker = {
        key,
        version: spec.version,
        activatedAt: nowIso,
        lastUsedAt: nowIso,
        sizeBytes: dirSizeBytes(finalDir),
        binaryRelPath,
      };
      atomicWriteJson(join(finalDir, READY_FILE), marker);
      incompleteFinalDir = undefined;

      rt.installing = false;
      rt.progress = undefined;
      rt.jobId = undefined;
      rt.error = undefined;
      rt.consecutiveFailures = 0;
      rt.nextRetryAt = undefined;
      rt.promise = undefined;

      const activatedBin = resolve(finalDir, binaryRelPath);
      this.opts.onActivated?.(id, activatedBin);
      return this.emitStatus(id, true);
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
      rt.promise = undefined;
      rt.error = { code: pe.code, message: pe.message, ...(pe.detail ? { detail: pe.detail } : {}) };
      rt.consecutiveFailures += 1;
      const schedule = this.opts.backoffMs ?? DEFAULT_BACKOFF_MS;
      const delay = schedule[Math.min(rt.consecutiveFailures - 1, schedule.length - 1)] ?? 30_000;
      rt.nextRetryAt = this.now() + delay;
      this.emitStatus(id, true);
      throw pe;
    } finally {
      if (incompleteFinalDir) {
        try { rmSync(incompleteFinalDir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
      if (stagingDir) {
        try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
      releaseLock?.();
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
    const out = createWriteStream(destPath, { mode: 0o644 });
    let bytesDone = 0;
    const reader = res.body.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
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
          await new Promise<void>((resolveWrite, rejectWrite) => {
            const onDrain = () => { out.off('error', onError); resolveWrite(); };
            const onError = (err: Error) => { out.off('drain', onDrain); rejectWrite(err); };
            out.once('drain', onDrain);
            out.once('error', onError);
          });
        }
        onBytes(bytesDone, artifact.size);
      }
      await new Promise<void>((resolveEnd, rejectEnd) => {
        out.once('finish', resolveEnd);
        out.once('error', rejectEnd);
        out.end();
      });
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

    // Self-check (Amendment 5): AST-walk sidecars to collect every pymobiledevice3* module and import each with python -I.
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
      // Single top-level wrapper folder inside archive
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

  /** Cross-process lock using atomic mkdir with owner.json heartbeat and stale-lock recovery. */
  private async acquireLock(
    id: ComponentId,
    key: string,
    isTargetReady: () => boolean,
  ): Promise<'already-ready' | { release: () => void }> {
    const dir = this.componentDir(id);
    const lockDir = join(dir, LOCK_DIR_NAME);
    const ownerFile = join(lockDir, LOCK_OWNER_FILE);
    const staleMs = this.opts.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
    const missingGraceMs = this.opts.lockMissingGraceMs ?? DEFAULT_LOCK_MISSING_GRACE_MS;
    const heartbeatMs = this.opts.lockHeartbeatMs ?? DEFAULT_LOCK_HEARTBEAT_MS;
    const pollMs = this.opts.lockPollMs ?? DEFAULT_LOCK_POLL_MS;
    const waitTimeoutMs = this.opts.lockWaitTimeoutMs ?? 10 * 60_000;
    const deadline = this.now() + waitTimeoutMs;

    while (true) {
      if (isTargetReady()) return 'already-ready';
      try {
        mkdirSync(lockDir);
        const nowIso = new Date(this.now()).toISOString();
        const owner: LockOwner = { pid: process.pid, startedAt: nowIso, heartbeatAt: nowIso, key };
        atomicWriteJson(ownerFile, owner);
        const timer = setInterval(() => {
          try {
            if (existsSync(lockDir)) {
              atomicWriteJson(ownerFile, { ...owner, heartbeatAt: new Date(this.now()).toISOString() });
            }
          } catch { /* ignore */ }
        }, heartbeatMs);
        timer.unref();
        let released = false;
        return {
          release: () => {
            if (released) return;
            released = true;
            clearInterval(timer);
            try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* ignore */ }
          },
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }

      // Lock exists: check if stale and reclaim atomically via rename.
      let stale = false;
      try {
        if (existsSync(ownerFile)) {
          const owner = JSON.parse(readFileSync(ownerFile, 'utf8')) as Partial<LockOwner>;
          const hb = Date.parse(owner.heartbeatAt ?? owner.startedAt ?? '');
          const pidDead = typeof owner.pid === 'number' && owner.pid !== process.pid && !this.pidAlive(owner.pid);
          const timedOut = Number.isFinite(hb) && this.now() - hb > staleMs;
          if (pidDead || timedOut) stale = true;
        } else {
          const st = statSync(lockDir);
          if (this.now() - st.mtimeMs > missingGraceMs) stale = true;
        }
      } catch {
        // Lock disappeared or unreadable while checking; retry immediately.
        continue;
      }

      if (stale) {
        const trash = join(dir, `.lock.stale-${process.pid}-${randomBytes(4).toString('hex')}`);
        try {
          renameSync(lockDir, trash);
          rmSync(trash, { recursive: true, force: true });
          continue;
        } catch {
          // Another process raced us to reclaim or released it; loop and retry.
        }
      }

      if (this.now() >= deadline) {
        throw new PhoneDockError(
          `Timed out waiting for another ${this.spec(id).displayName} install to finish`,
          'lock_timeout',
          504,
        );
      }
      await sleep(pollMs);
    }
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

/** Resolve AXe binary using the standard 4-step lookup order (override -> pinned -> newest managed -> PATH). */
export function resolveAxeBinary(manager: ComponentManager = getComponentManager()): string | undefined {
  const env = process.env.PHONEDOCK_AXE;
  if (env !== undefined && env !== '') return isExecutable(env) ? env : undefined;
  const managed = manager.resolveManaged('axe');
  if (managed) return managed.path;
  return which('axe');
}
