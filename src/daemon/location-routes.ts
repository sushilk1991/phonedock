// GPS route / GPX playback manager for virtual devices.
// Uses native `simctl location start` for non-looping iOS simulator routes and a bounded
// waypoint stepper (`backend.setLocation`) for Android emulators or looping routes.
import { downsamplePoints, haversineMeters, parseGpx, validateCoord, type GeoPoint } from '../core/gpx.ts';
import { PhoneDockError, type Backend } from '../core/types.ts';

export interface LocationRouteStatus {
  active: boolean;
  name?: string;
  mode?: 'native' | 'stepper';
  waypoints: number;
  index: number;
  speedMps: number;
  loop: boolean;
  startedAt?: string;
  current?: { lat: number; lon: number };
}

interface ActiveRoute {
  id: string;
  backend: Backend;
  nativeId: string;
  name?: string;
  mode: 'native' | 'stepper';
  points: GeoPoint[];
  index: number;
  speedMps: number;
  loop: boolean;
  startedAt: string;
  stopped: boolean;
  timer?: NodeJS.Timeout;
}

const activeRoutes = new Map<string, ActiveRoute>();

export function parseLocationRouteInput(body: Record<string, unknown>): {
  name?: string;
  points: GeoPoint[];
  speedMps: number;
  loop: boolean;
} {
  let name: string | undefined;
  let points: GeoPoint[] = [];
  if (typeof body.gpx === 'string') {
    const parsed = parseGpx(body.gpx);
    name = parsed.name;
    points = parsed.points;
  } else if (Array.isArray(body.waypoints)) {
    if (!body.waypoints.length) throw new PhoneDockError('waypoints must contain at least one { lat, lon } point', 'bad_request', 400);
    if (body.waypoints.length > 10_000) throw new PhoneDockError('Too many waypoints (max 10,000)', 'bad_request', 400);
    points = body.waypoints.map((w: unknown) => {
      if (!w || typeof w !== 'object') throw new PhoneDockError('Each waypoint must be an object with lat and lon', 'bad_request', 400);
      const rec = w as Record<string, unknown>;
      return validateCoord(rec.lat, rec.lon);
    });
  } else {
    throw new PhoneDockError('Pass either { lat, lon }, { gpx }, or { waypoints }', 'bad_request', 400);
  }
  const speedRaw = body.speedMps ?? body.speed ?? 5;
  const speedMps = Number(speedRaw);
  if (!Number.isFinite(speedMps) || speedMps < 0.5 || speedMps > 200) {
    throw new PhoneDockError('speedMps must be between 0.5 and 200 m/s', 'bad_request', 400);
  }
  const loop = body.loop === true;
  if (typeof body.name === 'string' && body.name.trim()) name = body.name.trim().slice(0, 120);
  return { name, points, speedMps, loop };
}

export function getLocationRouteStatus(id: string): LocationRouteStatus {
  const r = activeRoutes.get(id);
  if (!r || r.stopped) {
    return { active: false, waypoints: 0, index: 0, speedMps: 0, loop: false };
  }
  const pt = r.points[Math.min(r.index, r.points.length - 1)];
  return {
    active: true,
    ...(r.name ? { name: r.name } : {}),
    mode: r.mode,
    waypoints: r.points.length,
    index: r.index,
    speedMps: r.speedMps,
    loop: r.loop,
    startedAt: r.startedAt,
    ...(pt ? { current: { lat: pt.lat, lon: pt.lon } } : {}),
  };
}

export async function stopLocationRoute(id: string, clearNative = true): Promise<boolean> {
  const r = activeRoutes.get(id);
  if (!r) return false;
  r.stopped = true;
  if (r.timer) clearTimeout(r.timer);
  activeRoutes.delete(id);
  if (clearNative && r.mode === 'native' && r.backend.clearLocation) {
    await r.backend.clearLocation(r.nativeId).catch(() => undefined);
  }
  return true;
}

export async function startDeviceLocationRoute(
  id: string,
  backend: Backend,
  nativeId: string,
  spec: { name?: string; points: GeoPoint[]; speedMps: number; loop: boolean },
): Promise<LocationRouteStatus> {
  await stopLocationRoute(id, true);

  if (spec.points.length === 1) {
    if (!backend.setLocation) throw new PhoneDockError('Location simulation is not supported on this device', 'not_supported', 501);
    await backend.setLocation(nativeId, spec.points[0].lat, spec.points[0].lon);
    return {
      active: false,
      ...(spec.name ? { name: spec.name } : {}),
      waypoints: 1,
      index: 0,
      speedMps: spec.speedMps,
      loop: false,
      current: { lat: spec.points[0].lat, lon: spec.points[0].lon },
    };
  }

  // Prefer native CoreSimulator route interpolation for non-looping iOS simulator routes.
  if (!spec.loop && backend.startLocationRoute) {
    const capped = downsamplePoints(spec.points, 500);
    await backend.startLocationRoute(nativeId, capped, { speedMps: spec.speedMps });
    const entry: ActiveRoute = {
      id, backend, nativeId, name: spec.name, mode: 'native', points: capped,
      index: 0, speedMps: spec.speedMps, loop: false, startedAt: new Date().toISOString(), stopped: false,
    };
    activeRoutes.set(id, entry);
    return getLocationRouteStatus(id);
  }

  if (!backend.setLocation) {
    throw new PhoneDockError('Location simulation is not supported on this device', 'not_supported', 501);
  }

  const points = downsamplePoints(spec.points, 1000);
  await backend.setLocation(nativeId, points[0].lat, points[0].lon);

  const entry: ActiveRoute = {
    id, backend, nativeId, name: spec.name, mode: 'stepper', points,
    index: 0, speedMps: spec.speedMps, loop: spec.loop, startedAt: new Date().toISOString(), stopped: false,
  };
  activeRoutes.set(id, entry);

  const scheduleNext = () => {
    if (entry.stopped || activeRoutes.get(id) !== entry) return;
    const nextIdx = entry.index + 1;
    if (nextIdx >= entry.points.length) {
      if (!entry.loop) {
        entry.stopped = true;
        activeRoutes.delete(id);
        return;
      }
      entry.index = 0;
    } else {
      entry.index = nextIdx;
    }
    const prev = entry.points[entry.index === 0 ? entry.points.length - 1 : entry.index - 1];
    const cur = entry.points[entry.index];
    const dist = haversineMeters(prev, cur);
    const delayMs = Math.max(250, Math.min(10_000, Math.round((dist / entry.speedMps) * 1000)));
    entry.timer = setTimeout(async () => {
      if (entry.stopped || activeRoutes.get(id) !== entry) return;
      try {
        await entry.backend.setLocation!(entry.nativeId, cur.lat, cur.lon);
      } catch {
        // Stop route if the device shuts down or disappears.
        entry.stopped = true;
        if (activeRoutes.get(id) === entry) activeRoutes.delete(id);
        return;
      }
      scheduleNext();
    }, delayMs);
    entry.timer.unref?.();
  };
  scheduleNext();

  return getLocationRouteStatus(id);
}
