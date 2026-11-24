// Managed component routes: GET /v1/components, POST /v1/components/:id/install
import {
  ComponentManager, getComponentManager, isComponentId, setComponentManager,
} from '../core/components.ts';
import { which } from '../core/paths.ts';
import { PhoneDockError, type ComponentId } from '../core/types.ts';
import { externalPymd3Python, invalidatePymd3PythonCache } from '../backends/pymd3-python.ts';
import { emit, getJob, invalidateDevices, startJob } from './core.ts';
import { Raw, type Handler } from './http.ts';
import { invalidateBackendsCache, router } from './routes.ts';

function startComponentJob(manager: ComponentManager, id: ComponentId, reason: 'auto' | 'manual') {
  const existingJobId = manager.activeJobId(id);
  if (existingJobId) {
    try {
      return { job: getJob(existingJobId), component: manager.status(id) };
    } catch { /* job pruned from ring buffer; start a fresh tracker bound to the same in-flight promise */ }
  }
  const job = startJob(
    'install-component',
    async (progress, j) => manager.install(id, { reason, jobId: j.id, onProgress: progress }),
    `component:${id}`,
  );
  return { job, component: manager.status(id) };
}

/** Configure the daemon's shared ComponentManager (events, cache invalidation, daily pruning). */
export function initComponents(customManager?: ComponentManager): ComponentManager {
  const mgr = customManager ?? new ComponentManager({
    externalLookup(id) {
      if (id === 'ios-tools') return externalPymd3Python();
      if (id === 'axe') return which('axe');
      return undefined;   // wda: only the pinned copy (or PHONEDOCK_WDA_SOURCE), never a checkout found on disk
    },
    onChange(status) {
      emit('component', status);
      invalidateBackendsCache();
    },
    onActivated(id) {
      if (id === 'ios-tools') invalidatePymd3PythonCache();
      invalidateBackendsCache();
      invalidateDevices();
    },
    startAutoJob(id, runFn) {
      const job = startJob('install-component', (progress, j) => runFn(progress, j.id), `component:${id}`);
      return job.id;
    },
  });
  setComponentManager(mgr);
  mgr.startLifecycle();
  return mgr;
}

export function stopComponents(): void {
  try { getComponentManager().stopLifecycle(); } catch { /* ignore */ }
}

/** Dependency-injected handlers for router integration tests. */
export function componentHandlers(getMgr: () => ComponentManager = getComponentManager): { list: Handler; install: Handler } {
  return {
    list: () => getMgr().listStatuses(),
    install: async (c) => {
      const id = c.params.id;
      if (!isComponentId(id)) {
        throw new PhoneDockError(`Unknown component "${id}"`, 'not_found', 404, ['Valid components: ios-tools, axe.']);
      }
      const mgr = getMgr();
      const { job, component } = startComponentJob(mgr, id, 'manual');
      return new Raw(202, JSON.stringify({ job, component }), { 'Content-Type': 'application/json' });
    },
  };
}

const handlers = componentHandlers();
router.get('/v1/components', handlers.list);
router.post('/v1/components/:id/install', handlers.install);
