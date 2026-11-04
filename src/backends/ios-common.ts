// Helpers shared by the iOS backends (and OCR): PNG size, argv splitting, small JSON state files.
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, sleep } from '../core/exec.ts';
import { stateDir, toolEnv, which } from '../core/paths.ts';
import { PhoneDockError } from '../core/types.ts';

/** Width/height from a PNG's IHDR chunk. */
export function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47 || png.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('not a PNG');
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** Split a command string into argv, honouring single/double quotes and backslash escapes. No shell. */
export function splitArgs(cmd: string): string[] {
  const out: string[] = []; let cur = ''; let q: '"' | "'" | null = null; let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += c;
    } else if (c === '"' || c === "'") { q = c; has = true; }
    else if (c === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; has = true; }
    else if (/\s/.test(c)) { if (has || cur) { out.push(cur); cur = ''; has = false; } }
    else { cur += c; has = true; }
  }
  if (has || cur) out.push(cur);
  return out;
}

/** Tiny JSON-file store under stateDir(). */
export class JsonState<T extends object> {
  file: string;
  constructor(name: string) { this.file = join(stateDir(), name); }
  read(): T {
    try { if (existsSync(this.file)) return JSON.parse(readFileSync(this.file, 'utf8')) as T; } catch { /* corrupt → empty */ }
    return {} as T;
  }
  write(v: T): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(v, null, 2));
    renameSync(tmp, this.file);
  }
  update(fn: (v: T) => void): T { const v = this.read(); fn(v); this.write(v); return v; }
}

/** Split a byte stream into JPEG frames (FFD8 … FFD9). Works for raw concatenated JPEGs and MJPEG multipart. */
export class JpegSplitter {
  private buf: Buffer = Buffer.alloc(0);
  private onFrame: (jpeg: Buffer) => void;
  constructor(onFrame: (jpeg: Buffer) => void) { this.onFrame = onFrame; }
  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const start = this.buf.indexOf(SOI);
      if (start < 0) { this.buf = this.buf.subarray(Math.max(0, this.buf.length - 1)); return; }
      const end = this.buf.indexOf(EOI, start + 2);
      if (end < 0) { if (start > 0) this.buf = this.buf.subarray(start); if (this.buf.length > 64 * 1024 * 1024) this.buf = Buffer.alloc(0); return; }
      this.onFrame(Buffer.from(this.buf.subarray(start, end + 2)));
      this.buf = this.buf.subarray(end + 2);
    }
  }
}
const SOI = Buffer.from([0xff, 0xd8, 0xff]);
const EOI = Buffer.from([0xff, 0xd9]);

// ── .ips crash reports (iOS 15+ / macOS 12+ format: one JSON header line, then a JSON body) ──

export interface IpsReport {
  header: Record<string, any>;
  body: Record<string, any>;
}

/** Parse an .ips file. Returns undefined for anything that is not header-line + JSON body. */
/** Index just past the top-level JSON object that starts at text[0] (string-aware brace matching). */
function jsonObjectEnd(text: string): number {
  let depth = 0, inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if ((c === '}' || c === ']') && --depth === 0) return i + 1;
  }
  return text.length;
}

export function parseIps(text: string): IpsReport | undefined {
  const nl = text.indexOf('\n');
  if (nl <= 0) return undefined;
  try {
    const header = JSON.parse(text.slice(0, nl));
    const rest = text.slice(nl + 1).trim();
    // Mac-side reports (simulator apps) append a plain-text "System Profile:" section after the JSON body.
    let body: unknown = {};
    if (rest) { try { body = JSON.parse(rest); } catch { body = JSON.parse(rest.slice(0, jsonObjectEnd(rest))); } }
    if (!header || typeof header !== 'object') return undefined;
    return { header, body: body && typeof body === 'object' ? body : {} };
  } catch { return undefined; }
}

/** bug_type → CrashReport.kind. 309/109 = crash, 298 = jetsam; everything else (hangs, analytics …) = other. */
export function ipsKind(bugType: unknown): 'crash' | 'jetsam' | 'other' {
  const b = String(bugType ?? '');
  if (b === '309' || b === '109') return 'crash';
  if (b === '298') return 'jetsam';
  return 'other';
}

/** "2026-11-03 20:25:52.6176 +0530" → ISO string. */
export function ipsTime(s: unknown): string | undefined {
  const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(\.\d+)? ([+-]\d\d)(\d\d)$/.exec(String(s ?? '').trim());
  if (!m) return undefined;
  const frac = m[3] ? m[3].slice(0, 4).padEnd(4, '0') : '.000';
  const d = new Date(`${m[1]}T${m[2]}${frac}${m[4]}:${m[5]}`);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

function frameText(f: any, images: any[]): string {
  const img = images?.[f?.imageIndex];
  const name = img?.name ?? (img?.path ? String(img.path).split('/').pop() : '???');
  const sym = f?.symbol ? `${f.symbol}${f.symbolLocation !== undefined ? ` + ${f.symbolLocation}` : ''}` : `0x${Number(f?.imageOffset ?? 0).toString(16)}`;
  return `${name}  ${sym}`;
}

/** One-line summary: exception type (signal) [subtype] [app-specific message] @ top frame. */
export function ipsSummary(r: IpsReport): string {
  const b = r.body; const parts: string[] = [];
  const ex = b.exception;
  if (ex?.type) parts.push(`${ex.type}${ex.signal ? ` (${ex.signal})` : ''}${ex.subtype ? ` ${ex.subtype}` : ''}`);
  else if (b.termination?.indicator) parts.push(String(b.termination.indicator));
  else if (r.header.bug_type === '298' || b.largestProcess) parts.push(`Jetsam${b.largestProcess ? ` (largest: ${b.largestProcess})` : ''}`);
  const asi = b.asi && typeof b.asi === 'object' ? Object.values(b.asi).flat().find((v) => typeof v === 'string') as string | undefined : undefined;
  if (asi) parts.push(asi.replace(/\s+/g, ' ').slice(0, 160));
  else if (b.termination?.indicator && ex?.type) parts.push(String(b.termination.indicator));
  const th = Array.isArray(b.threads) ? b.threads[b.faultingThread ?? 0] : undefined;
  const images: any[] = b.usedImages ?? [];
  if (th?.frames?.length) {
    const top = frameText(th.frames[0], images);
    // Prefer the first frame inside the app's own binary when it is not the top frame.
    // (Xcode debug builds put the code in <App>.app/<App>.debug.dylib, so anything inside the .app counts.)
    const appDir = typeof b.procPath === 'string' && b.procPath.includes('.app/') ? b.procPath.slice(0, b.procPath.lastIndexOf('.app/') + 5) : undefined;
    const own = th.frames.find((f: any) => {
      const p = images[f.imageIndex]?.path;
      return typeof p === 'string' && (p === b.procPath || (appDir !== undefined && p.startsWith(appDir)));
    });
    parts.push(`@ ${top}${own && own !== th.frames[0] ? ` … ${frameText(own, images)}` : ''}`);
  }
  return parts.join(' · ').slice(0, 400) || `bug_type ${r.header.bug_type ?? '?'}`;
}

/** "2026-11-04 10:12:33 +01:00"-style local time (this Mac's zone) for an ISO or IPS timestamp; the input if unparseable. */
export function localTime(t: unknown): string {
  const iso = ipsTime(t) ?? String(t ?? '');
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return String(t ?? '');
  const p = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset(); const a = Math.abs(off);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${off < 0 ? '-' : '+'}${p(Math.floor(a / 60))}:${p(a % 60)}`;
}

/** Human-readable rendering of a crash report (header, exception, crashed thread, other threads, images). */
export function ipsRender(r: IpsReport, maxFramesOther = 12): string {
  const h = r.header, b = r.body; const out: string[] = [];
  const add = (k: string, v: unknown) => { if (v !== undefined && v !== null && v !== '') out.push(`${k.padEnd(20)}${typeof v === 'string' ? v : JSON.stringify(v)}`); };
  add('Process:', `${b.procName ?? h.app_name ?? '?'}${b.pid !== undefined ? ` [${b.pid}]` : ''}`);
  add('Path:', b.procPath);
  add('Identifier:', h.bundleID ?? b.bundleInfo?.CFBundleIdentifier);
  add('Version:', h.app_version ? `${h.app_version}${h.build_version ? ` (${h.build_version})` : ''}` : undefined);
  add('Parent Process:', b.parentProc);
  add('Coalition:', b.coalitionName);
  add('Date/Time:', localTime(b.captureTime ?? h.timestamp) || undefined);
  add('OS Version:', h.os_version ?? b.osVersion?.train);
  add('Hardware Model:', b.modelCode);
  add('Bug Type:', h.bug_type);
  add('Incident:', h.incident_id ?? b.incident);
  out.push('');
  if (b.exception) {
    add('Exception Type:', `${b.exception.type ?? '?'}${b.exception.signal ? ` (${b.exception.signal})` : ''}`);
    add('Exception Subtype:', b.exception.subtype);
    add('Exception Codes:', b.exception.codes);
  }
  if (b.termination) add('Termination:', `${b.termination.namespace ?? ''} ${b.termination.code ?? ''} ${b.termination.indicator ?? ''}${b.termination.byProc ? ` (by ${b.termination.byProc})` : ''}`.trim());
  if (b.termination?.details) add('Termination Details:', b.termination.details);
  if (b.asi) { out.push('', 'Application Specific Information:'); for (const [k, v] of Object.entries(b.asi)) out.push(`  ${k}: ${Array.isArray(v) ? v.join('\n    ') : String(v)}`); }
  const images: any[] = b.usedImages ?? [];
  if (Array.isArray(b.lastExceptionBacktrace) && b.lastExceptionBacktrace.length) {
    out.push('', 'Last Exception Backtrace:');
    b.lastExceptionBacktrace.forEach((f: any, i: number) => out.push(`${String(i).padEnd(4)}${frameText(f, images)}`));
  }
  const threads: any[] = Array.isArray(b.threads) ? b.threads : [];
  const ft = b.faultingThread ?? threads.findIndex((t) => t.triggered);
  const order = threads.map((_, i) => i).sort((a, c) => (a === ft ? -1 : c === ft ? 1 : a - c));
  for (const i of order) {
    const t = threads[i];
    const label = `Thread ${i}${i === ft ? ' Crashed' : ''}${t.name ? ` (${t.name})` : ''}${t.queue ? `  Dispatch queue: ${t.queue}` : ''}:`;
    out.push('', label);
    const frames: any[] = t.frames ?? [];
    const lim = i === ft ? frames.length : Math.min(frames.length, maxFramesOther);
    for (let k = 0; k < lim; k++) out.push(`${String(k).padEnd(4)}${frameText(frames[k], images)}`);
    if (lim < frames.length) out.push(`    … ${frames.length - lim} more frames`);
  }
  if (!threads.length && b.largestProcess) {
    // jetsam / other non-crash reports: show the interesting top-level fields raw
    out.push('', JSON.stringify({ largestProcess: b.largestProcess, memoryStatus: b.memoryStatus, processes: (b.processes ?? []).slice(0, 30) }, null, 2));
  }
  if (images.length) {
    out.push('', 'Binary Images:');
    for (const im of images) out.push(`  0x${Number(im.base ?? 0).toString(16)}  ${im.name ?? '???'}  ${im.arch ?? ''}  <${im.uuid ?? ''}>  ${im.path ?? ''}`);
  }
  if (!threads.length && !b.largestProcess && Object.keys(b).length) out.push('', JSON.stringify(b, null, 2).slice(0, 200_000));
  return out.join('\n');
}

// ── video helpers ──────────────────────────────────────────────────────────

export function ffmpegBin(): string | undefined { return which('ffmpeg'); }

/** ffprobe a file: container format, first video codec, duration (s). undefined when ffprobe is missing/fails. */
export async function probeVideo(file: string): Promise<{ format?: string; codec?: string; duration?: number; width?: number; height?: number } | undefined> {
  const fp = which('ffprobe'); if (!fp) return undefined;
  const r = await run(fp, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'format=format_name,duration:stream=codec_name,width,height', '-of', 'json', file], { allowFail: true, timeoutMs: 30_000 });
  if (r.code !== 0) return undefined;
  try {
    const j = JSON.parse(r.stdout);
    const st = j.streams?.[0] ?? {};
    return { format: j.format?.format_name, codec: st.codec_name, duration: j.format?.duration ? Number(j.format.duration) : undefined, width: st.width, height: st.height };
  } catch { return undefined; }
}

/** Hold the last frame until `seconds`, re-encoding `src` into `dest`. For recorders that write a frame only when the
 *  screen changes (Android's screenrecord): a still screen gives a one-frame file with no duration, and ffmpeg drops
 *  that lone frame on remux (its sample is flagged discard), so a single-frame H.264 file is decoded from Annex B. */
async function holdLastFrame(ff: string, src: string, dest: string, seconds: number, duration: number | undefined): Promise<boolean> {
  const tmp = `${dest}.pd-tmp.mp4`;
  let input = src; let raw: string | undefined;
  if (!(duration && duration > 0)) {
    raw = `${dest}.pd-raw.h264`;
    const x = await run(ff, ['-v', 'error', '-y', '-i', src, '-c:v', 'copy', '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', raw], { allowFail: true, timeoutMs: 120_000, env: toolEnv() });
    if (x.code !== 0) { rmSync(raw, { force: true }); return false; }
    input = raw;
  }
  const pad = Math.max(0.5, seconds - (duration ?? 0) + 0.5).toFixed(2);
  const vf = `fps=30,tpad=stop_mode=clone:stop_duration=${pad},scale=trunc(iw/2)*2:trunc(ih/2)*2`;
  const head = ['-v', 'error', '-y', ...(raw ? ['-f', 'h264'] : []), '-i', input, '-an', '-vf', vf, '-t', seconds.toFixed(2)];
  let r = await run(ff, [...head, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tmp], { allowFail: true, timeoutMs: 600_000, env: toolEnv() });
  if (r.code !== 0) r = await run(ff, [...head, '-c:v', 'h264_videotoolbox', '-b:v', '6M', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tmp], { allowFail: true, timeoutMs: 600_000, env: toolEnv() });
  if (raw) rmSync(raw, { force: true });
  if (r.code !== 0) { rmSync(tmp, { force: true }); return false; }
  const out = await probeVideo(tmp);
  if (!(out?.duration && out.duration > 0)) { rmSync(tmp, { force: true }); return false; }
  renameSync(tmp, dest);
  return true;
}

/** Make `src` a faststart .mp4 at `dest`: remux (copy) when it is already H.264, else transcode. Removes `src`.
 *  `minSeconds`: how long the recording really ran; a shorter file (a still screen) has its last frame held until then. */
export async function finalizeMp4(src: string, dest: string, opts: { minSeconds?: number } = {}): Promise<void> {
  const ff = ffmpegBin();
  const info = await probeVideo(src);
  const want = opts.minSeconds;
  if (ff && want && want >= 1.5 && info?.codec === 'h264' && !(info.duration && info.duration >= want - 1)) {
    if (await holdLastFrame(ff, src, dest, want, info.duration)) { rmSync(src, { force: true }); return; }
  }
  if (!ff) {
    if (info && info.codec !== 'h264' && info.codec !== 'hevc') throw new PhoneDockError('The recording cannot be converted without ffmpeg', 'ffmpeg_missing', 501, ['Install ffmpeg and try again.'], 'Install ffmpeg with: brew install ffmpeg');
    renameSync(src, dest); return;
  }
  const tmp = `${dest}.pd-tmp.mp4`;
  const copy = info?.codec === 'h264' || info?.codec === 'hevc';
  const args = ['-v', 'error', '-y', '-i', src, '-an', ...(copy ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2']), '-movflags', '+faststart', tmp];
  let r = await run(ff, args, { allowFail: true, timeoutMs: 600_000, env: toolEnv() });
  if (r.code !== 0 && !copy) {
    // libx264 missing in this ffmpeg build → VideoToolbox
    r = await run(ff, ['-v', 'error', '-y', '-i', src, '-an', '-c:v', 'h264_videotoolbox', '-b:v', '6M', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-movflags', '+faststart', tmp], { allowFail: true, timeoutMs: 600_000, env: toolEnv() });
  }
  if (r.code !== 0) { rmSync(tmp, { force: true }); throw new PhoneDockError('Couldn’t finalize the recording', 'record_failed', 500, undefined, `ffmpeg could not finalize the recording: ${r.stderr.trim().slice(-600)}`); }
  renameSync(tmp, dest);
  rmSync(src, { force: true });
}

/** Fallback recorder for devices without a native screen recorder: grabs screenshots in a loop and encodes them
 *  (variable frame rate, each frame shown until the next one arrived) into an H.264 .mp4 with ffmpeg. */
export class ScreenshotRecorder {
  readonly dir: string;
  readonly startedAt = Date.now();
  private frames: { file: string; at: number }[] = [];
  private stopped = false;
  private loop: Promise<void>;
  private lastErr?: string;
  constructor(shot: () => Promise<Buffer>, maxSeconds: number, minIntervalMs = 100) {
    if (!ffmpegBin()) throw new PhoneDockError('Recording this device requires ffmpeg', 'ffmpeg_missing', 501, ['Install ffmpeg and try again.'], 'The screenshot-based recorder requires ffmpeg. Install it with: brew install ffmpeg');
    const dir = mkdtempSync(join(tmpdir(), 'pd-shotrec-'));
    this.dir = dir;
    const deadline = this.startedAt + maxSeconds * 1000;
    this.loop = (async () => {
      while (!this.stopped && Date.now() < deadline) {
        const t0 = Date.now();
        try {
          const png = await shot();
          if (this.stopped && this.frames.length) break;
          const file = join(dir, `f${String(this.frames.length).padStart(6, '0')}.png`);
          writeFileSync(file, png);
          this.frames.push({ file, at: t0 });
        } catch (e) { this.lastErr = (e as Error).message; await sleep(500); }
        const wait = minIntervalMs - (Date.now() - t0);
        if (wait > 0) await sleep(wait);
      }
    })();
  }
  get frameCount(): number { return this.frames.length; }
  /** Stop grabbing and encode to `outPath`. */
  async finish(outPath: string): Promise<string> {
    this.stopped = true;
    await this.loop;
    try {
      if (!this.frames.length) throw new PhoneDockError("The recording captured no frames", 'record_failed', 502, undefined, `Recording captured no frames${this.lastErr ? `: ${this.lastErr}` : ''}`);
      const end = Date.now();
      const lines = ['ffconcat version 1.0'];
      this.frames.forEach((f, i) => {
        const next = this.frames[i + 1]?.at ?? end;
        lines.push(`file '${f.file.replace(/'/g, "'\\''")}'`, `duration ${Math.max(0.04, (next - f.at) / 1000).toFixed(3)}`);
      });
      lines.push(`file '${this.frames[this.frames.length - 1].file.replace(/'/g, "'\\''")}'`);
      const list = join(this.dir, 'list.ffconcat');
      writeFileSync(list, lines.join('\n') + '\n');
      const tmp = `${outPath}.pd-tmp.mp4`;
      const r = await run(ffmpegBin()!, ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
        '-fps_mode', 'vfr', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-movflags', '+faststart', tmp], { allowFail: true, timeoutMs: 600_000, env: toolEnv() });
      if (r.code !== 0) { rmSync(tmp, { force: true }); throw new PhoneDockError('Couldn’t encode the recording', 'record_failed', 500, undefined, `ffmpeg failed to encode the recording: ${r.stderr.trim().slice(-600)}`); }
      renameSync(tmp, outPath);
      return outPath;
    } finally { rmSync(this.dir, { recursive: true, force: true }); }
  }
  /** Abort without writing anything. */
  async cancel(): Promise<void> { this.stopped = true; await this.loop.catch(() => undefined); rmSync(this.dir, { recursive: true, force: true }); }
}
