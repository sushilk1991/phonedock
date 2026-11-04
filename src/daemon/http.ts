// Minimal HTTP helpers (node:http only) + a tiny router.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PhoneDockError } from '../core/types.ts';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  owner: string;
  body: () => Promise<any>;
  q: (k: string) => string | undefined;
}
export type Handler = (c: Ctx) => Promise<unknown> | unknown;

interface Route { method: string; path: string; re: RegExp; keys: string[]; h: Handler }
export class Router {
  routes: Route[] = [];
  add(method: string, path: string, h: Handler) {
    const keys: string[] = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_m, k: string) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, path, re, keys, h });
  }
  get(p: string, h: Handler) { this.add('GET', p, h); }
  post(p: string, h: Handler) { this.add('POST', p, h); }
  patch(p: string, h: Handler) { this.add('PATCH', p, h); }
  del(p: string, h: Handler) { this.add('DELETE', p, h); }
  match(method: string, path: string): { h: Handler; path: string; params: Record<string, string> } | 'method' | undefined {
    let pathHit = false;
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathHit = true;
      if (r.method !== method) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { h: r.h, path: r.path, params };
    }
    return pathHit ? 'method' : undefined;
  }
}

export function readBody(req: IncomingMessage, limit = 10 * 1024 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let n = 0;
    req.on('data', (d: Buffer) => { n += d.length; if (n > limit) { reject(new PhoneDockError('The request is too large', 'too_large', 413, undefined, `Request body exceeds ${limit} bytes.`)); req.destroy(); } else chunks.push(d); });
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8').trim();
      if (!s) return resolve({});
      try { resolve(JSON.parse(s)); } catch (e) { reject(new PhoneDockError('The request contains invalid JSON', 'bad_json', 400, undefined, String(e))); }
    });
    req.on('error', reject);
  });
}

export function sendJson(res: ServerResponse, status: number, data: unknown) {
  if (res.headersSent) { try { res.end(); } catch { /* */ } return; }
  const body = JSON.stringify(data ?? null);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

export function sendError(res: ServerResponse, e: unknown) {
  if (e instanceof PhoneDockError) {
    // input routes: how far the input got, and whether sending it again is safe (src/daemon/delivery.ts)
    const dl = e.delivery ? { delivery: e.delivery, retrySafe: e.delivery === 'not_sent' } : {};
    sendJson(res, e.status || 400, { error: { code: e.code, message: e.message, hints: e.hints, detail: e.detail, ...dl } });
  } else {
    const err = e as Error;
    sendJson(res, 500, { error: { code: 'internal', message: 'Something went wrong', detail: err?.stack ?? err?.message ?? String(e) } });
  }
}

/** Marker: handler already wrote the response. */
export const HANDLED = Symbol('handled');

export class Raw { status: number; body: Buffer | string; headers: Record<string, string | number>;
  constructor(status: number, body: Buffer | string, headers: Record<string, string | number>) { this.status = status; this.body = body; this.headers = headers; } }

export const notSupported = (what: string, backend: string, hints?: string[]) =>
  new PhoneDockError('This operation is not supported', 'not_supported', 501, undefined,
    [`${backend} does not support ${what}`, ...(hints ?? ["GET /v1/backends shows each backend's capabilities"])].join('\n'));
export const badRequest = (msg: string, hints?: string[]) => new PhoneDockError('The request is invalid', 'bad_request', 400, undefined, [msg, ...(hints ?? [])].join('\n'));
