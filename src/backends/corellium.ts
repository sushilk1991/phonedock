// Corellium cloud backend (EXPERIMENTAL, untested without an account): real iOS / Android virtual devices
// running on Corellium's Arm servers. Plain REST client against the public v1 API
// (spec: https://app.corellium.com/api/openapi.json, docs: https://support.corellium.com/api), no SDK dependency.
//
// Config (env):  CORELLIUM_API_TOKEN (required, Bearer token)  ·  CORELLIUM_API_URL (default https://app.corellium.com/api)
//                CORELLIUM_PROJECT (optional project id/name; default = first project the token can see)
//
// Coordinates: touch input is sent with `normalized: true` (0..10000 per axis), computed from the size of the
// latest screenshot.png, so PhoneDock's "screenshot pixels" contract holds regardless of Corellium's native space.
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { Backend, Device, DeviceSpec, OsImage, HardwareProfile, Snapshot, ScreenInfo, Availability, BootOptions, Capability, KeyName, AppInfo, Platform, DeviceState } from '../core/types.ts';
import { PhoneDockError } from '../core/types.ts';
import { sleep } from '../core/exec.ts';

const ID = 'corellium';
const CAPS: Capability[] = ['boot', 'shutdown', 'delete', 'snapshot', 'screenshot', 'tap', 'longPress', 'swipe', 'type', 'key',
  'install', 'apps', 'launch', 'files', 'logs', 'rotate'];

const apiBase = () => (process.env.CORELLIUM_API_URL ?? 'https://app.corellium.com/api').replace(/\/+$/, '');
const token = () => process.env.CORELLIUM_API_TOKEN?.trim() || undefined;
const HINTS = [
  'Set CORELLIUM_API_TOKEN (Corellium web UI → Profile → API Token) and restart the PhoneDock daemon',
  'Optional: CORELLIUM_API_URL for on-prem / enterprise domains (e.g. https://<domain>.enterprise.corellium.com/api)',
  'Optional: CORELLIUM_PROJECT=<project id or name>',
];

interface ApiOpts { body?: unknown; raw?: Buffer; contentType?: string; binary?: boolean; timeoutMs?: number; allow404?: boolean }

async function api<T = any>(method: string, path: string, o: ApiOpts = {}): Promise<T> {
  const tok = token();
  if (!tok) throw new PhoneDockError('Corellium is not configured', 'not_configured', 503, ['Configure your Corellium account and restart PhoneDock.'], HINTS.join('\n'));
  const headers: Record<string, string> = { Authorization: `Bearer ${tok}`, Accept: o.binary ? '*/*' : 'application/json' };
  let body: BodyInit | undefined;
  if (o.raw) { body = new Uint8Array(o.raw); headers['Content-Type'] = o.contentType ?? 'application/octet-stream'; }
  else if (o.body !== undefined) { body = JSON.stringify(o.body); headers['Content-Type'] = 'application/json'; }
  let res: Response;
  try {
    res = await fetch(apiBase() + path, { method, headers, body, signal: AbortSignal.timeout(o.timeoutMs ?? 60_000) });
  } catch (e) {
    throw new PhoneDockError('Couldn’t reach Corellium', 'cloud_unreachable', 502, undefined, `Corellium ${method} ${path}: ${(e as Error).message}`);
  }
  if (res.status === 404 && o.allow404) return undefined as T;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = text.slice(0, 500);
    try { const j = JSON.parse(text); msg = j.error ?? j.message ?? msg; } catch {}
    const code = res.status === 401 || res.status === 403 ? 'unauthorized' : res.status === 404 ? 'not_found' : res.status === 409 ? 'conflict' : 'cloud_error';
    throw new PhoneDockError('Corellium couldn’t complete the request', code, res.status >= 500 ? 502 : res.status,
      res.status === 401 ? ['Check your Corellium account credentials.'] : undefined, `Corellium ${method} ${path} → ${res.status}: ${text || msg}${res.status === 401 ? `\n${HINTS.join('\n')}` : ''}`);
  }
  if (o.binary) return Buffer.from(await res.arrayBuffer()) as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try { return JSON.parse(text) as T; } catch { return text as T; }
}

// ── helpers ─────────────────────────────────────────────────────────────────
interface CInstance { id: string; name?: string; flavor: string; flavorName?: string; type?: string; state?: string; os?: string; osbuild?: string; project?: string; error?: string; [k: string]: unknown }

function platformOf(flavor = '', type = ''): Platform {
  const s = `${type} ${flavor}`.toLowerCase();
  if (/ios|iphone|ipad|ipod/.test(s)) return 'ios';
  if (/android|ranchu|aosp|generic/.test(s)) return 'android';
  return 'other';
}
const STATES: Record<string, DeviceState> = {
  on: 'running', off: 'stopped', booting: 'booting', rebooting: 'booting', restoring: 'booting',
  creating: 'creating', deleting: 'stopping', paused: 'stopped', error: 'error',
};
const screenCache = new Map<string, { width: number; height: number }>();

function toDevice(i: CInstance): Device {
  const sc = screenCache.get(i.id);
  return {
    id: `${ID}:${i.id}`, backend: ID, nativeId: i.id, name: i.name ?? i.id,
    platform: platformOf(i.flavor, i.type), kind: 'cloud', state: STATES[i.state ?? ''] ?? 'unknown', managed: true,
    osVersion: i.os ? `${platformOf(i.flavor, i.type) === 'ios' ? 'iOS' : 'Android'} ${i.os}${i.osbuild ? ` (${i.osbuild})` : ''}` : undefined,
    model: i.flavorName ?? i.flavor, connection: 'remote',
    screen: sc ? { ...sc, scale: 1 } : undefined,
    capabilities: CAPS, error: i.error ? String(i.error) : undefined,
    meta: { flavor: i.flavor, project: i.project, serviceIp: i.serviceIp, wifiIp: i.wifiIp, adbPort: i['port-adb'], experimental: true },
  };
}

const getInstance = (id: string) => api<CInstance>('GET', `/v1/instances/${encodeURIComponent(id)}`);

async function waitState(id: string, want: string[], timeoutMs: number): Promise<CInstance> {
  const end = Date.now() + timeoutMs; let last: CInstance | undefined;
  while (Date.now() < end) {
    last = await getInstance(id);
    if (last.state && want.includes(last.state)) return last;
    if (last.state === 'error') throw new PhoneDockError('The Corellium device reported an error', 'device_error', 500, undefined, `Instance ${id}: ${last.error ?? ''}`);
    await sleep(5000);
  }
  throw new PhoneDockError('Timed out waiting for the Corellium device', 'timeout', 504, undefined, `Instance ${id}: wanted ${want.join('/')}; last state: ${last?.state}`);
}

async function resolveProject(pref?: unknown): Promise<string> {
  const want = (pref ? String(pref) : process.env.CORELLIUM_PROJECT) || undefined;
  const projects = await api<{ id: string; name: string }[]>('GET', '/v1/projects');
  if (!projects?.length) throw new PhoneDockError('No Corellium projects are available', 'not_found', 404, ['Check your Corellium account access.']);
  if (!want) return projects[0].id;
  const p = projects.find((x) => x.id === want || x.name === want);
  if (!p) throw new PhoneDockError('The Corellium project was not found', 'not_found', 404, ['Choose an available Corellium project.'], `Requested project: ${want}; available projects: ${projects.map((x) => x.name).join(', ')}`);
  return p.id;
}

function pngSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return undefined;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
async function size(id: string) {
  const c = screenCache.get(id); if (c) return c;
  await backend.screenshot(id);
  const s = screenCache.get(id);
  if (!s) throw new PhoneDockError('Could not determine Corellium screen size', 'screenshot_failed', 500);
  return s;
}
const norm = (v: number, max: number) => Math.round(Math.min(Math.max(v / Math.max(1, max), 0), 1) * 10000);
async function pos(id: string, x: number, y: number) { const s = await size(id); return [[norm(x, s.width), norm(y, s.height)]]; }
const input = (id: string, events: unknown[]) => api('POST', `/v1/instances/${encodeURIComponent(id)}/input`, { body: events });

// Corellium button names (OpenAPI `Button` enum) + keyboard key names.
const KEYMAP: Record<string, string> = {
  home: 'homeButton', power: 'holdButton', lock: 'holdButton', volume_up: 'volumeUp', volume_down: 'volumeDown',
  back: 'backButton', app_switch: 'overviewButton', enter: 'enter', delete: 'backspace', tab: 'tab', escape: 'escape',
  space: 'space', up: 'up', down: 'down', left: 'left', right: 'right',
};

async function snapByName(id: string, name: string) {
  const list = await api<{ id: string; name: string }[]>('GET', `/v1/instances/${encodeURIComponent(id)}/snapshots`);
  const s = list.find((x) => x.name === name || x.id === name);
  if (!s) throw new PhoneDockError('The snapshot was not found', 'not_found', 404, undefined, `Snapshot: ${name}; Corellium instance: ${id}`);
  return s;
}
const agent = (id: string, p: string) => `/v1/instances/${encodeURIComponent(id)}/agent/v1${p}`;
const devPath = (p: string) => encodeURIComponent(p.startsWith('/') ? p : `/${p}`);

// ── backend ─────────────────────────────────────────────────────────────────
export const backend: Backend = {
  id: ID,
  displayName: 'Corellium cloud (experimental)',
  stage: 'experimental',
  platform: 'ios', // primary use: real iOS VMs. Android (AOSP) instances report platform 'android' per device.
  kind: 'cloud',
  capabilities: CAPS,

  async available(): Promise<Availability> {
    if (!token()) return { ok: false, reason: 'CORELLIUM_API_TOKEN is not set', hints: HINTS };
    try {
      const p = await api<unknown[]>('GET', '/v1/projects', { timeoutMs: 15_000 });
      return { ok: true, version: `v1 API · ${Array.isArray(p) ? p.length : 0} project(s) · EXPERIMENTAL` };
    } catch (e) {
      return { ok: false, reason: (e as Error).message, hints: (e as PhoneDockError).hints ?? HINTS };
    }
  },

  async listDevices(): Promise<Device[]> {
    if (!token()) return [];
    const list = await api<CInstance[]>('GET', '/v1/instances');
    return (list ?? []).map(toDevice);
  },

  async listImages(): Promise<OsImage[]> {
    const models = await api<{ flavor: string; name: string; type: string; description?: string }[]>('GET', '/v1/models');
    const out: OsImage[] = [];
    await Promise.all((models ?? []).slice(0, 80).map(async (m) => {
      const sw = await api<{ version: string; buildid: string; size?: number; releasedate?: string }[]>('GET', `/v1/models/${encodeURIComponent(m.flavor)}/software`).catch(() => []);
      for (const f of sw ?? []) {
        out.push({
          id: `${m.flavor}@${f.version}#${f.buildid}`, backend: ID, platform: platformOf(m.flavor, m.type),
          name: `${m.name ?? m.flavor} · ${platformOf(m.flavor, m.type) === 'ios' ? 'iOS' : 'Android'} ${f.version} (${f.buildid})`,
          version: f.version, installed: true, sizeMB: f.size ? Math.round(f.size / 1048576) : undefined,
          notes: 'Cloud firmware (downloaded server-side by Corellium). Billing applies per instance.',
        });
      }
    }));
    return out.sort((a, b) => a.name.localeCompare(b.name));
  },

  async listProfiles(): Promise<HardwareProfile[]> {
    const models = await api<{ flavor: string; name: string; description?: string }[]>('GET', '/v1/models');
    return (models ?? []).map((m) => ({ id: m.flavor, name: m.description ?? m.name ?? m.flavor }));
  },

  async create(spec: DeviceSpec, onProgress?: (l: string) => void): Promise<Device> {
    const o = (spec.options ?? {}) as Record<string, unknown>;
    // image: "<flavor>@<version>[#<build>]" (from listImages) or profile=<flavor> + options.os/osbuild.
    const m = spec.image?.match(/^([^@]+)@([^#]+)(?:#(.+))?$/);
    const flavor = m?.[1] ?? spec.profile ?? (o.flavor as string | undefined);
    const os = m?.[2] ?? (o.os as string | undefined);
    const osbuild = m?.[3] ?? (o.osbuild as string | undefined);
    if (!flavor || !os) throw new PhoneDockError('A Corellium device model and operating system are required', 'invalid_spec', 400, ['Choose a device image or specify a model and operating system.'], 'Use image "<flavor>@<version>[#build]" or profile + options.os. GET /v1/images?backend=corellium');
    const project = await resolveProject(o.project);
    onProgress?.(`creating ${flavor} ${os}${osbuild ? ` (${osbuild})` : ''} in project ${project}`);
    const created = await api<{ id: string; state: string }>('POST', '/v1/instances', {
      body: { project, name: spec.name, flavor, os, ...(osbuild ? { osbuild } : {}), ...(o.createOptions as object ?? {}) },
    });
    onProgress?.(`instance ${created.id} state=${created.state}; waiting for it to finish creating (can take several minutes)`);
    const inst = await waitState(created.id, ['on', 'off'], 30 * 60_000);
    return toDevice(inst);
  },

  async boot(nativeId: string, _opts?: BootOptions): Promise<void> {
    const i = await getInstance(nativeId);
    if (i.state !== 'on') {
      if (i.state === 'paused') await api('POST', `/v1/instances/${encodeURIComponent(nativeId)}/unpause`);
      else if (i.state !== 'booting') await api('POST', `/v1/instances/${encodeURIComponent(nativeId)}/start`, { body: {} });
      await waitState(nativeId, ['on'], 20 * 60_000);
    }
    // The in-VM agent (apps/files) comes up after the OS; wait up to 5 min but don't fail boot on it.
    const end = Date.now() + 5 * 60_000;
    while (Date.now() < end) {
      const ok = await api('GET', agent(nativeId, '/app/ready'), { timeoutMs: 15_000 }).then(() => true, () => false);
      if (ok) break;
      await sleep(5000);
    }
  },

  async shutdown(nativeId: string): Promise<void> {
    await api('POST', `/v1/instances/${encodeURIComponent(nativeId)}/stop`, { body: { soft: true } });
    await waitState(nativeId, ['off'], 5 * 60_000);
  },

  async delete(nativeId: string): Promise<void> {
    await api('DELETE', `/v1/instances/${encodeURIComponent(nativeId)}`, { allow404: true });
    const end = Date.now() + 5 * 60_000;
    while (Date.now() < end) {
      if (!(await api('GET', `/v1/instances/${encodeURIComponent(nativeId)}`, { allow404: true }))) break;
      await sleep(5000);
    }
    screenCache.delete(nativeId);
  },

  async listSnapshots(nativeId: string): Promise<Snapshot[]> {
    const list = await api<{ id: string; name: string; date?: number; live?: boolean }[]>('GET', `/v1/instances/${encodeURIComponent(nativeId)}/snapshots`);
    return (list ?? []).map((s) => ({ name: s.name, createdAt: s.date ? new Date(s.date > 1e12 ? s.date : s.date * 1000).toISOString() : undefined }));
  },
  async saveSnapshot(nativeId: string, name: string): Promise<void> {
    await api('POST', `/v1/instances/${encodeURIComponent(nativeId)}/snapshots`, { body: { name } });
  },
  async restoreSnapshot(nativeId: string, name: string): Promise<void> {
    const s = await snapByName(nativeId, name);
    await api('POST', `/v1/instances/${encodeURIComponent(nativeId)}/snapshots/${encodeURIComponent(s.id)}/restore`);
    screenCache.delete(nativeId);
  },
  async deleteSnapshot(nativeId: string, name: string): Promise<void> {
    const s = await snapByName(nativeId, name);
    await api('DELETE', `/v1/instances/${encodeURIComponent(nativeId)}/snapshots/${encodeURIComponent(s.id)}`);
  },

  async screenshot(nativeId: string): Promise<Buffer> {
    const buf = await api<Buffer>('GET', `/v1/instances/${encodeURIComponent(nativeId)}/screenshot.png?scale=1`, { binary: true });
    const s = pngSize(buf); if (s) screenCache.set(nativeId, s);
    return buf;
  },
  async screenInfo(nativeId: string): Promise<ScreenInfo> { return { ...(await size(nativeId)), scale: 1 }; },

  async tap(nativeId, x, y) { await backend.longPress!(nativeId, x, y, 100); },
  async longPress(nativeId, x, y, durationMs) {
    await input(nativeId, [
      { buttons: ['finger'], position: await pos(nativeId, x, y), normalized: true, wait: 0 },
      { buttons: [], wait: Math.max(50, durationMs) },
    ]);
  },
  async swipe(nativeId, x1, y1, x2, y2, durationMs) {
    const dur = Math.max(100, durationMs || 300); const steps = Math.max(5, Math.min(30, Math.round(dur / 25)));
    const ev: unknown[] = [{ buttons: ['finger'], position: await pos(nativeId, x1, y1), normalized: true, wait: 0 }];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      ev.push({ position: await pos(nativeId, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t), normalized: true, wait: Math.round(dur / steps) });
    }
    ev.push({ buttons: [], wait: 30 });
    await input(nativeId, ev);
  },
  async type(nativeId, text) { await input(nativeId, [{ text }]); },
  async key(nativeId: string, key: KeyName) {
    const k = String(key); const name = KEYMAP[k.toLowerCase()] ?? k;
    await input(nativeId, [{ buttons: [name], wait: 0 }, { buttons: [], wait: 100 }]);
  },

  async installApp(nativeId: string, path: string): Promise<void> {
    const tmp = await api<{ path: string }>('POST', agent(nativeId, '/file/temp'));
    const remote = tmp?.path ? `${tmp.path}${basename(path).replace(/[^\w.-]/g, '_')}` : `/tmp/${basename(path)}`;
    await api('PUT', agent(nativeId, `/file/device/${devPath(remote)}`), { raw: readFileSync(path), timeoutMs: 15 * 60_000 });
    await api('POST', agent(nativeId, '/app/install'), { body: { path: remote }, timeoutMs: 15 * 60_000 });
  },
  async uninstallApp(nativeId, appId) { await api('POST', agent(nativeId, `/app/apps/${encodeURIComponent(appId)}/uninstall`)); },
  async listApps(nativeId: string): Promise<AppInfo[]> {
    const r = await api<{ apps?: { bundleID: string; name?: string; applicationType?: string }[] }>('GET', agent(nativeId, '/app/apps'));
    return (r?.apps ?? []).map((a) => ({ id: a.bundleID, name: a.name, system: a.applicationType ? a.applicationType !== 'User' : undefined }));
  },
  async launchApp(nativeId, appId) { await api('POST', agent(nativeId, `/app/apps/${encodeURIComponent(appId)}/run`)); },
  async terminateApp(nativeId, appId) { await api('POST', agent(nativeId, `/app/apps/${encodeURIComponent(appId)}/kill`)); },
  async pushFile(nativeId, localPath, remotePath) {
    if (statSync(localPath).size > 2 * 1024 ** 3) throw new PhoneDockError('File too large for upload (>2 GB)', 'too_large', 413);
    await api('PUT', agent(nativeId, `/file/device/${devPath(remotePath)}`), { raw: readFileSync(localPath), timeoutMs: 15 * 60_000 });
  },
  async pullFile(nativeId, remotePath, localPath) {
    writeFileSync(localPath, await api<Buffer>('GET', agent(nativeId, `/file/device/${devPath(remotePath)}`), { binary: true, timeoutMs: 15 * 60_000 }));
  },
  async logs(nativeId: string, opts?: { lines?: number; filter?: string }): Promise<string> {
    const text = String(await api<string>('GET', `/v1/instances/${encodeURIComponent(nativeId)}/consoleLog`) ?? '');
    let lines = text.split('\n');
    if (opts?.filter) { const n = opts.filter.toLowerCase(); lines = lines.filter((l) => l.toLowerCase().includes(n)); }
    return lines.slice(-(opts?.lines ?? 200)).join('\n');
  },
  async rotate(nativeId, orientation) {
    // 1 = portrait, 3 = landscape (UIDeviceOrientation numbering; unverified against a live instance).
    await api('POST', `/v1/instances/${encodeURIComponent(nativeId)}/rotate`, { body: { orientation: orientation === 'portrait' ? 1 : 3 } });
    screenCache.delete(nativeId);
  },
  async info(nativeId: string) { return { ...(await getInstance(nativeId)), experimental: true, apiBase: apiBase() }; },
};
