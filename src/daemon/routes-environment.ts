import { applyEnvironment, defaultEnvironmentDeps, environmentCapabilities, type EnvironmentDeps } from '../backends/environment.ts';
import { parseEnvironmentAction } from '../core/environment.ts';
import { auditUiTree } from '../core/ui-audit.ts';
import { PhoneDockError, type UiTree } from '../core/types.ts';
import { checkLease, getDevice, logAction, uiCache } from './core.ts';
import { inputRoute } from './delivery.ts';
import { assertInputActive } from './execution.ts';
import { axTree, ocrTree } from './find.ts';
import { type Handler, notSupported } from './http.ts';
import { dev, router } from './routes.ts';

/** Dependency injection keeps command construction and router integration testable without a live device. */
export function environmentHandlers(deps?: EnvironmentDeps): { get: Handler; post: Handler; audit: Handler } {
  return {
    get: (c) => environmentCapabilities(dev(c).b),
    post: inputRoute(async (c) => {
      const d = dev(c); checkLease(d.id, c.owner);
      const action = parseEnvironmentAction(await c.body());
      const caps = environmentCapabilities(d.b);
      if (!caps.supported) throw new PhoneDockError('Environment controls require a simulator or emulator', 'not_supported', 501, caps.limitations, undefined, 'not_sent');
      const device = await getDevice(d.id);
      if (device.state !== 'running') throw new PhoneDockError('The test device is not running', 'not_running', 409, undefined, undefined, 'not_sent');
      // Every separate host/device mutation checks the current lease fence, including commands after async reads.
      const beforeMutation = () => { assertInputActive(); deps?.beforeMutation?.(); };
      const result = await applyEnvironment(d.b, d.nid, action, { ...(deps ?? defaultEnvironmentDeps()), beforeMutation });
      uiCache.delete(d.id);
      logAction(d.id, c.owner, { action: `environment.${action.action}`,
        ...(action.action === 'permissions' ? { appId: action.appId, state: action.state, permissions: action.permissions } : {}),
        ...(action.action === 'biometric' ? { event: action.event, modality: action.modality } : {}),
        ...(action.action === 'statusBar' ? { mode: action.mode } : {}),
      });
      return { ...result, retrySafe: result.delivery === 'not_sent' };
    }),
    audit: async (c) => {
      const d = dev(c);
      let tree: UiTree | undefined; let failure: unknown;
      try { tree = await axTree(d); } catch (e) { failure = e; }
      if (!tree) {
        if (!d.b.screenshot) throw failure ?? notSupported('UI audit', d.b.id);
        tree = await ocrTree(d.b, d.nid);
      }
      if (d.b.screenInfo && (d.b.platform === 'ios' ? !tree.screen.scale : d.b.platform === 'android' && !tree.screen.density)) {
        try {
          const info = await d.b.screenInfo(d.nid);
          if (info.width === tree.screen.width && info.height === tree.screen.height) tree = { ...tree, screen: { ...tree.screen, scale: tree.screen.scale ?? info.scale, density: tree.screen.density ?? info.density } };
        } catch { /* leave sizing unknown; the audit reports the limitation */ }
      }
      const result = auditUiTree(tree, d.b.platform, { includeOffscreen: c.q('includeOffscreen') === '1' });
      if (tree.complete === false) result.limitations.push('The accessibility dump is incomplete; missing elements cannot be audited.');
      return result;
    },
  };
}

const handlers = environmentHandlers();
router.get('/v1/devices/:id/environment', handlers.get);
router.post('/v1/devices/:id/environment', handlers.post);
router.get('/v1/devices/:id/audit', handlers.audit);
