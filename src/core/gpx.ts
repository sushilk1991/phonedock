// Zero-dependency GPX route parser and geodesic distance helper for GPS route playback.
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

const MAX_GPX_BYTES = 5 * 1024 * 1024;
const MAX_POINTS = 10_000;

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

/** Parse standard GPX 1.0/1.1 XML (<trkpt>, <rtept>, or <wpt> elements). */
export function parseGpx(xml: string): ParsedGpx {
  if (typeof xml !== 'string' || !xml.trim()) {
    throw new PhoneDockError('GPX content is empty', 'bad_request', 400);
  }
  if (Buffer.byteLength(xml, 'utf8') > MAX_GPX_BYTES) {
    throw new PhoneDockError('GPX file is too large (max 5 MB)', 'bad_request', 400);
  }
  const trackName = /<(?:trk|rte|metadata)\b[^>]*>[\s\S]*?<name>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]+))\s*<\/name>/i.exec(xml);
  const name = (trackName?.[1] ?? trackName?.[2])?.trim() || undefined;

  const extractTag = (tag: 'trkpt' | 'rtept' | 'wpt'): GeoPoint[] => {
    const out: GeoPoint[] = [];
    const re = new RegExp(`<${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tag}>)`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      if (out.length >= MAX_POINTS) break;
      const latRaw = readAttr(m[1], 'lat');
      const lonRaw = readAttr(m[1], 'lon');
      if (latRaw === undefined || lonRaw === undefined) continue;
      const { lat, lon } = validateCoord(latRaw, lonRaw);
      const body = m[2] ?? '';
      const eleM = /<ele>\s*([-+]?\d+(?:\.\d+)?)\s*<\/ele>/i.exec(body);
      const ptNameM = /<name>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]+))\s*<\/name>/i.exec(body);
      const ele = eleM ? Number(eleM[1]) : undefined;
      const ptName = (ptNameM?.[1] ?? ptNameM?.[2])?.trim() || undefined;
      out.push({ lat, lon, ...(ele !== undefined && Number.isFinite(ele) ? { ele } : {}), ...(ptName ? { name: ptName } : {}) });
    }
    return out;
  };

  // Prefer track points, then route points, then waypoints (standard GPX hierarchy).
  const points = extractTag('trkpt');
  const chosen = points.length ? points : extractTag('rtept');
  const final = chosen.length ? chosen : extractTag('wpt');
  if (!final.length) {
    throw new PhoneDockError('No valid <trkpt>, <rtept>, or <wpt> coordinates found in GPX', 'bad_request', 400);
  }
  return { ...(name ? { name } : {}), points: final };
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
