// GET/POST /v1/simslim: daemon-wide SimSlim setting for PhoneDock-managed iOS simulators.
// POST /v1/devices/:id/simslim: inspect, measure, enable or disable SimSlim on one iOS simulator.
import { PhoneDockError } from '../core/types.ts';
import { setSimslimSetting, simslimDeviceAction, simslimStatus } from '../backends/ios-simslim.ts';
import { checkLease, invalidateDevices } from './core.ts';
import { badRequest, notSupported } from './http.ts';
import { dev, router as r } from './routes.ts';

r.get('/v1/simslim', () => simslimStatus());

r.post('/v1/simslim', async (c) => {
  const body = (await c.body()) as Record<string, unknown>;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('JSON object required');
  const patch: { enabled?: boolean; except?: string[]; profilePath?: string | null } = {};
  if ('enabled' in body) {
    if (typeof body.enabled !== 'boolean') throw badRequest('enabled must be a boolean');
    patch.enabled = body.enabled;
  }
  if ('except' in body) patch.except = body.except as string[];
  if ('profilePath' in body) patch.profilePath = body.profilePath as string | null;
  if (!Object.keys(patch).length) throw badRequest('Provide enabled, except, or profilePath');
  setSimslimSetting(patch);
  return simslimStatus();
});

r.post('/v1/devices/:id/simslim', async (c) => {
  const { id, b, nid } = dev(c);
  if (b.id !== 'ios-simulator') {
    throw notSupported('SimSlim', b.id, ['SimSlim only applies to iOS simulators (ios-simulator backend).']);
  }
  const body = (await c.body()) as Record<string, unknown>;
  const action = typeof body?.action === 'string' ? body.action : 'status';
  if (!['status', 'measure', 'on', 'off'].includes(action)) {
    throw new PhoneDockError('action must be status, measure, on, or off', 'bad_request', 400);
  }
  if (action === 'on' || action === 'off') checkLease(id, c.owner);
  const info = await simslimDeviceAction(nid, action as 'status' | 'measure' | 'on' | 'off', {
    except: Array.isArray(body?.except) ? (body.except as string[]) : undefined,
    profilePath: 'profilePath' in (body ?? {}) ? (body.profilePath as string | null) : undefined,
    noReboot: body?.noReboot === true,
  });
  if (action === 'on' || action === 'off') invalidateDevices();
  return info;
});
