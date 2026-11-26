import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downsamplePoints, haversineMeters, parseGpx } from './gpx.ts';
import {
  getLocationRouteStatus,
  parseLocationRouteInput,
  startDeviceLocationRoute,
  stopLocationRoute,
} from '../daemon/location-routes.ts';
import type { Backend } from './types.ts';

const SAMPLE_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <trk>
    <name>Market Street Walk</name>
    <trkseg>
      <trkpt lat="37.7749" lon="-122.4194"><ele>15</ele></trkpt>
      <trkpt lon="-122.4100" lat="37.7800"/>
      <trkpt lat="37.7850" lon="-122.4000"></trkpt>
    </trkseg>
  </trk>
</gpx>`;

test('parseGpx extracts track name, coordinates in either attribute order, and elevation', () => {
  const res = parseGpx(SAMPLE_GPX);
  assert.equal(res.name, 'Market Street Walk');
  assert.equal(res.points.length, 3);
  assert.deepEqual(res.points[0], { lat: 37.7749, lon: -122.4194, ele: 15 });
  assert.deepEqual(res.points[1], { lat: 37.78, lon: -122.41 });
  assert.deepEqual(res.points[2], { lat: 37.785, lon: -122.4 });
});

test('parseGpx falls back to rtept and wpt and rejects empty/out-of-range coordinates', () => {
  const rte = parseGpx('<gpx><rte><rtept lat="51.5" lon="-0.1"/><rtept lat="51.6" lon="-0.2"/></rte></gpx>');
  assert.equal(rte.points.length, 2);
  const wpt = parseGpx('<gpx><wpt lat="12.97" lon="77.59"><name>Bengaluru</name></wpt></gpx>');
  assert.equal(wpt.points[0].name, 'Bengaluru');

  assert.throws(() => parseGpx('<gpx></gpx>'), (e: any) => e.code === 'bad_request');
  assert.throws(() => parseGpx('<gpx><wpt lat="95" lon="0"/></gpx>'), (e: any) => e.code === 'bad_request');
});

test('downsamplePoints keeps endpoints and haversineMeters measures distance', () => {
  const pts = Array.from({ length: 100 }, (_, i) => ({ lat: 37 + i * 0.001, lon: -122 }));
  const slim = downsamplePoints(pts, 10);
  assert.equal(slim.length, 10);
  assert.deepEqual(slim[0], pts[0]);
  assert.deepEqual(slim[9], pts[99]);

  // ~1 degree of latitude is ~111.19 km
  const d = haversineMeters({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
  assert.ok(d > 110_000 && d < 112_500);
});

test('location route manager uses native startLocationRoute when available and stepper otherwise', async () => {
  const nativeCalls: unknown[] = [];
  let cleared = 0;
  const iosBackend = {
    id: 'ios-simulator',
    startLocationRoute: async (nid: string, pts: { lat: number; lon: number }[], opts?: { speedMps?: number }) => {
      nativeCalls.push([nid, pts.length, opts?.speedMps]);
    },
    clearLocation: async () => { cleared++; },
  } as unknown as Backend;

  const parsed = parseLocationRouteInput({ gpx: SAMPLE_GPX, speedMps: 3.5 });
  const st = await startDeviceLocationRoute('ios-simulator:pdtest-gpx', iosBackend, 'pdtest-gpx', parsed);
  assert.equal(st.active, true);
  assert.equal(st.mode, 'native');
  assert.equal(st.waypoints, 3);
  assert.equal(st.name, 'Market Street Walk');
  assert.deepEqual(nativeCalls, [['pdtest-gpx', 3, 3.5]]);
  assert.equal(getLocationRouteStatus('ios-simulator:pdtest-gpx').active, true);

  assert.equal(await stopLocationRoute('ios-simulator:pdtest-gpx').then((r) => r.stopped), true);
  assert.equal(cleared, 1);
  assert.equal(getLocationRouteStatus('ios-simulator:pdtest-gpx').active, false);

  // Android emulator stepper path
  const fixes: [number, number][] = [];
  const androidBackend = {
    id: 'android-emulator',
    setLocation: async (_nid: string, lat: number, lon: number) => { fixes.push([lat, lon]); },
  } as unknown as Backend;

  const st2 = await startDeviceLocationRoute('android-emulator:pdtest-gpx', androidBackend, 'pdtest-gpx', {
    points: [{ lat: 37.7749, lon: -122.4194 }, { lat: 37.7849, lon: -122.4194 }],
    speedMps: 1,
    loop: false,
  });
  assert.equal(st2.active, true);
  assert.equal(st2.mode, 'stepper');
  // Current stays at the starting point until the next fix actually completes
  assert.deepEqual(st2.current, { lat: 37.7749, lon: -122.4194 });
  assert.deepEqual(fixes[0], [37.7749, -122.4194]);
  await stopLocationRoute('android-emulator:pdtest-gpx');
  assert.equal(getLocationRouteStatus('android-emulator:pdtest-gpx').active, false);
});

test('stop drains an in-flight start and looping stepper still calls clearLocation', async () => {
  let releaseFirst!: () => void;
  const firstPending = new Promise<void>((r) => { releaseFirst = r; });
  let clearCalls = 0;
  const slowBackend = {
    id: 'ios-simulator',
    setLocation: async () => { await firstPending; },
    clearLocation: async () => { clearCalls++; },
  } as unknown as Backend;

  const startP = startDeviceLocationRoute('ios-simulator:pdtest-race', slowBackend, 'pdtest-race', {
    points: [{ lat: 37.77, lon: -122.41 }, { lat: 37.78, lon: -122.42 }],
    speedMps: 5,
    loop: true,
  });
  const stopP = stopLocationRoute('ios-simulator:pdtest-race', true, slowBackend, 'pdtest-race');
  releaseFirst();
  await Promise.all([startP, stopP]);
  assert.equal(getLocationRouteStatus('ios-simulator:pdtest-race').active, false);
  assert.equal(clearCalls, 1);
});

test('parseGpx rejects files exceeding MAX_GPX_POINTS instead of dropping the destination', () => {
  const pts = Array.from({ length: 10_001 }, (_, i) => `<trkpt lat="${(i % 80)}" lon="0"/>`).join('');
  assert.throws(() => parseGpx(`<gpx><trk><trkseg>${pts}</trkseg></trk></gpx>`), (e: any) => e.code === 'bad_request');
});
