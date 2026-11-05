// All /v1 routes (see docs/API.md).
import { createWriteStream, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import { sleep } from '../core/exec.ts';
import { stateDir } from '../core/paths.ts';
import { PhoneDockError, type Backend, type BootOptions, type Device, type DeviceSpec, type InputAction, type ScreenInfo, type SystemPrompt, type UiTree } from '../core/types.ts';
import { describePrompt, detectPrompt } from '../core/prompts.ts';
import {
  acquireLease, backends, checkLease, getBackend, getDevice, getJob, invalidateDevices, listDevices, listJobs,
  loadFailures, logAction, readActions, record, releaseLease, removeRecord, sharedStream, sharedVideo, splitId, sseClients, startJob,
  stopStreamsFor, restartStreamsFor, withTransition, dropLeaseOnStop, streamStats, uiCache, upsertRecord, pollDevices, withTimeout, stopRecordingFor, fallbackFrame, waitForStreamFrame, type Job,
  assertDeviceAllowed, assertNameAllowed, assertPhysicalAllowed, touchLease, noteScreen,
} from './core.ts';
import { HANDLED, Raw, Router, badRequest, notSupported, type Ctx } from './http.ts';
import { metrics } from './metrics.ts';
import { stopTraceFor } from './trace.ts';
import { IME_PROBE, imeFrameFrom } from '../backends/android-common.ts';
import { screenSourceStats } from '../backends/android-video.ts';
import { cleanTree, coarseWhere, labelAt, jpegSize, mergeOcr, partialRegions, pngSize, transformPng, uiText } from './media.ts';
import { readUiTree } from './find.ts';
import { recheckRef, resolveRef } from './refcheck.ts';
import { ocrUiTree, warmOcr } from '../core/ocr.ts';
import { inputRoute } from './delivery.ts';
import { encodeVideoPacket, pingMessage, stillMessage, videoHeader, VIDEO_CONTENT_TYPE, VIDEO_MSG, type VideoSink } from '../core/video.ts';
import { finishExpect, prepareExpect } from './expect.ts';

export const VERSION = '0.2.1';
const startedAt = Date.now();
export const router = new Router();
const r = router;

export function dev(c: Ctx): { id: string; b: Backend; nid: string } {
  const id = c.params.id;
  const { backend, nativeId } = splitId(id);
  assertDeviceAllowed(id);
  touchLease(id, c.owner);   // every call the lease owner makes renews its lease
  return { id, b: getBackend(backend), nid: nativeId };
}
export function need<K extends keyof Backend>(b: Backend, k: K, what?: string, hints?: string[]): NonNullable<Backend[K]> {
  const f = b[k];
  if (typeof f !== 'function') throw notSupported(what ?? String(k), b.id, hints);
  return (f as Function).bind(b) as NonNullable<Backend[K]>;
}
export const num = (v: string | undefined, d?: number) => (v === undefined || v === '' ? d : Number.isFinite(+v) ? +v : d);
export const truthy = (v: string | undefined) => v === '1' || v === 'true' || v === 'yes';

// ── service ─────────────────────────────────────────────────────────────────
r.get('/v1/metrics', () => metrics.snapshot());
r.get('/v1/health', () => ({ ok: true, version: VERSION, pid: process.pid, uptimeSec: Math.round((Date.now() - startedAt) / 1000) }));

let availCache: { at: number; v: unknown[] } | undefined;
r.get('/v1/backends', async (c) => {
  if (!availCache || Date.now() - availCache.at > 15_000 || truthy(c.q('refresh'))) {
    const v = await Promise.all(backends.map(async (b) => {
      let availability;
      try { availability = await withTimeout(b.available(), 20_000, `${b.id}.available`); } catch (e) { availability = { ok: false, reason: (e as Error).message }; }
      return { id: b.id, displayName: b.displayName, stage: b.stage ?? 'stable', platform: b.platform, kind: b.kind, capabilities: b.capabilities, availability };
    }));
    availCache = { at: Date.now(), v };
  }
  return truthy(c.q('debug')) ? { backends: availCache.v, failures: loadFailures, streams: streamStats(), screenSources: screenSourceStats() } : availCache.v;
});
r.get('/v1/backends/:backend/images', async (c) => {
  const b = getBackend(c.params.backend);
  return b.listImages ? await b.listImages() : [];
});
r.post('/v1/backends/:backend/images/install', async (c) => {
  const b = getBackend(c.params.backend);
  const body = await c.body();
  if (!body.image) throw badRequest('image required');
  const inst = need(b, 'installImage', 'image install');
  return new Raw(202, JSON.stringify(startJob('install-image', (p) => inst(String(body.image), p))), { 'Content-Type': 'application/json' });
});
r.get('/v1/backends/:backend/profiles', async (c) => {
  const b = getBackend(c.params.backend);
  return b.listProfiles ? await b.listProfiles() : [];
});
r.get('/v1/jobs', () => listJobs().slice(0, 100));
r.get('/v1/jobs/:jid', (c) => getJob(c.params.jid));

r.get('/v1/events', (c) => {
  const res = c.res;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write(`event: hello\ndata: ${JSON.stringify({ version: VERSION, pid: process.pid })}\n\n`);
  sseClients.add(res);
  c.req.on('close', () => sseClients.delete(res));
  void pollDevices();
  return HANDLED;
});

// ── devices ────────────────────────────────────────────────────────────────
r.get('/v1/devices', async (c) => {
  let list = await listDevices(truthy(c.q('fresh')));
  const be = c.q('backend'), pl = c.q('platform'), st = c.q('state');
  if (be) list = list.filter((d) => d.backend === be);
  if (pl) list = list.filter((d) => d.platform === pl);
  if (st) list = list.filter((d) => d.state === st);
  return list;
});

function createJob(spec: DeviceSpec, boot: boolean): Job {
  const b = getBackend(spec.backend);
  const create = need(b, 'create', 'device creation');
  if (!spec.name) throw badRequest('name required');
  assertNameAllowed(spec.name);
  return startJob('create', async (p, job) => {
    p(`creating ${spec.backend} device "${spec.name}"`);
    const d = await create(spec, p);
    job.deviceId = d.id;
    upsertRecord({ id: d.id, backend: d.backend, nativeId: d.nativeId, spec, autoStart: !!spec.autoStart, createdAt: new Date().toISOString() });
    invalidateDevices();
    if (boot) {
      p('booting…');
      const t0 = Date.now();
      await need(b, 'boot')(d.nativeId, { headless: spec.headless ?? true, onProgress: p } as BootOptions);
      p(`booted in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
    invalidateDevices();
    return await getDevice(d.id, true).catch(() => d);
  }, `${spec.backend}:${spec.name}`);
}
r.post('/v1/devices', async (c) => {
  const body = await c.body();
  const { boot, ...spec } = body as DeviceSpec & { boot?: boolean };
  if (!spec.backend) throw badRequest('backend required', ['GET /v1/backends']);
  const job = createJob(spec, !!boot);
  return new Raw(202, JSON.stringify({ job }), { 'Content-Type': 'application/json' });
});
r.post('/v1/devices/batch', async (c) => {
  const body = await c.body();
  const spec = body.spec as DeviceSpec; const count = Math.max(1, Math.min(Number(body.count) || 1, 32));
  if (!spec?.backend || !spec?.name) throw badRequest('spec.backend and spec.name required');
  const jobs = Array.from({ length: count }, (_v, i) => createJob({ ...spec, name: `${spec.name}-${i + 1}` }, !!body.boot));
  return new Raw(202, JSON.stringify({ jobs }), { 'Content-Type': 'application/json' });
});
r.get('/v1/devices/:id', (c) => getDevice(c.params.id, truthy(c.q('fresh'))));
r.patch('/v1/devices/:id', async (c) => {
  const d = await getDevice(c.params.id);
  const body = await c.body();
  const rec = record(d.id) ?? { id: d.id, backend: d.backend, nativeId: d.nativeId, spec: d.spec, createdAt: new Date().toISOString() };
  if (typeof body.name === 'string') { assertNameAllowed(body.name); rec.name = body.name; }
  if (typeof body.autoStart === 'boolean') rec.autoStart = body.autoStart;
  upsertRecord(rec);
  invalidateDevices();
  return getDevice(d.id, true);
});
r.del('/v1/devices/:id', async (c) => {
  const { id, b, nid } = dev(c);
  const d = await getDevice(id);
  const force = truthy(c.q('force'));
  if (!d.managed && !force) throw new PhoneDockError('This device was not created by PhoneDock', 'forbidden', 403, ['Delete it with force only if you really mean to remove a device PhoneDock did not create.'], `Device ${id} was not created by PhoneDock`);
  if (!force) checkLease(id, c.owner);   // force deletes a leased device too (`phonedock rm --force`)
  stopStreamsFor(id);
  await stopRecordingFor(id, 'device deleted');
  await stopTraceFor(id, 'device deleted').catch(() => undefined);
  await need(b, 'delete', 'delete')(nid);
  removeRecord(id); uiCache.delete(id); releaseLease(id, c.owner, true);
  invalidateDevices();
  return { ok: true };
});
r.post('/v1/devices/:id/boot', async (c) => {
  const { id, b, nid } = dev(c);
  const boot = need(b, 'boot', 'boot');
  await getDevice(id);
  const opts = (await c.body()) as BootOptions;
  const job = startJob('boot', async (p) => {
    const t0 = Date.now();
    p(`booting ${id}${opts.coldBoot ? ' (cold)' : ''}`);
    try { await boot(nid, { ...opts, onProgress: p } as BootOptions); }
    catch (e) { logAction(id, c.owner, { action: 'device.start_failed', error: failText(e) }); throw e; }
    p(`ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    logAction(id, c.owner, { action: 'device.start' });
    return await getDevice(id, true);
  }, id);
  return new Raw(202, JSON.stringify({ job }), { 'Content-Type': 'application/json' });
});
/** What went wrong, in a sentence for Activity: the error's message plus its first hint. */
export function failText(e: unknown): string {
  const pe = e as PhoneDockError;
  return [pe.message ?? String(e), pe.hints?.[0]].filter(Boolean).join(' ').slice(0, 400);
}
r.post('/v1/devices/:id/shutdown', async (c) => {
  const { id, b, nid } = dev(c);
  checkLease(id, c.owner);
  await shutdownDevice(id, b, nid, c.owner, 'stopping');
  return { ok: true };
});
/** Shut a device down. It reads "stopping" the moment this starts, its streams and recording end, and the outcome is
 *  logged (Activity). The person's control ends with it. */
async function shutdownDevice(id: string, b: Backend, nid: string, owner: string, kind: 'stopping' | 'restarting') {
  const stop = need(b, 'shutdown', 'shutdown');
  try {
    await withTransition(id, kind, async () => {
      stopStreamsFor(id);
      await stopRecordingFor(id, 'device shutdown');
      await stopTraceFor(id, 'device shutdown').catch(() => undefined);
      await stop(nid);
    });
  } catch (e) { logAction(id, owner, { action: 'device.shutdown_failed', error: failText(e) }); throw e; }
  uiCache.delete(id);
  dropLeaseOnStop(id);
  logAction(id, owner, { action: 'device.shutdown' });
  invalidateDevices();
}
r.post('/v1/devices/:id/restart', async (c) => {
  const { id, b, nid } = dev(c);
  checkLease(id, c.owner);
  const boot = need(b, 'boot', 'boot');
  const d = await getDevice(id);
  const opts = (await c.body()) as BootOptions;
  const owner = c.owner;
  const job = startJob('boot', async (p) => {
    const t0 = Date.now();
    try {
      if (d.state !== 'stopped') { p(`shutting down ${id}`); await shutdownDevice(id, b, nid, owner, 'restarting'); }
      p(`booting ${id}`);
      await boot(nid, { ...opts, onProgress: p } as BootOptions);
    } catch (e) { logAction(id, owner, { action: 'device.restart_failed', error: failText(e) }); throw e; }
    p(`restarted in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    logAction(id, owner, { action: 'device.restart' });
    return await getDevice(id, true);
  }, id);
  return new Raw(202, JSON.stringify({ job }), { 'Content-Type': 'application/json' });
});
r.post('/v1/devices/:id/clone', async (c) => {
  const { id, b, nid } = dev(c);
  const clone = need(b, 'clone', 'clone');
  const body = await c.body();
  if (!body.name) throw badRequest('name required');
  assertNameAllowed(String(body.name));
  const src = await getDevice(id);
  const job = startJob('clone', async (p) => {
    p(`cloning ${id} → ${body.name}`);
    const t0 = Date.now();
    const d = await clone(nid, String(body.name));
    p(`cloned in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    upsertRecord({ id: d.id, backend: d.backend, nativeId: d.nativeId, spec: { ...(record(id)?.spec ?? src.spec ?? {}), name: String(body.name) }, autoStart: false, createdAt: new Date().toISOString() });
    invalidateDevices();
    return await getDevice(d.id, true).catch(() => d);
  }, id);
  return new Raw(202, JSON.stringify({ job }), { 'Content-Type': 'application/json' });
});
r.post('/v1/devices/:id/window', async (c) => { const { b, nid } = dev(c); await need(b, 'openWindow', 'native window')(nid); return { ok: true }; });
/** Snapshots the emulator keeps for itself (quick boot) are not the person's: never listed. */
const INTERNAL_SNAPSHOTS = new Set(['default_boot']);
r.get('/v1/devices/:id/snapshots', async (c) => { const { b, nid } = dev(c); return (await need(b, 'listSnapshots', 'snapshots')(nid)).filter((s) => !INTERNAL_SNAPSHOTS.has(s.name)); });
r.post('/v1/devices/:id/snapshots', async (c) => {
  const { id, b, nid } = dev(c); checkLease(id, c.owner);
  const body = await c.body(); if (!body.name) throw badRequest('name required');
  if (INTERNAL_SNAPSHOTS.has(String(body.name))) throw badRequest(`"${body.name}" is reserved for the emulator`, ['Choose another name.']);
  try { await need(b, 'saveSnapshot', 'snapshots')(nid, String(body.name)); }
  catch (e) { logAction(id, c.owner, { action: 'snapshot.save_failed', name: body.name, error: failText(e) }); throw e; }
  logAction(id, c.owner, { action: 'snapshot.save', name: body.name });
  return { ok: true };
});
r.post('/v1/devices/:id/snapshots/:name/restore', async (c) => {
  const { id, b, nid } = dev(c); checkLease(id, c.owner);
  try { await withTransition(id, 'restoring', () => need(b, 'restoreSnapshot', 'snapshots')(nid, c.params.name)); }
  catch (e) { logAction(id, c.owner, { action: 'snapshot.restore_failed', name: c.params.name, error: failText(e) }); throw e; }
  uiCache.delete(id);
  // Only report the restore when the phone is up: a restore that leaves it off is a failure, not a success.
  const d = await getDevice(id, true);
  if (d.state !== 'running') {
    const e = new PhoneDockError('The phone isn’t running after restoring the snapshot', 'snapshot_failed', 500, ['Start the phone again, then try restoring.'], `Device state after restore: ${d.state}`);
    logAction(id, c.owner, { action: 'snapshot.restore_failed', name: c.params.name, error: failText(e) });
    throw e;
  }
  logAction(id, c.owner, { action: 'snapshot.restore', name: c.params.name });
  return { ok: true };
});
r.del('/v1/devices/:id/snapshots/:name', async (c) => {
  const { id, b, nid } = dev(c); checkLease(id, c.owner);
  await need(b, 'deleteSnapshot', 'snapshots')(nid, c.params.name);
  return { ok: true };
});
r.get('/v1/devices/:id/info', async (c) => { const { b, nid } = dev(c); return need(b, 'info', 'info')(nid); });
r.get('/v1/devices/:id/screen', async (c) => {
  const { id, b, nid } = dev(c);
  if (b.screenInfo) { const si = await b.screenInfo(nid); noteScreen(id, si.width, si.height); return si; }
  const s = pngSize(await b.screenshot(nid));
  return { width: s?.width, height: s?.height, scale: 1 };
});

// ── observation ─────────────────────────────────────────────────────────────
r.get('/v1/devices/:id/screenshot', async (c) => {
  const { id, b, nid } = dev(c);
  const png = await b.screenshot(nid);
  const src = pngSize(png);
  noteScreen(id, src?.width, src?.height);
  const fmt = (c.q('format') ?? 'png').toLowerCase().startsWith('j') ? 'jpeg' : 'png';
  const out = await transformPng(png, fmt, num(c.q('maxSize')), num(c.q('quality'), 70));
  return new Raw(200, out.data, {
    'Content-Type': out.type, 'Cache-Control': 'no-store',
    'X-Device-Width': src!.width, 'X-Device-Height': src!.height, 'X-Image-Width': out.width, 'X-Image-Height': out.height,
    'X-Scale': (src!.width / out.width).toFixed(4),
  });
});

async function captureFallback(b: Backend, nid: string, maxSize: number): Promise<{ data: Buffer; headers: Record<string, string | number> }> {
  const png = await b.screenshot(nid);
  const src = pngSize(png)!;
  const out = await transformPng(png, 'jpeg', maxSize, 70);
  return { data: out.data, headers: { 'X-Device-Width': src.width, 'X-Device-Height': src.height, 'X-Image-Width': out.width, 'X-Image-Height': out.height } };
}
async function frameFallback(c: Ctx, b: Backend, nid: string, maxSize: number) {
  const out = await captureFallback(b, nid, maxSize);
  return new Raw(200, out.data, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Frame-Source': 'screenshot', ...out.headers });
}
/** How long a just-started stream gets to deliver its first frame before a screenshot is taken instead. */
const STREAM_GRACE_MS = 250;
r.get('/v1/devices/:id/frame', async (c) => {
  const { id, b, nid } = dev(c);
  const maxSize = num(c.q('maxSize'), 720)!;
  if (!b.stream) return frameFallback(c, b, nid, maxSize);
  const s = sharedStream(id, maxSize);
  s.viewers++;
  try {
    // Until the stream's first frame: wait briefly for it, then serve a screenshot. Screenshots are shared by
    // concurrent polls and rate-limited (core.fallbackFrame), and carry an ETag so unchanged polls get 304.
    if (!s.latest) await waitForStreamFrame(s, s.startedAt + STREAM_GRACE_MS - Date.now());
    if (!s.latest) {
      const fb = fallbackFrame(s, () => captureFallback(b, nid, maxSize));
      const ac = new AbortController();
      const first = await Promise.race([fb, waitForStreamFrame(s, 30_000, ac.signal).then(() => undefined)]).finally(() => ac.abort());
      if (!s.latest) {
        const f = first ?? await fb;
        if (c.req.headers['if-none-match'] === f.etag) return new Raw(304, '', { ETag: f.etag, 'Cache-Control': 'no-store', 'X-Frame-Source': 'screenshot' });
        return new Raw(200, f.data, { ETag: f.etag, 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Frame-Source': 'screenshot', 'X-Frame-Age-Ms': Date.now() - f.at, ...f.headers });
      }
      fb.catch(() => undefined);   // the stream won the race; a failed capture is not this request's error
    }
    const dims = jpegSize(s.latest!);
    if (s.etag && c.req.headers['if-none-match'] === s.etag) return new Raw(304, '', { ETag: s.etag, 'Cache-Control': 'no-store', 'X-Frame-Source': 'stream' });
    const scr: Record<string, number> = s.screen?.width && s.screen.height ? { 'X-Device-Width': s.screen.width, 'X-Device-Height': s.screen.height } : {};
    return new Raw(200, s.latest, { ...(s.etag ? { ETag: s.etag } : {}), 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Frame-Source': 'stream', 'X-Frame-Age-Ms': Date.now() - s.latestAt, ...scr, ...(dims ? { 'X-Image-Width': dims.width, 'X-Image-Height': dims.height } : {}) });
  } finally { s.viewers--; s.lastAccess = Date.now(); }
});

r.get('/v1/devices/:id/stream', async (c) => {
  const { id, b, nid } = dev(c);
  const maxSize = num(c.q('maxSize'), 720)!; const fps = Math.max(1, Math.min(num(c.q('fps'), 15)!, 60));
  const res = c.res;
  res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store', Connection: 'close', Pragma: 'no-cache' });
  const write = (j: Buffer) => {
    if (res.writableLength > 4 * 1024 * 1024) return; // slow client – drop
    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${j.length}\r\n\r\n`); res.write(j); res.write('\r\n');
  };
  if (!b.stream) {
    // screenshot polling
    let open = true; c.req.on('close', () => { open = false; });
    while (open) {
      const t0 = Date.now();
      try { const out = await transformPng(await b.screenshot(nid), 'jpeg', maxSize, 70); write(out.data); } catch { await sleep(1000); }
      await sleep(Math.max(0, 1000 / Math.min(fps, 5) - (Date.now() - t0)));
    }
    return HANDLED;
  }
  const s = sharedStream(id, maxSize, fps);
  s.viewers++;
  let last = 0;
  const onFrame = (j: Buffer) => { const now = Date.now(); if (now - last < 1000 / fps - 5) return; last = now; write(j); };
  s.listeners.add(onFrame);
  if (s.latest) write(s.latest);
  c.req.on('close', () => { s.listeners.delete(onFrame); s.viewers--; s.lastAccess = Date.now(); });
  return HANDLED;
});

// Live video (docs/API.md "Live video"): the device's H.264 as it comes from its encoder, framed. One capture per
// device is shared by every viewer (and by /frame and /stream); a viewer that falls behind skips frames and resyncs.
/** A viewer that joins before the stream's first picture gets a screenshot after this long, to show meanwhile. */
const VIDEO_STILL_MS = 250;
r.get('/v1/devices/:id/video', async (c) => {
  const { id, b, nid } = dev(c);
  if (!b.video) throw notSupported('live video', b.id, ['GET /v1/devices/:id/frame serves JPEG frames']);
  const maxSize = Math.max(160, Math.min(num(c.q('maxSize'), 1280)!, 4096));
  const v = sharedVideo(id, maxSize);
  const res = c.res;
  res.writeHead(200, { 'Content-Type': VIDEO_CONTENT_TYPE, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'close' });
  res.socket?.setNoDelay(true);
  v.viewers++;
  let open = true; let lastWrite = Date.now(); let sawFrame = false; let stillTimer: NodeJS.Timeout | undefined;
  const write = (bufs: Buffer[]) => {
    if (!open) return;
    for (const x of bufs) res.write(x);
    lastWrite = Date.now();
  };
  const sink: VideoSink = {
    packet: (p) => { if (p.type === 'frame') sawFrame = true; write(encodeVideoPacket(p)); },
    backlog: () => res.writableLength,
  };
  // Every second without anything else: a viewer can tell a still screen from a dead connection.
  const ping = setInterval(() => { if (Date.now() - lastWrite >= 900) write([pingMessage()]); }, 1000);
  const onDrain = () => { if (open) v.fanout.drained(sink); };
  const close = () => {
    if (!open) return;
    open = false; clearInterval(ping); clearTimeout(stillTimer);
    res.off('drain', onDrain); v.fanout.remove(sink); v.endListeners.delete(onEnd);
    v.viewers--; v.lastAccess = Date.now();
  };
  const onEnd = (e?: Error) => {
    if (e && open) {
      const body = Buffer.from(JSON.stringify({ state: 'error', code: (e as PhoneDockError).code ?? 'stream_failed', message: e.message }));
      write([videoHeader(VIDEO_MSG.state, 0, body.length, Date.now()), body]);
    }
    close(); res.end();
  };
  v.endListeners.add(onEnd);
  res.on('drain', onDrain);
  c.req.on('close', close); res.on('close', close); res.on('error', close);
  v.fanout.add(sink);
  // Before the first picture (the encoder can take a second to start): a screenshot, shared by the viewers waiting.
  stillTimer = setTimeout(() => {
    if (!open || sawFrame) return;
    v.still ??= b.screenshot(nid).then((data) => ({ data, at: Date.now() }), () => undefined).finally(() => { setTimeout(() => { v.still = undefined; }, 2000); });
    void v.still.then((s) => { if (s && open && !sawFrame) write(stillMessage(s.data, s.at)); });
  }, VIDEO_STILL_MS);
  if (v.ended) onEnd(v.err);
  return HANDLED;
});

r.get('/v1/devices/:id/ui', async (c) => {
  const { id, b, nid } = dev(c);
  // OCR fallback: on by default when the device has no usable accessibility tree (e.g. iPhones without WDA);
  // `?ocrFallback=0` turns it off, `?source=ocr` forces it. A partial tree (empty containers / web views) gets the
  // OCR lines inside those gaps merged in, marked ocr:true; `?partialOcr=0` skips that.
  const ocrOff = c.q('ocrFallback') === '0' || c.q('ocrFallback') === 'false';
  const ocrFallback = !ocrOff || c.q('source') === 'ocr';
  let tree: UiTree | undefined; let err: unknown;
  if (b.uiTree && c.q('source') !== 'ocr') {
    try { tree = await readUiTree({ id, b, nid }); } catch (e) { err = e; }
  }
  if ((!tree || !tree.root.length) && ocrFallback) tree = await ocrUiTree(await b.screenshot(nid));
  else warmOcr();
  if (!tree) throw err ?? notSupported('UI tree', b.id, ['Use ?ocrFallback=1']);
  noteScreen(id, tree.screen?.width, tree.screen?.height);
  if (c.q('raw') !== '1') tree = cleanTree(tree);
  let prompt: SystemPrompt | null = null;
  try { prompt = detectPrompt(tree); } catch (e) { console.error('[phonedockd] detectPrompt:', e); }
  if (!ocrOff && c.q('partialOcr') !== '0' && c.q('partialOcr') !== 'false') tree = await withPartialOcr(b, nid, tree);
  uiCache.set(id, tree);
  if ((c.q('format') ?? 'json') === 'text') {
    let txt = uiText(tree);
    if (prompt) { const nl = txt.indexOf('\n'); txt = `${txt.slice(0, nl + 1)}# prompt: ${prompt.kind}${prompt.needsHuman ? ' (needs a human)' : ''} – ${describePrompt(prompt)}\n${txt.slice(nl + 1)}`; }
    return new Raw(200, txt, { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  return { ...tree, prompt };
});

/** When the accessibility tree has gaps (partialRegions), OCR the screenshot and merge the text found inside them.
 *  Complete trees return at once (no screenshot). OCR failures are reported in tree.ocr.error, never thrown. */
export async function withPartialOcr(b: Backend, nid: string, tree: UiTree): Promise<UiTree> {
  const regions = partialRegions(tree);
  if (!regions.length) return tree;
  const t0 = Date.now();
  const info = (merged: number, error?: string) => ({ regions: regions.map((e) => e.bounds), merged, ms: Date.now() - t0, ...(error ? { error } : {}) });
  try {
    const o = await ocrUiTree(await b.screenshot(nid));
    const m = mergeOcr(tree, o, regions);
    return { ...m.tree, ocr: info(m.merged) };
  } catch (e) {
    return { ...tree, ocr: info(0, (e as PhoneDockError).detail ?? (e as Error).message) };
  }
}

// ── input ──────────────────────────────────────────────────────────────────
/** Android: the IME is a window of its own, never in the tree. When it is up and covers the point an element tap
 *  aims at, the tap types a key instead (landscape: a fullscreen keyboard covers the whole app; blind re-run 10 typed
 *  "q" into the name field instead of pressing Greet). Hide it first. Only for taps aimed at an element (ref, or x,y
 *  with a `label`): a bare x,y may be a deliberate tap on a key. */
async function clearImeOver(b: Backend, nid: string, x: number, y: number): Promise<boolean> {
  if (b.platform !== 'android' || !b.shell || !b.hideKeyboard) return false;
  const r = await b.shell(nid, IME_PROBE).catch(() => undefined);
  const f = r ? imeFrameFrom(r.stdout) : undefined;
  if (!f || !(x >= f.x && y >= f.y && x < f.x + f.width && y < f.y + f.height)) return false;
  try { await b.hideKeyboard(nid); return true; } catch { return false; }
}
export async function runAction(id: string, b: Backend, nid: string, a: InputAction): Promise<Record<string, unknown> | undefined> {
  switch (a.action) {
    case 'tap': {
      if ('ref' in a && a.ref) {
        // The element the ref names, found again on the screen as it is now (refcheck.ts): tapped where it is, or
        // nothing is tapped (stale_ref). Its point is above a floating bar that covers its centre (iOS 26 Settings'
        // search field: tap the row's part above the bar).
        const d = { id, b, nid };
        let p = await resolveRef(d, a.ref);
        const kb = await clearImeOver(b, nid, p.x, p.y);
        if (kb) {   // hiding the keyboard can move the layout again
          p = await recheckRef(d, p, Date.now()).catch((e: unknown) => {
            if (e instanceof PhoneDockError) e.detail = `${e.detail ?? ''}\nThe on-screen keyboard covered it, so it was hidden first; the screen changed after that.`.trim();
            throw e;
          });
        }
        await b.tap(nid, p.x, p.y);
        const el = p.el;
        return { ref: a.ref, x: p.x, y: p.y, element: { type: el.type, text: el.text, label: el.label, id: el.id }, ...(p.coveredBy ? { coveredBy: p.coveredBy, ...(p.hidden ? { hidden: true } : {}) } : {}), ...(kb ? { keyboardHidden: true } : {}),
          ...(p.moved ? { moved: p.moved } : {}), refCheck: p.check };
      }
      const t = a as { x: number; y: number; label?: string };
      if (!Number.isFinite(t.x) || !Number.isFinite(t.y)) throw badRequest('tap needs x,y or ref');
      const kb = t.label ? await clearImeOver(b, nid, t.x, t.y) : false;
      await b.tap(nid, t.x, t.y); return kb ? { keyboardHidden: true } : undefined;
    }
    case 'longPress':
      if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) throw badRequest('longPress needs x,y');
      await need(b, 'longPress', 'longPress')(nid, a.x, a.y, a.durationMs ?? 800); return undefined;
    case 'doubleTap':
      if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) throw badRequest('doubleTap needs x,y');
      if (b.doubleTap) { await b.doubleTap(nid, a.x, a.y); return undefined; }
      await b.tap(nid, a.x, a.y); await sleep(80); await b.tap(nid, a.x, a.y); // fallback: two taps ~80 ms apart
      return { fallback: 'two taps' };
    case 'pinch':
      if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) throw badRequest('pinch needs x,y');
      if (!Number.isFinite(a.scale) || a.scale <= 0) throw badRequest('pinch needs scale > 0 (<1 pinch in / zoom out, >1 spread / zoom in)');
      await need(b, 'pinch', 'pinch')(nid, a.x, a.y, a.scale, a.durationMs ?? 400); return undefined;
    case 'swipe':
      if (![a.x1, a.y1, a.x2, a.y2].every(Number.isFinite)) throw badRequest('swipe needs x1,y1,x2,y2');
      await b.swipe(nid, a.x1, a.y1, a.x2, a.y2, a.durationMs ?? 300); return undefined;
    case 'type':
      if (typeof a.text !== 'string') throw badRequest('type needs text');
      await b.type(nid, a.text); return undefined;
    case 'key':
      if (!a.key) throw badRequest('key needs key');
      await b.key(nid, a.key); return undefined;
    default:
      throw badRequest(`Unknown action "${(a as { action?: string }).action}"`, ['tap | longPress | doubleTap | pinch | swipe | type | key']);
  }
}
/** What a tap was aimed at, for Activity: `label` (the element, when known) and `where` (a coarse place, "near the top
 *  right"). Added next to the raw x/y, never instead of them. Never throws. */
async function pointInWords(id: string, a: InputAction, res: Record<string, unknown> | undefined): Promise<Record<string, string>> {
  try {
    const p = a as { x?: number; y?: number };
    if (!['tap', 'longPress', 'doubleTap', 'pinch'].includes(a.action)) return {};
    const x = Number.isFinite(p.x) ? p.x : res?.x as number | undefined, y = Number.isFinite(p.y) ? p.y : res?.y as number | undefined;
    if (x === undefined || y === undefined) return {};
    const out: Record<string, string> = {};
    const tree = uiCache.get(id);
    const el = res?.element as { text?: string; label?: string } | undefined;
    const label = el?.text || el?.label || (tree && Date.now() - Date.parse(tree.capturedAt) < 60_000 ? labelAt(tree, x, y) : undefined);
    if (label) out.label = label;
    const screen = tree?.screen ?? (await getDevice(id).catch(() => undefined))?.screen;
    const where = screen ? coarseWhere(x, y, screen.width, screen.height) : undefined;
    if (where) out.where = where;
    return out;
  } catch { return {}; }
}
r.post('/v1/devices/:id/input', inputRoute(async (c) => {
  const { id, b, nid } = dev(c);
  checkLease(id, c.owner);
  const body = await c.body();
  const actions: InputAction[] = Array.isArray(body.actions) ? body.actions : [body];
  // `expect`: checked (and the screen read) before anything is sent; waited for after the last action
  const exp = await prepareExpect({ id, b, nid }, body.expect);
  const resolved: unknown[] = [];
  for (const a of actions) {
    const res = await runAction(id, b, nid, a);
    resolved.push(res ?? null);
    logAction(id, c.owner, a, { ...(res ? { resolved: res } : {}), ...(await pointInWords(id, a, res)) });
    if ((a as { delayMs?: number }).delayMs) await sleep(Math.min(10_000, (a as { delayMs?: number }).delayMs!));
  }
  if (resolved.some(Boolean)) uiCache.delete(id); // refs are stale once the screen changes… keep them only per /ui
  const expect = exp ? await finishExpect({ id, b, nid }, exp) : undefined;
  return { ok: true, resolved: Array.isArray(body.actions) ? resolved : resolved[0] ?? undefined, ...(expect ? { expect } : {}) };
}));
r.get('/v1/devices/:id/actions', (c) => readActions(c.params.id, Math.max(1, Math.min(num(c.q('limit'), 200)!, 10_000))));
r.post('/v1/devices/:id/replay', async (c) => {
  const { id, b, nid } = dev(c);
  checkLease(id, c.owner);
  const body = await c.body();
  const actions = Array.isArray(body.actions) ? body.actions as (InputAction & { delayMs?: number })[] : [];
  if (!actions.length) throw badRequest('actions[] required');
  const owner = c.owner;
  const job = startJob('replay', async (p) => {
    let i = 0; const skipped: number[] = []; const warnings: string[] = [];
    for (const a of actions) {
      checkLease(id, owner);
      if (a.delayMs) await sleep(Math.min(60_000, a.delayMs));
      i++;
      // Secret text is never recorded (the log holds '•••'), so it can't be replayed: skip with a warning.
      if (a.action === 'type' && (a.secret || (a as { text?: string }).text === '•••')) {
        skipped.push(i); const w = `step ${i}: skipped secret text (not recorded; type it yourself)`;
        warnings.push(w); p(`${i}/${actions.length} WARNING ${w}`); continue;
      }
      p(`${i}/${actions.length} ${JSON.stringify(a)}`);
      const res = await runAction(id, b, nid, a);
      logAction(id, owner, a, { replay: true, ...(res ? { resolved: res } : {}) });
    }
    return { ok: true, count: actions.length, ...(skipped.length ? { skipped, warnings } : {}) };
  }, id);
  return new Raw(202, JSON.stringify({ job }), { 'Content-Type': 'application/json' });
});
r.post('/v1/devices/:id/lease', async (c) => {
  const id = c.params.id; await getDevice(id);
  const body = await c.body();
  return acquireLease(id, String(body.owner ?? c.owner), num(body.ttlSec), !!body.force);
});
r.del('/v1/devices/:id/lease', async (c) => releaseLease(c.params.id, c.owner, truthy(c.q('force'))));

// ── apps & system ───────────────────────────────────────────────────────────
r.get('/v1/devices/:id/apps', async (c) => {
  const { b, nid } = dev(c);
  const f = need(b, 'listApps', 'app listing') as (n: string, o?: { system?: boolean }) => ReturnType<NonNullable<Backend['listApps']>>;
  return f(nid, { system: truthy(c.q('system')) });
});
async function download(url: string): Promise<string> {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw badRequest('url must be http(s)');
  const resp = await fetch(u, { redirect: 'follow' });
  if (!resp.ok || !resp.body) throw new PhoneDockError('Couldn’t download the file', 'download_failed', 502, undefined, `Download failed: HTTP ${resp.status}`);
  const name = (basename(u.pathname) || 'download').replace(/[^A-Za-z0-9._-]+/g, '_');
  const dest = join(stateDir('downloads'), `${randomBytes(4).toString('hex')}-${name}`);
  await pipeline(Readable.fromWeb(resp.body as never), createWriteStream(dest));
  return dest;
}
r.post('/v1/devices/:id/apps', async (c) => {
  const { id, b, nid } = dev(c);
  checkLease(id, c.owner);
  const body = await c.body();
  let path: string | undefined = body.path;
  if (!path && body.url) path = await download(String(body.url));
  if (!path) throw badRequest('path or url required');
  if (!existsSync(path)) throw new PhoneDockError('Couldn’t find the file', 'not_found', 404, undefined, `File not found: ${path}`);
  const app = await need(b, 'installApp', 'app install')(nid, path);
  logAction(id, c.owner, { action: 'install', path, url: body.url });
  return { ok: true, app: app ?? undefined, path };
});
r.del('/v1/devices/:id/apps/:appId', async (c) => {
  const { id, b, nid } = dev(c); checkLease(id, c.owner);
  await need(b, 'uninstallApp', 'uninstall')(nid, c.params.appId);
  logAction(id, c.owner, { action: 'uninstall', appId: c.params.appId });
  return { ok: true };
});
r.post('/v1/devices/:id/apps/:appId/launch', inputRoute(async (c) => {
  const { id, b, nid } = dev(c); checkLease(id, c.owner);
  const appId = c.params.appId;
  const body = await c.body().catch(() => ({} as Record<string, unknown>));
  const exp = await prepareExpect({ id, b, nid }, body.expect);
  await need(b, 'launchApp', 'launch')(nid, appId);
  logAction(id, c.owner, { action: 'launch', appId });
  const front = body.verify === false || !b.foregroundApp ? {} : await confirmInFront(b, nid, appId);
  const expect = exp ? await finishExpect({ id, b, nid }, exp) : undefined;
  return { ok: true, ...front, ...(expect ? { expect } : {}) };
}));
/** After a launch: is the app in front? A launch right after Home (iOS) can leave the home screen showing while the
 *  app starts behind it (blind run 4: "Launched" over the home screen): then launch once more. Polls ≤3 s. */
export async function confirmInFront(b: Backend, nid: string, appId: string, waitMs = 3000): Promise<{ inFront?: boolean; foreground?: string | null; relaunched?: boolean }> {
  const t0 = Date.now(); let relaunched = false; let fg: string | null = null;
  for (;;) {
    const app = await b.foregroundApp!(nid).catch(() => undefined);
    if (app === undefined) return {};   // can't tell: say nothing
    fg = app?.id ?? null;
    if (fg === appId) return { inFront: true, foreground: fg, ...(relaunched ? { relaunched } : {}) };
    // still the home screen after a second (or after one slow read, under load): launch once more, then look again
    if (!relaunched && fg === null && b.platform === 'ios' && Date.now() - t0 > 1000) { await b.launchApp!(nid, appId).catch(() => undefined); relaunched = true; await sleep(300); continue; }
    if (Date.now() - t0 >= waitMs) break;
    await sleep(300);
  }
  return { inFront: false, foreground: fg, ...(relaunched ? { relaunched } : {}) };
}
r.post('/v1/devices/:id/apps/:appId/terminate', async (c) => {
  const { id, b, nid } = dev(c); checkLease(id, c.owner);
  await need(b, 'terminateApp', 'terminate')(nid, c.params.appId);
  logAction(id, c.owner, { action: 'terminate', appId: c.params.appId });
  return { ok: true };
});
r.post('/v1/devices/:id/open-url', async (c) => {
  const { id, b, nid } = dev(c); checkLease(id, c.owner);
  const body = await c.body(); if (!body.url) throw badRequest('url required');
  await need(b, 'openUrl', 'openUrl')(nid, String(body.url));
  logAction(id, c.owner, { action: 'openUrl', url: body.url });
  return { ok: true };
});
r.post('/v1/devices/:id/shell', async (c) => {
  const { id, b, nid } = dev(c); checkLease(id, c.owner);
  const body = await c.body(); if (typeof body.command !== 'string' || !body.command) throw badRequest('command required');
  const res = await need(b, 'shell', 'shell')(nid, body.command);
  logAction(id, c.owner, { action: 'shell', command: body.command }, { code: res.code });
  return res;
});
r.post('/v1/devices/:id/files/push', async (c) => {
  const { id, b, nid } = dev(c); checkLease(id, c.owner);
  const body = await c.body(); if (!body.local || !body.remote) throw badRequest('local and remote required');
  await need(b, 'pushFile', 'file push')(nid, String(body.local), String(body.remote));
  logAction(id, c.owner, { action: 'push', local: body.local, remote: body.remote });
  return { ok: true };
});
r.post('/v1/devices/:id/files/pull', async (c) => {
  const { id, b, nid } = dev(c); checkLease(id, c.owner);
  const body = await c.body(); if (!body.local || !body.remote) throw badRequest('remote and local required');
  await need(b, 'pullFile', 'file pull')(nid, String(body.remote), String(body.local));
  return { ok: true };
});
r.get('/v1/devices/:id/logs', async (c) => {
  const { b, nid } = dev(c);
  const lines = num(c.q('lines'), 300) ?? 300, filter = c.q('filter') || undefined, app = c.q('app') || undefined;
  const logs = need(b, 'logs', 'logs');
  if (!app) return new Raw(200, await logs(nid, { lines, filter }), { 'Content-Type': 'text/plain; charset=utf-8' });
  // ?app=<package or bundle id>: only that app's lines (its running processes; lines that name it if it isn't running).
  if (!/^[A-Za-z0-9._-]+$/.test(app)) throw badRequest('app must be a package name or bundle id');
  const pids = await appPids(b, nid, app);
  const all = (await logs(nid, { lines: Math.min(lines * 20, 20_000), filter })).split('\n');
  const mine = all.filter((l) => {
    const pid = /^\d\d-\d\d \S+\s+(\d+)\s/.exec(l)?.[1] ?? /^\S+ \S+ \S+\s+[^\s[]+\[(\d+):/.exec(l)?.[1];
    return (pid !== undefined && pids.has(pid)) || l.includes(app);
  });
  return new Raw(200, mine.slice(-lines).join('\n'), { 'Content-Type': 'text/plain; charset=utf-8' });
});

/** Process ids of a running app: `pidof` on Android, launchd's UIKitApplication jobs on an iOS simulator. */
async function appPids(b: Backend, nid: string, app: string): Promise<Set<string>> {
  if (!b.shell) return new Set();
  try {
    if (b.platform === 'android') {
      const r = await b.shell(nid, `pidof ${app}`);
      return new Set(r.stdout.split(/\s+/).filter((p) => /^\d+$/.test(p)));
    }
    if (b.id === 'ios-simulator') {
      const r = await b.shell(nid, 'launchctl list');
      const out = new Set<string>();
      for (const l of r.stdout.split('\n')) {
        const m = /^(\d+)\s+\S+\s+UIKitApplication:([^[\s]+)\[/.exec(l);
        if (m && m[2] === app) out.add(m[1]);
      }
      return out;
    }
  } catch { /* not running, or no shell: fall back to lines that name the app */ }
  return new Set();
}
r.post('/v1/devices/:id/location', async (c) => {
  const { id, b, nid } = dev(c); checkLease(id, c.owner);
  const body = await c.body(); const lat = Number(body.lat), lon = Number(body.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw badRequest('lat and lon required');
  await need(b, 'setLocation', 'location', ['Physical Android devices need a mock-location app'])(nid, lat, lon);
  logAction(id, c.owner, { action: 'location', lat, lon });
  return { ok: true };
});
r.post('/v1/devices/:id/push', async (c) => {
  const { id, b, nid } = dev(c); checkLease(id, c.owner);
  const body = await c.body(); if (!body.appId) throw badRequest('appId required');
  await need(b, 'pushNotification', 'push notifications', ['Android: use /shell with `cmd notification post …`'])(nid, String(body.appId), body.payload ?? {});
  return { ok: true };
});
r.post('/v1/devices/:id/rotate', async (c) => {
  const { id, b, nid } = dev(c); checkLease(id, c.owner);
  const body = await c.body();
  if (body.orientation !== 'portrait' && body.orientation !== 'landscape') throw badRequest('orientation must be portrait|landscape');
  await need(b, 'rotate', 'rotate')(nid, body.orientation);
  restartStreamsFor(id); uiCache.delete(id);
  // The screen as it ended up: an app that keeps its orientation (the phone home screen, many games) doesn't turn.
  let screen: ScreenInfo | undefined;
  try { if (b.screenInfo) screen = await b.screenInfo(nid); } catch { /* the rotation itself went through */ }
  const orientation = screen?.width && screen.height ? (screen.width > screen.height ? 'landscape' : 'portrait') : body.orientation;
  invalidateDevices();
  logAction(id, c.owner, { action: 'rotate', orientation: body.orientation, ...(orientation !== body.orientation ? { stayed: orientation } : {}) });
  return { ok: true, orientation, ...(screen ? { screen } : {}), ...(orientation !== body.orientation ? { note: `The app on screen stays in ${orientation}; it turns once an app that can rotate is open.` } : {}) };
});

// ── physical connection ─────────────────────────────────────────────────────
type WifiOpts = { serial?: string; restartAdb?: boolean };
type WifiResult = { message: string; serial: string; paired?: string };
type Connector = {
  connect?: (a: string | undefined, o?: WifiOpts) => Promise<WifiResult>;
  pair?: (a: string, code: string, o?: WifiOpts) => Promise<string>;
  pairWithCode?: (code: string, o?: WifiOpts) => Promise<WifiResult>;
  discoverPhones?: () => Promise<unknown[]>;
};
const wifiOpts = (body: Record<string, unknown>): WifiOpts => ({ serial: body.serial ? String(body.serial) : undefined, restartAdb: body.restartAdb === true });
const androidDevice = () => backends.find((x) => x.id === 'android-device') as (Backend & Connector) | undefined;
type IosConnector = {
  connectWda: (input: string, o?: { name?: string; udid?: string }) => Promise<{ nativeId: string; wdaUrl: string; status: unknown }>;
  disconnect: (nid: string) => Promise<boolean>;
  discover: () => Promise<unknown[]>;
  wdaSetup: (udid: string, o: { team?: string; destination?: string; name?: string }, p?: (l: string) => void) => Promise<unknown>;
};
function iosBackend(): Backend & IosConnector {
  const b = backends.find((x) => x.id === 'ios-device') as (Backend & Partial<IosConnector>) | undefined;
  if (!b?.connectWda) throw notSupported('iOS Wi-Fi connect', 'ios-device');
  return b as Backend & IosConnector;
}
r.post('/v1/connect', async (c) => {
  assertPhysicalAllowed('connect');
  const body = await c.body();
  if (body.platform === 'ios' || body.wdaUrl) {
    const target = body.wdaUrl ?? body.address;
    if (!target) throw badRequest('wdaUrl or address required for platform ios (e.g. { "platform": "ios", "address": "192.168.1.20" })');
    const b = iosBackend();
    const r0 = await b.connectWda(String(target), { name: body.name ? String(body.name) : undefined, udid: body.udid ? String(body.udid) : undefined });
    invalidateDevices();
    const device = (await listDevices(true)).find((d) => d.backend === 'ios-device' && d.nativeId === r0.nativeId);
    return { ok: true, device, wdaUrl: r0.wdaUrl };
  }
  const b = androidDevice();
  if (!b?.connect) throw notSupported('connect', 'android-device');
  // No address: connect to the phone named by `serial`, or the only phone advertising Wireless debugging.
  const res = await b.connect(body.address ? String(body.address) : undefined, wifiOpts(body));
  invalidateDevices();
  const device = (await listDevices(true)).find((d) => d.backend === 'android-device' && d.nativeId === res.serial);
  return { ok: true, device, message: res.message };
});
r.del('/v1/connect/:id', async (c) => {
  assertPhysicalAllowed('disconnect');
  const { backend, nativeId } = splitId(c.params.id);
  if (backend === 'ios-device') {
    const ok = await iosBackend().disconnect(nativeId);
    if (!ok) throw new PhoneDockError('This device has no saved Wi-Fi connection', 'not_found', 404, undefined, `${c.params.id} has no saved Wi-Fi/WDA connection`);
  } else if (backend === 'android-device') {
    const b = backends.find((x) => x.id === 'android-device') as (Backend & { disconnect?: (a: string) => Promise<unknown> }) | undefined;
    if (!b?.disconnect) throw notSupported('disconnect', 'android-device');
    await b.disconnect(nativeId);
  } else throw badRequest(`disconnect is only for physical devices (got ${backend})`);
  stopStreamsFor(c.params.id); uiCache.delete(c.params.id);
  invalidateDevices();
  return { ok: true };
});
r.get('/v1/ios/discover', async () => { assertPhysicalAllowed('discover'); return iosBackend().discover(); });
r.post('/v1/ios/wda-setup', async (c) => {
  assertPhysicalAllowed('wda-setup');
  const body = await c.body(); if (!body.udid) throw badRequest('udid required');
  const b = iosBackend();
  const job = startJob('wda-setup', async (p) => {
    const res = await b.wdaSetup(String(body.udid), { team: body.team ? String(body.team) : undefined, destination: body.destination ? String(body.destination) : undefined, name: body.name ? String(body.name) : undefined }, p);
    invalidateDevices();
    return res;
  });
  return new Raw(202, JSON.stringify({ job }), { 'Content-Type': 'application/json' });
});
r.get('/v1/android/discover', async () => {
  assertPhysicalAllowed('discover');
  const b = androidDevice();
  if (!b?.discoverPhones) throw notSupported('discover', 'android-device');
  return b.discoverPhones();
});
r.post('/v1/pair', async (c) => {
  assertPhysicalAllowed('pair');
  const body = await c.body(); if (!body.code) throw badRequest('code required (the six-digit pairing code); address (host:port) is optional');
  const b = androidDevice();
  if (!b?.pair || !b.pairWithCode) throw notSupported('pair', 'android-device');
  if (body.address) {
    const out = await b.pair(String(body.address), String(body.code), wifiOpts(body));
    return { ok: true, message: out };
  }
  // Code only: pair with the phone showing its pairing screen, then connect to it.
  const res = await b.pairWithCode(String(body.code), wifiOpts(body));
  invalidateDevices();
  const device = (await listDevices(true)).find((d) => d.backend === 'android-device' && d.nativeId === res.serial);
  return { ok: true, device, message: res.message, serial: res.paired };
});

// ── pool ───────────────────────────────────────────────────────────────────
r.post('/v1/pool/acquire', async (c) => {
  const body = await c.body();
  const owner = String(body.owner ?? c.owner);
  const ttl = num(body.ttlSec);
  const match = (d: Device) => (!body.platform || d.platform === body.platform) && (!body.backend || d.backend === body.backend);
  const all = await listDevices(true);
  const list = all.filter(match);
  const free = (d: Device) => !d.lease || d.lease.owner === owner || !!d.lease.stale;   // stale: reclaimed by acquireLease
  const bootIt = async (d: Device) => {
    const lease = acquireLease(d.id, owner, ttl);
    const b = getBackend(d.backend);
    await need(b, 'boot')(d.nativeId, { headless: true });
    invalidateDevices();
    return { device: await getDevice(d.id, true), lease };
  };
  // Explicit device: lease exactly that one (boot it if stopped). Respects existing leases unless force.
  if (body.deviceId) {
    const d = all.find((x) => x.id === body.deviceId);
    if (!d) throw new PhoneDockError('The device was not found', 'not_found', 404, undefined, `No device ${body.deviceId}`);
    if (d.state === 'running' || d.kind === 'physical') return { device: d, lease: acquireLease(d.id, owner, ttl, !!body.force) };
    return bootIt(d);
  }
  // Implicit selection only ever picks PhoneDock-managed devices. Pre-existing simulators/AVDs and
  // physical devices (phones, adb-connected TVs, …) may be in use by a human: they must be named, or
  // physical devices opted in with includePhysical.
  const running = list.find((d) => d.state === 'running' && free(d) && d.managed)
    ?? (body.includePhysical ? list.find((d) => d.state === 'running' && free(d) && d.kind === 'physical') : undefined);
  if (running) return { device: running, lease: acquireLease(running.id, owner, ttl) };
  const stopped = list.find((d) => d.state === 'stopped' && d.managed && free(d));
  if (stopped) return bootIt(stopped);
  if (body.createIfNone) {
    const spec = body.createIfNone as DeviceSpec;
    const b = getBackend(spec.backend);
    const d = await need(b, 'create', 'create')(spec);
    upsertRecord({ id: d.id, backend: d.backend, nativeId: d.nativeId, spec, autoStart: false, createdAt: new Date().toISOString() });
    return bootIt(d);
  }
  throw new PhoneDockError('No free device matches', 'no_device', 404, ['Choose another device or create one.'], 'Pass createIfNone: DeviceSpec to create one on demand');
});
r.post('/v1/pool/release', async (c) => {
  const body = await c.body(); if (!body.deviceId) throw badRequest('deviceId required');
  return releaseLease(String(body.deviceId), String(body.owner ?? c.owner));
});

