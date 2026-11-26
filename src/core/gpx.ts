// Zero-dependency GPX route parser, bounded file reader, and geodesic distance helper.
import { readFileSync, statSync } from 'node:fs';
import { PhoneDockError } from './types.ts';

export interface GeoPoint {
  lat: number;
  lon: number;
  ele?: number;
  name?: string;
}

export interface ParsedGpx {
  name?: string;
  points: GeoPoint[];
}

export const MAX_GPX_BYTES = 5 * 1024 * 1024;
export const MAX_GPX_POINTS = 10_000;

/** Read a local regular GPX file with a size check BEFORE allocating memory. */
export function readBoundedGpxFile(filePath: string): string {
  let st;
  try { st = statSync(filePath); } catch {
    throw new PhoneDockError(`GPX file not found: ${filePath}`, 'not_found', 404);
  }
  if (!st.isFile()) {
    throw new PhoneDockError(`GPX path is not a regular file: ${filePath}`, 'bad_request', 400);
  }
  if (st.size > MAX_GPX_BYTES) {
    throw new PhoneDockError(`GPX file is too large (max ${Math.round(MAX_GPX_BYTES / (1024 * 1024))} MB)`, 'bad_request', 400);
  }
  return readFileSync(filePath, 'utf8');
}

function readAttr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs);
  return m ? (m[1] ?? m[2]) : undefined;
}

export function validateCoord(lat: unknown, lon: unknown): { lat: number; lon: number } {
  const la = Number(lat), lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo) || la < -90 || la > 90 || lo < -180 || lo > 180) {
    throw new PhoneDockError('Coordinates must have lat in [-90, 90] and lon in [-180, 180]', 'bad_request', 400);
  }
  return { lat: la, lon: lo };
}

function extractText(body: string, tag: string): string | undefined {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const lower = body.toLowerCase();
  const i = lower.indexOf(open);
  if (i < 0) return undefined;
  const j = lower.indexOf(close, i + open.length);
  if (j < 0) return undefined;
  let inner = body.slice(i + open.length, j).trim();
  if (inner.startsWith('<![CDATA[') && inner.endsWith(']]>')) {
    inner = inner.slice(9, -3).trim();
  }
  return inner || undefined;
}

/** Single-pass GPX 1.0/1.1 parser (<trkpt>, <rtept>, or <wpt>). Rejects files exceeding MAX_GPX_POINTS. */
export function parseGpx(xml: string): ParsedGpx {
  if (typeof xml !== 'string' || !xml.trim()) {
    throw new PhoneDockError('GPX content is empty', 'bad_request', 400);
  }
  if (Buffer.byteLength(xml, 'utf8') > MAX_GPX_BYTES) {
    throw new PhoneDockError('GPX file is too large (max 5 MB)', 'bad_request', 400);
  }

  let routeName: string | undefined;
  const trkpt: GeoPoint[] = [];
  const rtept: GeoPoint[] = [];
  const wpt: GeoPoint[] = [];

  const lower = xml.toLowerCase();
  // Capture first <name> inside <trk>, <rte>, or <metadata> without backtracking.
  for (const container of ['trk', 'rte', 'metadata']) {
    const cStart = lower.indexOf(`<${container}`);
    if (cStart < 0) continue;
    const cTagEnd = lower.indexOf('>', cStart);
    if (cTagEnd < 0) continue;
    const windowEnd = Math.min(xml.length, cTagEnd + 2048);
    const slice = xml.slice(cTagEnd + 1, windowEnd);
    const ptIdx = slice.toLowerCase().search(/<(?:trkpt|rtept|wpt|trkseg)\b/);
    const head = ptIdx >= 0 ? slice.slice(0, ptIdx) : slice;
    const n = extractText(head, 'name');
    if (n) { routeName = n.slice(0, 120); break; }
  }

  let pos = 0;
  const len = xml.length;
  while (pos < len) {
    const lt = xml.indexOf('<', pos);
    if (lt < 0) break;
    let tag: 'trkpt' | 'rtept' | 'wpt' | undefined;
    const next = lower.slice(lt + 1, lt + 7);
    if (next.startsWith('trkpt') && /[\s/>]/.test(lower[lt + 6] ?? '')) tag = 'trkpt';
    else if (next.startsWith('rtept') && /[\s/>]/.test(lower[lt + 6] ?? '')) tag = 'rtept';
    else if (next.startsWith('wpt') && /[\s/>]/.test(lower[lt + 4] ?? '')) tag = 'wpt';

    if (!tag) {
      pos = lt + 1;
      continue;
    }

    const gt = xml.indexOf('>', lt + tag.length + 1);
    if (gt < 0) break;
    const selfClosing = xml[gt - 1] === '/';
    const attrs = xml.slice(lt + tag.length + 1, selfClosing ? gt - 1 : gt);
    let body = '';
    if (selfClosing) {
      pos = gt + 1;
    } else {
      const closeTag = `</${tag}>`;
      const endIdx = lower.indexOf(closeTag, gt + 1);
      if (endIdx < 0) {
        pos = gt + 1;
      } else {
        body = xml.slice(gt + 1, endIdx);
        pos = endIdx + closeTag.length;
      }
    }

    const latRaw = readAttr(attrs, 'lat');
    const lonRaw = readAttr(attrs, 'lon');
    if (latRaw === undefined || lonRaw === undefined) continue;
    const { lat, lon } = validateCoord(latRaw, lonRaw);

    const bucket = tag === 'trkpt' ? trkpt : tag === 'rtept' ? rtept : wpt;
    if (bucket.length >= MAX_GPX_POINTS) {
      throw new PhoneDockError(`GPX route exceeds maximum of ${MAX_GPX_POINTS} points`, 'bad_request', 400);
    }
    const eleStr = body ? extractText(body, 'ele') : undefined;
    const ele = eleStr !== undefined ? Number(eleStr) : undefined;
    const ptName = body ? extractText(body, 'name') : undefined;
    bucket.push({
      lat, lon,
      ...(ele !== undefined && Number.isFinite(ele) ? { ele } : {}),
      ...(ptName ? { name: ptName.slice(0, 120) } : {}),
    });
  }

  const chosen = trkpt.length ? trkpt : rtept.length ? rtept : wpt;
  if (!chosen.length) {
    throw new PhoneDockError('No valid <trkpt>, <rtept>, or <wpt> coordinates found in GPX', 'bad_request', 400);
  }
  return { ...(routeName ? { name: routeName } : {}), points: chosen };
}

/** Downsample a large waypoint list while always preserving the first and last points. */
export function downsamplePoints(points: GeoPoint[], maxPoints: number): GeoPoint[] {
  if (points.length <= maxPoints || maxPoints < 2) return points;
  const out: GeoPoint[] = [points[0]];
  const step = (points.length - 1) / (maxPoints - 1);
  for (let i = 1; i < maxPoints - 1; i++) {
    out.push(points[Math.round(i * step)]);
  }
  out.push(points[points.length - 1]);
  return out;
}

/** Great-circle distance in meters between two WGS84 coordinates. */
export function haversineMeters(a: Pick<GeoPoint, 'lat' | 'lon'>, b: Pick<GeoPoint, 'lat' | 'lon'>): number {
  const R = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const lat1 = a.lat * rad;
  const lat2 = b.lat * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
