#!/usr/bin/env node
// Bundles the daemon and CLI into self-contained ESM files for the macOS app bundle:
//   dist/bundle/daemon/phonedockd.mjs   (from src/daemon/main.ts)
//   dist/bundle/cli/phonedock.mjs       (from src/cli/main.ts)
// Entries that don't exist yet are skipped (so this is safe to run at any stage of development).
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outRoot = join(root, 'dist', 'bundle');

let esbuild;
try { esbuild = await import('esbuild'); }
catch { console.error('bundle: esbuild is not installed (npm install)'); process.exit(1); }

const banner = [
  "import { createRequire as __pdCreateRequire } from 'node:module';",
  "import { fileURLToPath as __pdFileURLToPath } from 'node:url';",
  "import { dirname as __pdDirname } from 'node:path';",
  'const require = __pdCreateRequire(import.meta.url);',
  'const __filename = __pdFileURLToPath(import.meta.url);',
  'const __dirname = __pdDirname(__filename);',
].join('\n');

const entries = [
  { src: 'src/daemon/main.ts', out: 'daemon/phonedockd.mjs' },
  { src: 'src/cli/main.ts', out: 'cli/phonedock.mjs' },
];

// Backends are loaded via literal dynamic import()s; a backend file that doesn't exist yet becomes a stub
// module that throws when imported, so the registry reports it as a load failure instead of breaking the build.
const missingStub = {
  name: 'phonedock-missing-modules',
  setup(build) {
    build.onResolve({ filter: /^\.\.?\// }, (args) => {
      if (!args.importer || args.namespace !== 'file' || args.importer.includes('/node_modules/')) return undefined;
      const p = resolve(dirname(args.importer), args.path);
      if (existsSync(p)) return undefined;
      console.warn(`bundle: warning: ${args.path} (from ${args.importer.replace(root + '/', '')}) not found; stubbing`);
      return { path: p, namespace: 'pd-missing' };
    });
    build.onLoad({ filter: /.*/, namespace: 'pd-missing' }, (args) => ({
      contents: `throw new Error(${JSON.stringify('module not available in this build: ' + args.path.replace(root + '/', ''))});`,
      loader: 'js',
    }));
  },
};

let built = 0;
for (const e of entries) {
  const src = join(root, e.src);
  if (!existsSync(src)) { console.log(`bundle: skip ${e.src} (not found)`); continue; }
  const outfile = join(outRoot, e.out);
  mkdirSync(dirname(outfile), { recursive: true });
  await esbuild.build({
    entryPoints: [src],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    banner: { js: banner },
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
    plugins: [missingStub],
    define: { 'process.env.PHONEDOCK_BUNDLED': '"1"' },
  });
  console.log(`bundle: ${e.src} -> ${outfile}`);
  built++;
}
console.log(`bundle: ${built} bundle(s) written to ${outRoot}`);
