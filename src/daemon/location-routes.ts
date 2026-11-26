// GPS route / GPX playback manager for virtual devices.
// Serializes start, stop, fixed location writes and teardown per device, revalidates ownership/filter
// on every fix, tracks progress & completion for native iOS routes, and interpolates long stepper legs
// faithfully at the requested speed.
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

export interface LocationRouteCallbacks {
  /** Throws (e.g. lease_conflict or forbidden) if `owner` no longer controls `id`. */
  verifyOwner?: (id: string, owner: string) => void;
  /** Called after each successful stepper fix to keep idle-sleep clocks fresh across daemons. */
  onActivity?: (id: string) => void;
}

interface ActiveRoute {
  id: string;
  owner: string;
  backend: Backend;
  nativeId: string;
  name?: string;
  mode: 'native' | 'stepper';
  points: GeoPoint[];
  /** Cumulative arrival time (ms since startedAtMs) for each waypoint (native progress tracking). */
  arrivalMs: number[];
  startedAtMs: number;
  startedAt: string;
  index: number;
  current: { lat: number; lon: number };
  speedMps: number;
  loop: boolean;
  stopped: boolean;
  timer?: NodeJS.Timeout;
  callbacks: LocationRouteCallbacks;
}

const activeRoutes = new Map<string, ActiveRoute>();
const deviceLocks = new Map<string, Promise<void>>();
const stopEpoch = new Map<string, number>();

/** Serialize all location mutations (start, stop, fixed set, teardown) per device. */
export async function withLocationLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = deviceLocks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => { release = r; });
  const tail = prev.then(() => mine);
  deviceLocks.set(id, tail);
  await prev;
  try { return await fn(); }
  finally {
    release();
    if (deviceLocks.get(id) === tail) deviceLocks.delete(id);
  }
}

function buildArrivalSchedule(points: GeoPoint[], speedMps: number): number[] {
  const out = [0];
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const dist = haversineMeters(points[i - 1], points[i]);
    acc += (dist / speedMps) * 1000;
    out.push(acc);
  }
  return out;
}

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

function nativeProgress(r: ActiveRoute, nowMs = Date.now()): { done: boolean; index: number; current: { lat: number; lon: number } } {
  const totalMs = r.arrivalMs[r.arrivalMs.length - 1] ?? 0;
  const elapsed = Math.max(0, nowMs - r.startedAtMs);
  if (elapsed >= totalMs) {
    const last = r.points[r.points.length - 1];
    return { done: true, index: r.points.length - 1, current: { lat: last.lat, lon: last.lon } };
  }
  let idx = 0;
  while (idx + 1 < r.arrivalMs.length && r.arrivalMs[idx + 1] <= elapsed) idx++;
  const a = r.points[idx];
  const b = r.points[Math.min(idx + 1, r.points.length - 1)];
  const segStart = r.arrivalMs[idx];
  const segDur = (r.arrivalMs[idx + 1] ?? segStart) - segStart;
  const t = segDur > 0 ? Math.min(1, Math.max(0, (elapsed - segStart) / segDur)) : 0;
  return {
    done: false,
    index: idx,
    current: { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t },
  };
}

export function hasActiveLocationRoute(id: string): boolean {
  return getLocationRouteStatus(id).active;
}

export function getLocationRouteStatus(id: string): LocationRouteStatus {
  const r = activeRoutes.get(id);
  if (!r || r.stopped) {
    return { active: false, waypoints: 0, index: 0, speedMps: 0, loop: false };
  }
  if (r.mode === 'native') {
    const prog = nativeProgress(r);
    if (prog.done) {
      r.stopped = true;
      if (r.timer) clearTimeout(r.timer);
      activeRoutes.delete(id);
      return { active: false, waypoints: 0, index: 0, speedMps: 0, loop: false };
    }
    return {
      active: true,
      ...(r.name ? { name: r.name } : {}),
      mode: r.mode,
      waypoints: r.points.length,
      index: prog.index,
      speedMps: r.speedMps,
      loop: false,
      startedAt: r.startedAt,
      current: prog.current,
    };
  }
  return {
    active: true,
    ...(r.name ? { name: r.name } : {}),
    mode: r.mode,
    waypoints: r.points.length,
    index: r.index,
    speedMps: r.speedMps,
    loop: r.loop,
    startedAt: r.startedAt,
    current: r.current,
  };
}

function cancelEntry(r: ActiveRoute): void {
  r.stopped = true;
  if (r.timer) { clearTimeout(r.timer); r.timer = undefined; }
  if (activeRoutes.get(r.id) === r) activeRoutes.delete(r.id);
}

/** Cancel any active playback (best effort on ownership change / takeover). */
export function cancelLocationRouteOnOwnershipChange(id: string): void {
  stopEpoch.set(id, (stopEpoch.get(id) ?? 0) + 1);
  const r = activeRoutes.get(id);
  if (!r) return;
  cancelEntry(r);
  if (r.mode === 'native' && r.backend.clearLocation) {
    void r.backend.clearLocation(r.nativeId).catch(() => undefined);
  }
}

export async function stopLocationRoute(
  id: string,
  clearNative = true,
  backend?: Backend,
  nativeId?: string,
): Promise<{ stopped: boolean; cleared: boolean }> {
  // Bump epoch immediately so any in-flight start waiting on a backend call knows it was cancelled.
  stopEpoch.set(id, (stopEpoch.get(id) ?? 0) + 1);
  return withLocationLock(id, async () => {
    const r = activeRoutes.get(id);
    const stopped = !!r;
    if (r) cancelEntry(r);
    const b = r?.backend ?? backend;
    const nid = r?.nativeId ?? nativeId;
    let cleared = false;
    if (clearNative && b?.clearLocation && nid) {
      await b.clearLocation(nid);
      cleared = true;
    }
    return { stopped, cleared };
  });
}

export async function setFixedDeviceLocation(
  id: string,
  backend: Backend,
  nativeId: string,
  lat: number,
  lon: number,
): Promise<void> {
  stopEpoch.set(id, (stopEpoch.get(id) ?? 0) + 1);
  await withLocationLock(id, async () => {
    const prev = activeRoutes.get(id);
    if (prev) cancelEntry(prev);
    if (!backend.setLocation) {
      throw new PhoneDockError('Location simulation is not supported on this device', 'not_supported', 501,
        ['Physical Android devices need a mock-location app']);
    }
    await backend.setLocation(nativeId, lat, lon);
  });
}

const SUBSTEP_INTERVAL_MS = 1000;

export async function startDeviceLocationRoute(
  id: string,
  backend: Backend,
  nativeId: string,
  spec: { name?: string; points: GeoPoint[]; speedMps: number; loop: boolean },
  owner = 'anonymous',
  callbacks: LocationRouteCallbacks = {},
): Promise<LocationRouteStatus> {
  const myEpoch = (stopEpoch.get(id) ?? 0) + 1;
  stopEpoch.set(id, myEpoch);

  return withLocationLock(id, async () => {
    const prev = activeRoutes.get(id);
    if (prev) {
      cancelEntry(prev);
      if (prev.mode === 'native' && prev.backend.clearLocation) {
        await prev.backend.clearLocation(prev.nativeId).catch(() => undefined);
      }
    }

    if (spec.points.length === 1) {
      callbacks.verifyOwner?.(id, owner);
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
      callbacks.verifyOwner?.(id, owner);
      const capped = downsamplePoints(spec.points, 500);
      await backend.startLocationRoute(nativeId, capped, { speedMps: spec.speedMps });
      if (stopEpoch.get(id) !== myEpoch) {
        if (backend.clearLocation) await backend.clearLocation(nativeId).catch(() => undefined);
        return { active: false, waypoints: 0, index: 0, speedMps: 0, loop: false };
      }
      const nowMs = Date.now();
      const arrivalMs = buildArrivalSchedule(capped, spec.speedMps);
      const totalMs = arrivalMs[arrivalMs.length - 1] ?? 0;
      const entry: ActiveRoute = {
        id, owner, backend, nativeId, name: spec.name, mode: 'native', points: capped, arrivalMs,
        startedAtMs: nowMs, startedAt: new Date(nowMs).toISOString(),
        index: 0, current: { lat: capped[0].lat, lon: capped[0].lon },
        speedMps: spec.speedMps, loop: false, stopped: false, callbacks,
      };
      // Automatically mark completed once the route finishes.
      entry.timer = setTimeout(() => {
        if (activeRoutes.get(id) === entry) cancelEntry(entry);
      }, Math.min(2_147_000_000, Math.max(500, Math.round(totalMs) + 500)));
      entry.timer.unref?.();
      activeRoutes.set(id, entry);
      return getLocationRouteStatus(id);
    }

    if (!backend.setLocation) {
      throw new PhoneDockError('Location simulation is not supported on this device', 'not_supported', 501);
    }

    const points = downsamplePoints(spec.points, 1000);
    callbacks.verifyOwner?.(id, owner);
    await backend.setLocation(nativeId, points[0].lat, points[0].lon);
    if (stopEpoch.get(id) !== myEpoch) {
      return { active: false, waypoints: 0, index: 0, speedMps: 0, loop: false };
    }
    callbacks.onActivity?.(id);

    const nowMs = Date.now();
    const entry: ActiveRoute = {
      id, owner, backend, nativeId, name: spec.name, mode: 'stepper', points,
      arrivalMs: buildArrivalSchedule(points, spec.speedMps),
      startedAtMs: nowMs, startedAt: new Date(nowMs).toISOString(),
      index: 0, current: { lat: points[0].lat, lon: points[0].lon },
      speedMps: spec.speedMps, loop: spec.loop, stopped: false, callbacks,
    };
    activeRoutes.set(id, entry);

    // Step along each leg at the true requested speed, interpolating sub-steps every ~1s for long legs.
    let segFromIdx = 0;
    let segToIdx = 1;
    let segElapsedMs = 0;

    const scheduleStep = () => {
      if (entry.stopped || activeRoutes.get(id) !== entry) return;
      const from = entry.points[segFromIdx];
      const to = entry.points[segToIdx];
      const legMs = Math.max(250, Math.round((haversineMeters(from, to) / entry.speedMps) * 1000));
      const remainingMs = Math.max(0, legMs - segElapsedMs);
      const stepMs = remainingMs > SUBSTEP_INTERVAL_MS * 1.5 ? SUBSTEP_INTERVAL_MS : Math.max(250, remainingMs);

      entry.timer = setTimeout(() => {
        void withLocationLock(id, async () => {
          if (entry.stopped || activeRoutes.get(id) !== entry || stopEpoch.get(id) !== myEpoch) return;
          try {
            entry.callbacks.verifyOwner?.(id, entry.owner);
          } catch {
            cancelEntry(entry);
            return;
          }
          const nextElapsed = Math.min(legMs, segElapsedMs + stepMs);
          const frac = legMs > 0 ? nextElapsed / legMs : 1;
          const nextPos = frac >= 1
            ? { lat: to.lat, lon: to.lon }
            : { lat: from.lat + (to.lat - from.lat) * frac, lon: from.lon + (to.lon - from.lon) * frac };
          try {
            await entry.backend.setLocation!(entry.nativeId, nextPos.lat, nextPos.lon);
          } catch {
            cancelEntry(entry);
            return;
          }
          if (entry.stopped || activeRoutes.get(id) !== entry || stopEpoch.get(id) !== myEpoch) return;
          // Advance reported position ONLY after the backend write succeeded.
          entry.current = nextPos;
          entry.callbacks.onActivity?.(id);
          if (frac >= 1) {
            entry.index = segToIdx;
            segElapsedMs = 0;
            if (segToIdx + 1 < entry.points.length) {
              segFromIdx = segToIdx;
              segToIdx = segToIdx + 1;
            } else if (entry.loop) {
              segFromIdx = segToIdx;
              segToIdx = 0;
            } else {
              cancelEntry(entry);
              return;
            }
          } else {
            segElapsedMs = nextElapsed;
          }
          scheduleStep();
        });
      }, stepMs);
      entry.timer.unref?.();
    };
    scheduleStep();

    return getLocationRouteStatus(id);
  });
}
