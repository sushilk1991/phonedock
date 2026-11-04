// OCR fallback for visual control when accessibility is missing. Uses Apple Vision through a tiny
// Swift helper (tools/pd-ocr.swift) compiled once into stateDir('bin')/pd-ocr-<source hash>.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './exec.ts';
import { stateDir, toolEnv } from './paths.ts';
import { PhoneDockError, type UiElement, type UiTree } from './types.ts';

interface OcrItem { text: string; confidence: number; x: number; y: number; width: number; height: number }

function helperSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const res = process.env.PHONEDOCK_BUNDLE_RESOURCES;
  const cands = [
    process.env.PHONEDOCK_OCR_SRC,
    resolve(here, '..', '..', 'tools', 'pd-ocr.swift'),     // repo: src/core
    resolve(here, '..', 'tools', 'pd-ocr.swift'),           // app bundle: Resources/{daemon,tools}
    res ? join(res, 'tools', 'pd-ocr.swift') : undefined,
    resolve(process.cwd(), 'tools', 'pd-ocr.swift'),
  ];
  const f = cands.find((c) => c && existsSync(c));
  if (!f) throw new PhoneDockError('Text recognition is unavailable', 'ocr_unavailable', 500, undefined, 'OCR helper source tools/pd-ocr.swift not found. Set PHONEDOCK_OCR_SRC to the path of pd-ocr.swift.');
  return f;
}

/** Helpers already built in the state dir, newest first (pd-ocr-<hash>, and the legacy pd-ocr). */
function builtHelpers(): string[] {
  const dir = stateDir('bin');
  try {
    return readdirSync(dir).filter((n) => /^pd-ocr(-[0-9a-f]{12})?$/.test(n)).map((n) => join(dir, n))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  } catch { return []; }
}

let building: Promise<string> | undefined;
let ready: string | undefined;

/** Path to the compiled helper. The binary is named after the source's content hash, so every checkout (worktrees,
 *  the app bundle) with the same source shares one build: a fresh checkout's newer mtime no longer forces a slow
 *  rebuild on the first OCR fallback. When swiftc fails, an older build is used rather than no OCR at all. */
export async function ocrHelper(): Promise<string> {
  if (ready && existsSync(ready)) return ready;
  let src: string;
  try { src = helperSource(); } catch (e) { const old = builtHelpers()[0]; if (old) return (ready = old); throw e; }
  const hash = createHash('sha256').update(readFileSync(src)).digest('hex').slice(0, 12);
  const bin = join(stateDir('bin'), `pd-ocr-${hash}`);
  if (existsSync(bin)) return (ready = bin);
  building ??= (async () => {
    const tmp = `${bin}.${process.pid}.tmp`;
    try {
      await run('xcrun', ['swiftc', '-O', '-o', tmp, src], { env: toolEnv(), timeoutMs: 300_000 });
      await run('mv', ['-f', tmp, bin]);
      return (ready = bin);
    } catch (e) {
      const old = builtHelpers()[0];
      if (old) { console.error(`[ocr] building ${bin} failed (${(e as Error).message.split('\n')[0]}); using ${old}`); return (ready = old); }
      throw new PhoneDockError("Couldn’t prepare text recognition", 'ocr_unavailable', 500, ["Install Xcode and try again."], [`Failed to compile OCR helper: ${(e as Error).message}`, e instanceof PhoneDockError ? e.detail : undefined, 'Needs Xcode (swiftc) at /Applications/Xcode.app'].filter(Boolean).join('\n'));
    }
  })().finally(() => { building = undefined; });
  return building;
}

let warming = false;
/** Build the helper in the background (once per process) so the first OCR fallback doesn't wait for swiftc. */
export function warmOcr(): void {
  if (warming || ready || process.platform !== 'darwin') return;
  warming = true;
  ocrHelper().catch((e) => { console.error(`[ocr] warm-up failed: ${(e as Error).message}`); }).finally(() => { warming = false; });
}

function pngDims(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) throw new PhoneDockError('The image must be a PNG', 'bad_request', 400);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** Raw OCR results (pixels, top-left origin). */
export async function ocrText(png: Buffer, opts: { fast?: boolean } = {}): Promise<OcrItem[]> {
  const bin = await ocrHelper();
  const dir = mkdtempSync(join(tmpdir(), 'pd-ocr-'));
  const file = join(dir, 'in.png');
  try {
    writeFileSync(file, png);
    const r = await run(bin, opts.fast ? [file, '--fast'] : [file], { timeoutMs: 180_000 });
    return JSON.parse(r.stdout) as OcrItem[];
  } finally {
    try { unlinkSync(file); rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** OCR a screenshot into a flat UiTree of Text elements (bounds in screenshot pixels). */
export async function ocrUiTree(png: Buffer, opts: { fast?: boolean; minConfidence?: number } = {}): Promise<UiTree> {
  const { width, height } = pngDims(png);
  const items = await ocrText(png, opts);
  const min = opts.minConfidence ?? 0.3;
  const root: UiElement[] = items
    .filter((i) => i.text.trim() && i.confidence >= min)
    .sort((a, b) => (a.y - b.y) || (a.x - b.x))
    .map((i, n) => ({
      ref: `e${n + 1}`, type: 'Text', text: i.text, label: i.text,
      bounds: { x: i.x, y: i.y, width: i.width, height: i.height },
      clickable: true, enabled: true,
    }));
  return { source: 'ocr', screen: { width, height }, root, capturedAt: new Date().toISOString() };
}
