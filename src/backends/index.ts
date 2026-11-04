// Backend registry. Each module exports `backend: Backend`. Modules that fail to load are reported,
// not fatal, so one broken backend never takes the daemon down. Add new backends to MODULES.
import type { Backend } from '../core/types.ts';

// Literal import() calls so esbuild can bundle them.
const MODULES: [string, () => Promise<{ backend?: Backend }>][] = [
  ['android-emulator', () => import('./android-emulator.ts')],
  ['android-device', () => import('./android-device.ts')],
  ['ios-simulator', () => import('./ios-simulator.ts')],
  ['ios-device', () => import('./ios-device.ts')],
  ['qemu', () => import('./qemu.ts')],
  ['corellium', () => import('./corellium.ts')],
];

export interface LoadedBackends { backends: Backend[]; failures: { module: string; error: string }[] }

export async function loadBackends(): Promise<LoadedBackends> {
  const backends: Backend[] = []; const failures: { module: string; error: string }[] = [];
  for (const [m, load] of MODULES) {
    try {
      const mod = await load();
      if (mod.backend) backends.push(mod.backend as Backend);
      else failures.push({ module: m, error: 'module has no `backend` export' });
    } catch (e) { failures.push({ module: m, error: (e as Error).message }); }
  }
  return { backends, failures };
}
