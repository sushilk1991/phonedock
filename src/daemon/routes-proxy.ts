// Saved proxies and per-device proxy attachment routes (docs/API.md "Proxies").
import { assertDeviceAllowed, checkLease, deviceDecorators, emit, getBackend, getDevice, invalidateDevices, inventoryUpdateListeners, listDevices, logAction, splitId } from './core.ts';
import { Raw, badRequest } from './http.ts';
import { initProxies, isProxySupportedBackend, proxyManager } from './proxies.ts';
import { dev, router as r } from './routes.ts';
import type { ProxyTestResult } from '../core/proxy.ts';

// Wire the daemon's singleton proxy manager and attach redacted proxy metadata to Device objects.
initProxies({
  emitEvent: emit,
  logAction,
  invalidateDevices,
  getDevices: () => listDevices(false),
  assertCanMutateDevice: (deviceId, owner) => {
    assertDeviceAllowed(deviceId);
    checkLease(deviceId, owner);
  },
});

inventoryUpdateListeners.push((backend, devices) => {
  if (!isProxySupportedBackend(backend)) return;
  void proxyManager().reconcileAll(devices).catch(() => undefined);
});

deviceDecorators.push((d) => {
  const pm = proxyManager().deviceMeta(d.id);
  if (pm) d.meta = { ...(d.meta ?? {}), proxy: pm };
});

r.get('/v1/proxies', () => proxyManager().list());

r.post('/v1/proxies/test', async (c) => {
  const body = (await c.body()) as { url?: unknown };
  if (typeof body.url !== 'string' || !body.url.trim()) throw badRequest('url is required');
  return await proxyManager().testUrl(body.url);
});

r.post('/v1/proxies', async (c) => {
  const body = (await c.body()) as { name?: unknown; url?: unknown; test?: unknown; lastTest?: ProxyTestResult };
  const view = await proxyManager().add({
    name: body.name,
    url: body.url,
    test: body.test === true,
    ...(body.lastTest && typeof body.lastTest === 'object' ? { lastTest: body.lastTest } : {}),
  });
  return new Raw(201, JSON.stringify(view), { 'Content-Type': 'application/json' });
});

r.post('/v1/proxies/:pid/test', async (c) => {
  return await proxyManager().testSaved(c.params.pid);
});

r.patch('/v1/proxies/:pid', async (c) => {
  const body = (await c.body()) as { name?: unknown; url?: unknown };
  return await proxyManager().update(c.params.pid, { name: body.name, url: body.url }, c.owner);
});

r.del('/v1/proxies/:pid', async (c) => {
  return await proxyManager().remove(c.params.pid, c.owner);
});

r.get('/v1/devices/:id/proxy', async (c) => {
  const { id } = dev(c);
  const d = await getDevice(id);
  return proxyManager().getDeviceState(d);
});

r.add('PUT', '/v1/devices/:id/proxy', async (c) => {
  const { id } = dev(c);
  checkLease(id, c.owner);
  const body = (await c.body()) as { proxyId?: unknown; syncLocation?: unknown };
  if (typeof body.proxyId !== 'string' || !body.proxyId.trim()) {
    throw badRequest('proxyId is required', ['Use GET /v1/proxies to list saved proxies, or DELETE /v1/devices/:id/proxy to detach.']);
  }
  const d = await getDevice(id);
  const proxyId = body.proxyId.trim();
  const state = await proxyManager().attach(d, proxyId, c.owner);
  if (body.syncLocation === true && d.state === 'running') {
    let test = state.proxy?.lastTest;
    if (!test?.ok || test.lat === undefined || test.lon === undefined) {
      const tested = await proxyManager().testSaved(proxyId).catch(() => undefined);
      if (tested?.result.ok) test = tested.result;
    }
    if (test?.ok && test.lat !== undefined && test.lon !== undefined) {
      const { backend, nativeId } = splitId(id);
      const b = getBackend(backend);
      if (b.setLocation) {
        await b.setLocation(nativeId, test.lat, test.lon).catch(() => undefined);
        state.locationSynced = { lat: test.lat, lon: test.lon, ...(test.city ? { city: test.city } : {}), ...(test.country ? { country: test.country } : {}) };
      }
    }
  }
  return state;
});

r.del('/v1/devices/:id/proxy', async (c) => {
  const { id } = dev(c);
  checkLease(id, c.owner);
  const d = await getDevice(id);
  return await proxyManager().detach(d, c.owner);
});
