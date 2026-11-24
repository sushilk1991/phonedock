// Manifest and lock validation for managed components (tools/components.json + tools/ios-tools.lock).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PhoneDockError, type ComponentId } from './types.ts';

export const COMPONENT_IDS: readonly ComponentId[] = ['ios-tools', 'axe'];

export interface ComponentArtifact {
  platforms: string[];
  filename: string;
  url: string;
  sha256: string;
  size: number;
}

export interface RecentException {
  package: string;
  version: string;
  publishedAt: string;
  reason: string;
}

export interface ComponentSpec {
  id: ComponentId;
  displayName: string;
  description: string;
  kind: 'python-venv' | 'binary-archive';
  version: string;
  publishedAt: string;
  pythonVersion?: string;
  pythonRelease?: string;
  pythonPublishedAt?: string;
  lockFile?: string;
  lockSha256?: string;
  excludeNewerCutoff?: string;
  recentExceptions?: RecentException[];
  recentOverrideReason?: string;
  estimatedDiskBytes: number;
  artifacts: ComponentArtifact[];
  verify: {
    package?: string;
    version?: string;
    sidecars?: string[];
    binary?: string;
    versionArgs?: string[];
    expectedVersion?: string;
  };
}

export interface ComponentManifest {
  schemaVersion: number;
  minAgeDays: number;
  allowedHosts: string[];
  components: Record<ComponentId, ComponentSpec>;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function isComponentId(id: string): id is ComponentId {
  return id === 'ios-tools' || id === 'axe';
}

export function currentPlatformKey(platform = process.platform, arch = process.arch): string {
  return `${platform}-${arch}`;
}

/** Locate the tools directory across dev checkouts, bundled PhoneDock.app, and test overrides. */
export function resolveToolsDir(explicit?: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const cands = [
    explicit,
    process.env.PHONEDOCK_TOOLS_DIR,
    process.env.PHONEDOCK_BUNDLE_RESOURCES ? join(process.env.PHONEDOCK_BUNDLE_RESOURCES, 'tools') : undefined,
    resolve(here, '..', '..', 'tools'), // dev: src/core/ -> tools/
    resolve(here, '..', 'tools'),       // bundle: Resources/{daemon,tools}
    resolve(process.cwd(), 'tools'),
  ];
  const found = cands.find((c) => c && existsSync(join(c, 'components.json')));
  if (!found) {
    throw new PhoneDockError(
      'Component manifest not found',
      'manifest_missing',
      500,
      ['Reinstall PhoneDock: tools/components.json is missing.'],
      `Searched: ${cands.filter(Boolean).join(', ')}`,
    );
  }
  return found;
}

/** Validate a URL against the manifest allowlist (HTTPS only; localhost HTTP allowed only in test mode). */
export function assertAllowedUrl(rawUrl: string, allowedHosts: readonly string[], allowLocalhost = false): URL {
  let u: URL;
  try { u = new URL(rawUrl); } catch {
    throw new PhoneDockError('Invalid component download URL', 'invalid_manifest', 500, undefined, `Malformed URL: ${rawUrl}`);
  }
  if (allowLocalhost && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && (u.protocol === 'http:' || u.protocol === 'https:')) {
    return u;
  }
  if (u.protocol !== 'https:') {
    throw new PhoneDockError('Component download must use HTTPS', 'invalid_manifest', 500, undefined, `Rejected non-HTTPS URL: ${rawUrl}`);
  }
  if (!allowedHosts.includes(u.hostname)) {
    throw new PhoneDockError('Component download host is not allowed', 'invalid_manifest', 500, undefined, `Host ${u.hostname} not in allowlist: ${allowedHosts.join(', ')}`);
  }
  return u;
}

/** Validate that every requirement entry in a pip hash lock carries at least one sha256 hash. */
export function validateLockContent(lockText: string): { packageCount: number } {
  const lines = lockText.split(/\r?\n/);
  let packageCount = 0;
  let inEntry = false;
  let entryHasHash = false;
  let entryName = '';

  const finishEntry = () => {
    if (!inEntry) return;
    if (!entryHasHash) {
      throw new PhoneDockError('Component lock file is missing package hashes', 'invalid_lock', 500, undefined, `Requirement ${entryName} has no --hash=sha256: entry`);
    }
    inEntry = false;
    entryHasHash = false;
    entryName = '';
  };

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      if (!raw.startsWith(' ') && !raw.startsWith('\t')) finishEntry();
      continue;
    }
    if (/^--hash=sha256:[0-9a-f]{64}\s*\\?$/i.test(trimmed)) {
      if (!inEntry) {
        throw new PhoneDockError('Malformed component lock file', 'invalid_lock', 500, undefined, `Orphan hash line: ${trimmed}`);
      }
      entryHasHash = true;
      continue;
    }
    if (trimmed.startsWith('-')) {
      throw new PhoneDockError('Unsupported directive in component lock file', 'invalid_lock', 500, undefined, `Rejected lock option: ${trimmed}`);
    }
    finishEntry();
    const m = /^([A-Za-z0-9_.-]+)==([^\s\\;]+)/.exec(trimmed);
    if (!m) {
      throw new PhoneDockError('Malformed requirement in component lock file', 'invalid_lock', 500, undefined, `Unpinned or invalid line: ${trimmed}`);
    }
    packageCount++;
    inEntry = true;
    entryHasHash = false;
    entryName = `${m[1]}==${m[2]}`;
  }
  finishEntry();
  if (packageCount === 0) {
    throw new PhoneDockError('Component lock file is empty', 'invalid_lock', 500);
  }
  return { packageCount };
}

export function validateManifest(
  raw: unknown,
  toolsDir: string,
  opts: { allowLocalhost?: boolean } = {},
): ComponentManifest {
  if (!raw || typeof raw !== 'object') {
    throw new PhoneDockError('Invalid component manifest', 'invalid_manifest', 500, undefined, 'Manifest root must be a JSON object');
  }
  const m = raw as Record<string, unknown>;
  if (m.schemaVersion !== 1) {
    throw new PhoneDockError('Unsupported component manifest version', 'invalid_manifest', 500, undefined, `Expected schemaVersion 1, got ${String(m.schemaVersion)}`);
  }
  if (!Array.isArray(m.allowedHosts) || m.allowedHosts.length === 0 || !m.allowedHosts.every((h) => typeof h === 'string' && h.length > 0)) {
    throw new PhoneDockError('Invalid component manifest allowlist', 'invalid_manifest', 500);
  }
  const allowedHosts = m.allowedHosts as string[];
  const comps = m.components as Record<string, unknown> | undefined;
  if (!comps || typeof comps !== 'object') {
    throw new PhoneDockError('Invalid component manifest', 'invalid_manifest', 500, undefined, 'Missing components object');
  }

  for (const id of COMPONENT_IDS) {
    const c = comps[id] as ComponentSpec | undefined;
    if (!c || typeof c !== 'object' || c.id !== id) {
      throw new PhoneDockError(`Missing component "${id}" in manifest`, 'invalid_manifest', 500);
    }
    if (typeof c.version !== 'string' || !c.version.trim()) {
      throw new PhoneDockError(`Invalid version for component "${id}"`, 'invalid_manifest', 500);
    }
    if (c.kind !== 'python-venv' && c.kind !== 'binary-archive') {
      throw new PhoneDockError(`Invalid kind for component "${id}"`, 'invalid_manifest', 500);
    }
    if (!Array.isArray(c.artifacts) || c.artifacts.length === 0) {
      throw new PhoneDockError(`Component "${id}" has no artifacts`, 'invalid_manifest', 500);
    }
    for (const a of c.artifacts) {
      if (!a || !Array.isArray(a.platforms) || a.platforms.length === 0) {
        throw new PhoneDockError(`Artifact for "${id}" is missing platforms`, 'invalid_manifest', 500);
      }
      assertAllowedUrl(a.url, allowedHosts, opts.allowLocalhost);
      if (typeof a.sha256 !== 'string' || !SHA256_RE.test(a.sha256)) {
        throw new PhoneDockError(`Artifact for "${id}" has invalid sha256`, 'invalid_manifest', 500);
      }
      if (typeof a.size !== 'number' || !Number.isInteger(a.size) || a.size <= 0) {
        throw new PhoneDockError(`Artifact for "${id}" has invalid size`, 'invalid_manifest', 500);
      }
    }
    if (c.kind === 'python-venv') {
      if (!c.lockFile || !c.lockSha256 || !SHA256_RE.test(c.lockSha256)) {
        throw new PhoneDockError(`Component "${id}" is missing lockFile or lockSha256`, 'invalid_manifest', 500);
      }
      const lockPath = join(toolsDir, c.lockFile);
      if (!existsSync(lockPath)) {
        throw new PhoneDockError(`Lock file missing for "${id}"`, 'invalid_lock', 500, undefined, `Not found: ${lockPath}`);
      }
      const lockBuf = readFileSync(lockPath);
      const actualSha = sha256Hex(lockBuf);
      if (actualSha !== c.lockSha256) {
        throw new PhoneDockError(`Lock file hash mismatch for "${id}"`, 'invalid_lock', 500, undefined, `Expected ${c.lockSha256}, got ${actualSha}`);
      }
      validateLockContent(lockBuf.toString('utf8'));
    }
  }
  return raw as ComponentManifest;
}

export function loadManifest(toolsDir?: string, opts: { allowLocalhost?: boolean } = {}): { manifest: ComponentManifest; toolsDir: string } {
  const dir = resolveToolsDir(toolsDir);
  const file = join(dir, 'components.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new PhoneDockError('Could not parse tools/components.json', 'invalid_manifest', 500, undefined, (e as Error).message);
  }
  return { manifest: validateManifest(parsed, dir, opts), toolsDir: dir };
}

export function selectArtifact(spec: ComponentSpec, platformKey = currentPlatformKey()): ComponentArtifact | undefined {
  return spec.artifacts.find((a) => a.platforms.includes(platformKey));
}

/** Deterministic directory key derived from pinned version, platform artifact hash, and (for Python) lock hash. */
export function componentKey(spec: ComponentSpec, artifact: ComponentArtifact): string {
  const safeVer = spec.version.replace(/[^A-Za-z0-9._-]+/g, '_');
  if (spec.kind === 'python-venv') {
    const pyVer = (spec.pythonVersion ?? '3.12').replace(/[^A-Za-z0-9._-]+/g, '_');
    const hash = sha256Hex(`${artifact.sha256}:${spec.lockSha256 ?? ''}`).slice(0, 12);
    return `${safeVer}-py${pyVer}-${hash}`;
  }
  return `${safeVer}-${artifact.sha256.slice(0, 12)}`;
}
