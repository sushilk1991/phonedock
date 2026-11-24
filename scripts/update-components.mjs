#!/usr/bin/env node
// Re-pin PhoneDock managed components (tools/components.json + tools/ios-tools.lock).
// Enforces the >=14-day release age policy across the whole lock unless --allow-recent "<reason>" is supplied.
//
// Examples:
//   node scripts/update-components.mjs --check
//   node scripts/update-components.mjs --axe 1.8.0
//   node scripts/update-components.mjs --pymd3 11.63.1 --python-release 20261026 --python-version 3.12.16 \
//     --allow-recent "Only version verified on iOS 27.2.1 hardware (UI tree and live video over Wi-Fi)" \
//     --allow-recent-pkg ansilogs,apple-symbols,ipsw-parser,pycrashreport
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = join(ROOT, 'tools', 'components.json');
const LOCK_PATH = join(ROOT, 'tools', 'ios-tools.lock');
const DAY_MS = 86_400_000;

function parseArgs(argv) {
  const opts = {
    minAgeDays: 14,
    allowRecentPkgs: [],
    check: false,
    offline: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${a}`);
      return argv[++i];
    };
    switch (a) {
      case '--check': opts.check = true; break;
      case '--offline': opts.offline = true; break;
      case '--pymd3': opts.pymd3 = next(); break;
      case '--python-release': opts.pythonRelease = next(); break;
      case '--python-version': opts.pythonVersion = next(); break;
      case '--axe': opts.axe = next(); break;
      case '--min-age-days': opts.minAgeDays = Number(next()); break;
      case '--cutoff': opts.cutoff = next(); break;
      case '--allow-recent': opts.allowRecent = next(); break;
      case '--allow-recent-pkg':
        for (const p of next().split(',').map((s) => s.trim()).filter(Boolean)) opts.allowRecentPkgs.push(p);
        break;
      case '-h':
      case '--help':
        console.log([
          'Usage: node scripts/update-components.mjs [options]',
          '  --check                      Validate tools/components.json and tools/ios-tools.lock',
          '  --offline                    With --check, skip PyPI network verification',
          '  --pymd3 <ver>                Pin pymobiledevice3 version (recompiles tools/ios-tools.lock)',
          '  --python-release <tag>       Pin python-build-standalone release tag (e.g. 20261026)',
          '  --python-version <ver>       Pin CPython version (e.g. 3.12.16)',
          '  --axe <ver>                  Pin AXe release version without leading v (e.g. 1.8.0)',
          '  --min-age-days <n>           Minimum release age in days (default: 14)',
          '  --cutoff <iso>               Explicit exclude-newer ISO timestamp',
          '  --allow-recent "<reason>"    Allow a release newer than min-age-days with a recorded reason',
          '  --allow-recent-pkg <p1,p2>   Additional transitive packages allowed newer than cutoff',
        ].join('\n'));
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${a}`);
    }
  }
  return opts;
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function normalizePkg(name) {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'PhoneDock-update-components/1.0', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'PhoneDock-update-components/1.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

async function fetchGitHubRelease(repo, tag) {
  const headers = { 'User-Agent': 'PhoneDock-update-components/1.0', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { headers });
  if (res.ok) return res.json();
  // Fallback to gh CLI if unauthenticated rate limit hit
  try {
    const out = execFileSync('gh', ['api', `repos/${repo}/releases/tags/${tag}`], { encoding: 'utf8' });
    return JSON.parse(out);
  } catch {
    throw new Error(`HTTP ${res.status} fetching GitHub release ${repo}@${tag}`);
  }
}

async function pypiReleasePublishedAt(pkg, version) {
  const data = await fetchJson(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/${encodeURIComponent(version)}/json`);
  const times = (data.urls ?? [])
    .map((u) => u.upload_time_iso_8601)
    .filter((t) => typeof t === 'string')
    .sort();
  if (!times.length) throw new Error(`No upload timestamps on PyPI for ${pkg}==${version}`);
  // Use the latest wheel/file upload time for this release so the age check is conservative.
  return times[times.length - 1];
}

function parseLockedPackages(lockText) {
  const pkgs = [];
  for (const line of lockText.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_.-]+)==([^\s\\;]+)/.exec(line);
    if (m) pkgs.push({ name: m[1], normalized: normalizePkg(m[1]), version: m[2] });
  }
  return pkgs;
}

function checkAge(label, publishedAtIso, cutoffIso, allowRecentReason) {
  const pubMs = Date.parse(publishedAtIso);
  const cutMs = Date.parse(cutoffIso);
  if (!Number.isFinite(pubMs)) throw new Error(`Invalid publishedAt for ${label}: ${publishedAtIso}`);
  if (pubMs > cutMs && !allowRecentReason) {
    throw new Error(
      `${label} was published ${publishedAtIso}, which is newer than cutoff ${cutoffIso}. ` +
      'Pass --allow-recent "<reason>" to record an explicit exception.',
    );
  }
}

async function verifyLockAges(lockText, cutoffIso, exceptionsByPkg) {
  const pkgs = parseLockedPackages(lockText);
  const cutMs = Date.parse(cutoffIso);
  const violations = [];
  const concurrency = 8;
  let idx = 0;

  async function worker() {
    while (idx < pkgs.length) {
      const p = pkgs[idx++];
      const publishedAt = await pypiReleasePublishedAt(p.name, p.version);
      const pubMs = Date.parse(publishedAt);
      if (pubMs > cutMs) {
        const exc = exceptionsByPkg.get(p.normalized);
        if (!exc) {
          violations.push(`${p.name}==${p.version} (published ${publishedAt} > cutoff ${cutoffIso})`);
        } else {
          exc.version = p.version;
          exc.publishedAt = publishedAt;
        }
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (violations.length) {
    throw new Error(
      `Locked package(s) newer than ${cutoffIso} without a recorded exception:\n  - ${violations.join('\n  - ')}`,
    );
  }
  return pkgs.length;
}

async function resolveAxe(version, cutoffIso, allowRecent) {
  const tag = version.startsWith('v') ? version : `v${version}`;
  const cleanVer = tag.replace(/^v/, '');
  const rel = await fetchGitHubRelease('cameroncooke/AXe', tag);
  const publishedAt = rel.published_at;
  checkAge(`AXe ${cleanVer}`, publishedAt, cutoffIso, allowRecent);
  const assetName = `AXe-macOS-v${cleanVer}-universal.tar.gz`;
  const asset = (rel.assets ?? []).find((a) => a.name === assetName);
  if (!asset) throw new Error(`Asset ${assetName} not found in cameroncooke/AXe@${tag}`);
  let digest = typeof asset.digest === 'string' ? asset.digest.replace(/^sha256:/, '') : '';
  if (!/^[0-9a-f]{64}$/i.test(digest)) {
    const res = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'PhoneDock-update-components/1.0' } });
    if (!res.ok) throw new Error(`Failed to download ${asset.browser_download_url}: HTTP ${res.status}`);
    digest = sha256(Buffer.from(await res.arrayBuffer()));
  }
  return {
    id: 'axe',
    displayName: 'Simulator Control',
    description: 'AXe CLI for iOS simulator input, accessibility tree, and video streaming.',
    kind: 'binary-archive',
    version: cleanVer,
    publishedAt,
    ...(Date.parse(publishedAt) > Date.parse(cutoffIso) && allowRecent ? { recentOverrideReason: allowRecent } : {}),
    estimatedDiskBytes: Math.round(asset.size * 2),
    artifacts: [
      {
        platforms: ['darwin-arm64', 'darwin-x64'],
        filename: assetName,
        url: asset.browser_download_url,
        sha256: digest.toLowerCase(),
        size: asset.size,
      },
    ],
    verify: {
      binary: 'axe',
      versionArgs: ['--version'],
      expectedVersion: cleanVer,
    },
  };
}

async function resolvePythonArtifact(pythonRelease, pythonVersion, cutoffIso, allowRecent) {
  const rel = await fetchGitHubRelease('astral-sh/python-build-standalone', pythonRelease);
  const publishedAt = rel.published_at;
  checkAge(`python-build-standalone ${pythonRelease}`, publishedAt, cutoffIso, allowRecent);
  const filename = `cpython-${pythonVersion}+${pythonRelease}-aarch64-apple-darwin-install_only_stripped.tar.gz`;
  const asset = (rel.assets ?? []).find((a) => a.name === filename);
  if (!asset) throw new Error(`Asset ${filename} not found in python-build-standalone@${pythonRelease}`);
  const sumsAsset = (rel.assets ?? []).find((a) => a.name === 'SHA256SUMS');
  let digest = '';
  if (sumsAsset) {
    const sumsText = await fetchText(sumsAsset.browser_download_url);
    for (const line of sumsText.split(/\r?\n/)) {
      const m = /^([0-9a-f]{64})\s+(.+)$/i.exec(line.trim());
      if (m && m[2].trim() === filename) {
        digest = m[1].toLowerCase();
        break;
      }
    }
  }
  if (!digest && typeof asset.digest === 'string') {
    digest = asset.digest.replace(/^sha256:/, '').toLowerCase();
  }
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`Could not determine sha256 for ${filename}`);
  return {
    publishedAt,
    artifact: {
      platforms: ['darwin-arm64'],
      filename,
      url: asset.browser_download_url,
      sha256: digest,
      size: asset.size,
    },
  };
}

async function compileIosToolsLock(pymd3Version, cutoffIso, allowRecent, allowRecentPkgs) {
  const pymd3PublishedAt = await pypiReleasePublishedAt('pymobiledevice3', pymd3Version);
  const pymd3IsRecent = Date.parse(pymd3PublishedAt) > Date.parse(cutoffIso);
  if (pymd3IsRecent && !allowRecent) {
    throw new Error(
      `pymobiledevice3==${pymd3Version} was published ${pymd3PublishedAt} (newer than cutoff ${cutoffIso}). ` +
      'Pass --allow-recent "<reason>" to pin it.',
    );
  }
  if (allowRecentPkgs.length && !allowRecent) {
    throw new Error('--allow-recent-pkg requires --allow-recent "<reason>"');
  }

  const pyMinor = '3.12';
  const overrideCut = new Date(Date.now() + 60_000).toISOString();
  const args = [
    'pip', 'compile', '-',
    '--universal',
    '--python-version', pyMinor,
    '--generate-hashes',
    '--only-binary', ':all:',
    '--no-header',
    '--exclude-newer', cutoffIso,
  ];

  const exceptionsByPkg = new Map();
  if (pymd3IsRecent) {
    const plusOne = new Date(Date.parse(pymd3PublishedAt) + 2000).toISOString();
    args.push('--exclude-newer-package', `pymobiledevice3=${plusOne}`);
    exceptionsByPkg.set('pymobiledevice3', {
      package: 'pymobiledevice3',
      version: pymd3Version,
      publishedAt: pymd3PublishedAt,
      reason: allowRecent,
    });
  }
  for (const raw of allowRecentPkgs) {
    const [pkgPart, customReason] = raw.split('=', 2);
    const norm = normalizePkg(pkgPart);
    if (norm === 'pymobiledevice3') continue;
    args.push('--exclude-newer-package', `${pkgPart}=${overrideCut}`);
    exceptionsByPkg.set(norm, {
      package: pkgPart,
      version: '',
      publishedAt: '',
      reason: customReason || `Required dependency of pymobiledevice3 ${pymd3Version}: ${allowRecent}`,
    });
  }

  const lockText = execFileSync('uv', args, {
    input: `pymobiledevice3==${pymd3Version}\n`,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });

  // Verify every locked package against PyPI upload timestamps so nothing slips past the cutoff unrecorded.
  const count = await verifyLockAges(lockText, cutoffIso, exceptionsByPkg);
  const recentExceptions = [...exceptionsByPkg.values()]
    .filter((e) => e.publishedAt && Date.parse(e.publishedAt) > Date.parse(cutoffIso))
    .sort((a, b) => (a.package === 'pymobiledevice3' ? -1 : b.package === 'pymobiledevice3' ? 1 : a.package.localeCompare(b.package)));

  return {
    lockText,
    lockSha256: sha256(Buffer.from(lockText, 'utf8')),
    packageCount: count,
    pymd3PublishedAt,
    recentExceptions,
  };
}

async function runCheck(opts) {
  if (!existsSync(MANIFEST_PATH)) throw new Error(`Missing ${MANIFEST_PATH}`);
  if (!existsSync(LOCK_PATH)) throw new Error(`Missing ${LOCK_PATH}`);
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const lockText = readFileSync(LOCK_PATH, 'utf8');
  const ios = manifest.components?.['ios-tools'];
  const axe = manifest.components?.axe;
  if (!ios || !axe) throw new Error('Manifest must define ios-tools and axe');

  const actualLockSha = sha256(Buffer.from(lockText, 'utf8'));
  if (ios.lockSha256 !== actualLockSha) {
    throw new Error(`lockSha256 mismatch: manifest has ${ios.lockSha256}, tools/ios-tools.lock has ${actualLockSha}`);
  }
  const cutoff = ios.excludeNewerCutoff;
  if (!cutoff || !Number.isFinite(Date.parse(cutoff))) {
    throw new Error('ios-tools missing valid excludeNewerCutoff');
  }
  const excMap = new Map();
  for (const e of ios.recentExceptions ?? []) {
    if (!e.package || !e.reason) throw new Error(`Invalid recentException entry: ${JSON.stringify(e)}`);
    excMap.set(normalizePkg(e.package), { ...e });
  }
  if (!opts.offline) {
    const count = await verifyLockAges(lockText, cutoff, excMap);
    console.log(`check ok: ${count} locked packages verified against cutoff ${cutoff} (${excMap.size} recorded exception(s))`);
  } else {
    const count = parseLockedPackages(lockText).length;
    console.log(`check ok (offline): ${count} locked packages, lock sha256 matches`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.check) {
    await runCheck(opts);
    return;
  }

  const existing = existsSync(MANIFEST_PATH) ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) : {
    schemaVersion: 1,
    minAgeDays: opts.minAgeDays,
    allowedHosts: [
      'github.com',
      'objects.githubusercontent.com',
      'release-assets.githubusercontent.com',
      'files.pythonhosted.org',
      'pypi.org',
    ],
    components: {},
  };

  const cutoffIso = opts.cutoff ?? new Date(Date.now() - opts.minAgeDays * DAY_MS).toISOString().replace(/\.\d+Z$/, 'Z');
  const existingIos = existing.components?.['ios-tools'];
  const existingAxe = existing.components?.axe;

  const updateIos = Boolean(opts.pymd3 || opts.pythonRelease || opts.pythonVersion || !existingIos);
  const updateAxe = Boolean(opts.axe || !existingAxe);

  if (updateIos) {
    const pymd3Ver = opts.pymd3 ?? existingIos?.version ?? '11.63.1';
    const pyRel = opts.pythonRelease ?? existingIos?.pythonRelease ?? '20261026';
    const pyVer = opts.pythonVersion ?? existingIos?.pythonVersion ?? '3.12.16';
    console.log(`Resolving ios-tools (pymobiledevice3==${pymd3Ver}, Python ${pyVer}+${pyRel}, cutoff ${cutoffIso})…`);
    const [pyArt, lock] = await Promise.all([
      resolvePythonArtifact(pyRel, pyVer, cutoffIso, opts.allowRecent),
      compileIosToolsLock(pymd3Ver, cutoffIso, opts.allowRecent, opts.allowRecentPkgs),
    ]);
    writeFileSync(LOCK_PATH, lock.lockText, 'utf8');
    existing.components['ios-tools'] = {
      id: 'ios-tools',
      displayName: 'iPhone Control',
      description: 'Python 3.12 runtime and pymobiledevice3 for iOS 27+ touch, keyboard, UI tree, and live video.',
      kind: 'python-venv',
      version: pymd3Ver,
      publishedAt: lock.pymd3PublishedAt,
      pythonVersion: pyVer,
      pythonRelease: pyRel,
      pythonPublishedAt: pyArt.publishedAt,
      lockFile: 'ios-tools.lock',
      lockSha256: lock.lockSha256,
      excludeNewerCutoff: cutoffIso,
      recentExceptions: lock.recentExceptions,
      estimatedDiskBytes: 277_000_000,
      artifacts: [pyArt.artifact],
      verify: {
        package: 'pymobiledevice3',
        version: pymd3Ver,
        sidecars: ['pd-ios-hid.py', 'pd-ios-native.py'],
      },
    };
    console.log(`  ios-tools: ${lock.packageCount} packages locked, sha256=${lock.lockSha256.slice(0, 12)}, ${lock.recentExceptions.length} recent exception(s)`);
  }

  if (updateAxe) {
    const axeVer = opts.axe ?? existingAxe?.version ?? '1.8.0';
    console.log(`Resolving axe (${axeVer}, cutoff ${cutoffIso})…`);
    existing.components.axe = await resolveAxe(axeVer, cutoffIso, opts.allowRecent);
    console.log(`  axe: v${existing.components.axe.version}, size=${existing.components.axe.artifacts[0].size}, sha256=${existing.components.axe.artifacts[0].sha256.slice(0, 12)}`);
  }

  existing.schemaVersion = 1;
  existing.minAgeDays = opts.minAgeDays;
  writeFileSync(MANIFEST_PATH, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${MANIFEST_PATH}`);
}

main().catch((err) => {
  console.error(`update-components: ${err.message}`);
  process.exit(1);
});
