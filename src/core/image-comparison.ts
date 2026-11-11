// Shared visual assertion engine. No thumbnail or missing-tool fallback may turn an assertion into a pass.
import { runBuffer } from './exec.ts';
import { which } from './paths.ts';

export interface ImageRegion { x: number; y: number; width: number; height: number }
export interface ImageComparisonOptions {
  /** pixel compares full-resolution RGBA; thumbnail preserves the old 64px grayscale comparison. */
  mode?: 'pixel' | 'thumbnail';
  /** A pixel differs when any channel differs by more than this value (default 16, range 0–255). */
  pixelThreshold?: number;
  /** Regions in full-resolution screenshot pixels, excluded from numerator and denominator. */
  ignore?: ImageRegion[];
}

function dimensions(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Visual comparison requires valid PNG images');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  if (!width || !height || width * height > 16_777_216) throw new Error('Visual comparison image dimensions exceed the 16 megapixel limit');
  return { width, height };
}

/** Fraction of non-ignored pixels that differ. Dimension changes and unavailable decoding fail explicitly. */
export async function compareImages(a: Buffer, b: Buffer, o: ImageComparisonOptions = {}): Promise<number> {
  const sa = dimensions(a), sb = dimensions(b);
  if (sa.width !== sb.width || sa.height !== sb.height) throw new Error(`Baseline dimensions differ: ${sa.width}x${sa.height}, screen ${sb.width}x${sb.height}`);
  if (o.mode !== undefined && o.mode !== 'pixel' && o.mode !== 'thumbnail') throw new Error('Image comparison mode must be pixel or thumbnail');
  const threshold = o.pixelThreshold ?? 16;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 255) throw new Error('pixelThreshold must be between 0 and 255');
  const regions = o.ignore ?? [];
  for (const r of regions) if (![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width < 0 || r.height < 0) throw new Error('Ignored image regions require finite x, y, width and height, with non-negative sizes');
  const ff = which('ffmpeg');
  if (!ff) throw new Error('Visual comparison requires ffmpeg; install it before running baseline assertions');
  const thumb = o.mode === 'thumbnail';
  const width = thumb ? Math.min(64, sa.width) : sa.width;
  const height = thumb ? Math.max(1, Math.round(sa.height * width / sa.width)) : sa.height;
  const channels = thumb ? 1 : 4;
  const decode = async (png: Buffer) => {
    const args = ['-v', 'error', '-f', 'png_pipe', '-i', 'pipe:0', ...(thumb ? ['-vf', `scale=${width}:${height}:flags=area`] : []), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', thumb ? 'gray' : 'rgba', 'pipe:1'];
    const r = await runBuffer(ff, args, { input: png, timeoutMs: 20_000, maxBuffer: width * height * channels + 1024, failureMessage: 'Couldn’t decode an image for visual comparison' });
    if (r.stdout.length !== width * height * channels) throw new Error('Image decoder returned incomplete pixel data');
    return r.stdout;
  };
  const [pa, pb] = await Promise.all([decode(a), decode(b)]);
  let compared = 0, changed = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const px = (x + 0.5) * sa.width / width, py = (y + 0.5) * sa.height / height;
    if (regions.some((r) => px >= r.x && px < r.x + r.width && py >= r.y && py < r.y + r.height)) continue;
    compared++;
    const i = (y * width + x) * channels;
    for (let c = 0; c < channels; c++) if (Math.abs(pa[i + c] - pb[i + c]) > threshold) { changed++; break; }
  }
  if (!compared) throw new Error('Visual comparison has no pixels left after ignored regions');
  return changed / compared;
}
