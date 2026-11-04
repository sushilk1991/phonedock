// Generic QEMU backend: "boot any OS image" (Alpine/Debian/postmarketOS/custom builds) as a virtual device.
// aarch64 guests run with HVF (native speed on Apple Silicon); x86_64 guests fall back to TCG (slow).
// Control plane is QMP over a unix socket: screendump for screenshots, input-send-event (usb-tablet, absolute
// axes 0..32767) for touch, send-key (qcodes) for typing, HMP savevm/loadvm for snapshots.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, readdirSync, rmSync, openSync, closeSync, statSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, isAbsolute, resolve as resolvePath, basename } from 'node:path';
import type { Backend, Device, DeviceSpec, OsImage, HardwareProfile, Snapshot, ScreenInfo, Availability, BootOptions, Capability, KeyName } from '../core/types.ts';
import { PhoneDockError } from '../core/types.ts';
import { run, sleep, waitFor } from '../core/exec.ts';
import { stateDir, which, toolEnv } from '../core/paths.ts';
import { qmp, qmpBatch, hmp, type QmpCommand } from './qmp.ts';

const ID = 'qemu';
const CAPS: Capability[] = ['boot', 'shutdown', 'delete', 'clone', 'snapshot', 'screenshot', 'tap', 'longPress', 'swipe', 'type', 'key', 'logs', 'window'];
const ABS_MAX = 0x7fff;

type Arch = 'aarch64' | 'x86_64';

interface VmSpec {
  name: string;
  arch: Arch;
  platform: 'linux' | 'other';
  imageId?: string;
  imageName?: string;
  iso?: string;          // attached as cdrom
  baseDisk?: string;     // backing file of disk.qcow2 (linked clone)
  cpus: number;
  ramMB: number;
  storageMB: number;
  width: number;
  height: number;
  network: 'nat' | 'none';
  createdAt: string;
  extraArgs?: string[];  // options.qemuArgs (advanced)
}

// ── image catalog ───────────────────────────────────────────────────────────
interface CatalogEntry {
  id: string; name: string; version?: string; arch: Arch; kind: 'iso' | 'disk';
  sizeMB?: number; notes?: string; sha256?: string;
  url: string | (() => Promise<string>);
  file: string;          // final filename in the cache (after decompression)
}

const PMOS_REL = 'v26.06';
async function latestPmos(ui: string): Promise<string> {
  // images.postmarketos.org/bpo/<rel>/generic-x86_64/<ui>/<YYYYMMDD-HHMM>/<...>.img.xz
  const base = `https://images.postmarketos.org/bpo/${PMOS_REL}/generic-x86_64/${ui}/`;
  const html = (await run('curl', ['-fsSL', '--max-time', '30', base])).stdout;
  const dirs = [...html.matchAll(/href="(\d{8}-\d{4})\/"/g)].map((m) => m[1]).sort().reverse();
  if (!dirs.length) throw new PhoneDockError('The postmarketOS image is unavailable', 'image_unavailable', 502, undefined, `No postmarketOS ${ui} builds listed at ${base}`);
  const listing = (await run('curl', ['-fsSL', '--max-time', '30', base + dirs[0] + '/'])).stdout;
  const img = [...listing.matchAll(/href="([^"]+\.img\.xz)"/g)].map((m) => m[1])[0];
  if (!img) throw new PhoneDockError('The postmarketOS image is unavailable', 'image_unavailable', 502, undefined, `No .img.xz in ${base}${dirs[0]}/`);
  return base + dirs[0] + '/' + img;
}

const CATALOG: CatalogEntry[] = [
  {
    id: 'alpine-virt-aarch64', name: 'Alpine Linux 3.24 "virt" · aarch64 · live ISO (console)', version: '3.24.3', arch: 'aarch64', kind: 'iso',
    url: 'https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/aarch64/alpine-virt-3.24.3-aarch64.iso',
    sha256: 'e34603080e942e9ebc670689eee77dd7a6551c823a6ff5a299e308ded268098f',
    file: 'alpine-virt-3.24.3-aarch64.iso', sizeMB: 89,
    notes: 'Small, boots in seconds with HVF. Login: root (no password). Text console only. The ISO runs two gettys on the visible VT (tty1 + console) which split keystrokes: send key "ctrl+alt+f2" and log in on tty2.',
  },
  {
    id: 'pmos-phosh-x86_64', name: `postmarketOS ${PMOS_REL} · Phosh (phone UI) · generic-x86_64 disk image`, version: PMOS_REL, arch: 'x86_64', kind: 'disk',
    url: () => latestPmos('phosh'), file: `pmos-${PMOS_REL}-phosh-generic-x86_64.img`, sizeMB: 1640,
    notes: 'Mobile Linux with a touch UI. postmarketOS publishes no prebuilt qemu-aarch64 images (build with `pmbootstrap init` → qemu-aarch64 to get an HVF-speed image, then pass options.diskPath). This x86_64 image runs under TCG emulation: expect slow boots. ~1.7 GB download.',
  },
  {
    id: 'pmos-plasma-mobile-x86_64', name: `postmarketOS ${PMOS_REL} · Plasma Mobile · generic-x86_64 disk image`, version: PMOS_REL, arch: 'x86_64', kind: 'disk',
    url: () => latestPmos('plasma-mobile'), file: `pmos-${PMOS_REL}-plasma-mobile-generic-x86_64.img`,
    notes: 'Like pmos-phosh-x86_64 but with KDE Plasma Mobile. TCG emulation (slow).',
  },
];

const imagesDir = () => stateDir('qemu-images');
const vmRoot = () => stateDir('qemu');
const vmDir = (name: string) => join(vmRoot(), name);

// ── host tools ──────────────────────────────────────────────────────────────
function qemuBin(arch: Arch): string | undefined { return which(`qemu-system-${arch}`); }
function qemuImg(): string | undefined { return which('qemu-img'); }
function firmwareDir(): string | undefined {
  const qb = qemuBin('aarch64');
  const cands = ['/opt/homebrew/share/qemu', '/usr/local/share/qemu', qb ? resolvePath(qb, '..', '..', 'share', 'qemu') : ''];
  return cands.find((d) => d && existsSync(join(d, 'edk2-aarch64-code.fd')));
}
function firmware(arch: Arch): { code: string; varsTemplate?: string } {
  const d = firmwareDir();
  if (!d) throw new PhoneDockError('The virtual device firmware is missing', 'missing_dependency', 500, ['Install QEMU.'], 'QEMU EDK2 firmware not found; brew install qemu');
  return arch === 'aarch64'
    ? { code: join(d, 'edk2-aarch64-code.fd') }
    : { code: join(d, 'edk2-x86_64-code.fd'), varsTemplate: join(d, 'edk2-i386-vars.fd') };
}
function needImg(): string {
  const q = qemuImg(); if (!q) throw new PhoneDockError('The virtual device image tool is missing', 'missing_dependency', 500, ['Install QEMU.'], 'qemu-img not found; brew install qemu'); return q;
}

// ── VM state helpers ────────────────────────────────────────────────────────
function validName(name: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new PhoneDockError('The virtual device name is invalid', 'invalid_name', 400, ['Use letters, digits, periods, underscores, or hyphens.'], `Invalid VM name ${JSON.stringify(name)}; must start with a letter or digit and be at most 64 characters`);
}
function loadSpec(name: string): VmSpec {
  const f = join(vmRoot(), name, 'vm.json');
  if (!/^[A-Za-z0-9._-]+$/.test(name) || !existsSync(f)) throw new PhoneDockError('The virtual device was not found', 'not_found', 404, undefined, `No QEMU VM named ${JSON.stringify(name)}`);
  return JSON.parse(readFileSync(f, 'utf8')) as VmSpec;
}
function saveSpec(s: VmSpec) { writeFileSync(join(vmDir(s.name), 'vm.json'), JSON.stringify(s, null, 2)); }
/** QMP socket path. Unix socket paths are limited to 104 bytes on macOS; fall back to a private /tmp dir. */
function sockPath(name: string): string {
  const p = join(vmDir(name), 'qmp.sock');
  if (Buffer.byteLength(p) < 100) return p;
  const d = join('/tmp', `phonedock-${process.getuid?.() ?? 0}`);
  if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
  const st = statSync(d);
  if (st.uid !== (process.getuid?.() ?? st.uid) || (st.mode & 0o077)) throw new PhoneDockError("The virtual device cannot start safely", 'unsafe_path', 500, undefined, `Unsafe socket dir ${d}`);
  return join(d, createHash('sha1').update(p).digest('hex').slice(0, 16) + '.qmp');
}

function readPid(name: string): number | undefined {
  const f = join(vmRoot(), name, 'pid');
  if (!existsSync(f)) return undefined;
  const pid = Number(readFileSync(f, 'utf8').trim());
  if (!pid) return undefined;
  try { process.kill(pid, 0); return pid; } catch { return undefined; }
}
const isRunning = (name: string) => readPid(name) !== undefined;
function needRunning(name: string) {
  loadSpec(name);
  if (!isRunning(name)) throw new PhoneDockError(`The virtual device "${name}" is not running.`, 'not_running', 409, ['Start the device first.'], `POST /v1/devices/qemu:${name}/boot`);
}

const screenCache = new Map<string, { width: number; height: number }>();
const bootingSet = new Set<string>();

function pngSize(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) throw new PhoneDockError('The screenshot is not a PNG', 'screenshot_failed', 500, undefined, 'screendump did not produce a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function toDevice(s: VmSpec): Device {
  const pid = readPid(s.name);
  const state = pid ? (bootingSet.has(s.name) ? 'booting' : 'running') : 'stopped';
  const sc = screenCache.get(s.name);
  return {
    id: `${ID}:${s.name}`, backend: ID, nativeId: s.name, name: s.name,
    platform: s.platform, kind: 'virtual', state, managed: true,
    osVersion: s.imageName, model: `QEMU ${s.arch === 'aarch64' ? 'virt (aarch64, HVF)' : 'q35 (x86_64, TCG)'}`,
    connection: 'local',
    screen: { width: sc?.width ?? s.width, height: sc?.height ?? s.height, scale: 1 },
    spec: { backend: ID, name: s.name, image: s.imageId, cpus: s.cpus, ramMB: s.ramMB, storageMB: s.storageMB, width: s.width, height: s.height },
    capabilities: CAPS,
    meta: { arch: s.arch, dir: vmDir(s.name), pid, iso: s.iso, baseDisk: s.baseDisk, serialLog: join(vmDir(s.name), 'serial.log') },
  };
}

// ── download helper ─────────────────────────────────────────────────────────
function curlDownload(url: string, out: string, onProgress?: (l: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('curl', ['-fL', '--retry', '3', '-C', '-', '-o', out, url], { stdio: ['ignore', 'ignore', 'pipe'], env: toolEnv() });
    let last = 0; let tail = '';
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString(); tail = (tail + s).slice(-2000);
      const now = Date.now();
      if (onProgress && now - last > 2000) {
        const seg = s.split('\r').map((x) => x.trim()).filter(Boolean).pop();
        if (seg && /^\d/.test(seg)) { onProgress(`download: ${seg.replace(/\s+/g, ' ')}`); last = now; }
      }
    });
    child.on('error', (e) => reject(new PhoneDockError("Couldn’t download the image", 'download_failed', 502, undefined, `curl: ${e.message}`)));
    child.on('close', (code) => code === 0 ? resolve() : reject(new PhoneDockError("Couldn’t download the image", 'download_failed', 502, undefined, `download failed (curl exit ${code}): ${tail.split('\r').pop()?.trim()}`)));
  });
}

// ── QEMU command line ───────────────────────────────────────────────────────
function buildArgs(s: VmSpec, opts: { window?: boolean; loadvm?: string }): string[] {
  const dir = vmDir(s.name);
  const fw = firmware(s.arch);
  const a: string[] = ['-name', s.name];
  if (s.arch === 'aarch64') a.push('-M', 'virt', '-accel', 'hvf', '-cpu', 'host');
  else a.push('-M', 'q35', '-accel', 'tcg,thread=multi', '-cpu', 'max');
  a.push('-smp', String(s.cpus), '-m', String(s.ramMB));
  a.push('-drive', `if=pflash,format=raw,unit=0,readonly=on,file=${fw.code}`);
  a.push('-drive', `if=pflash,format=qcow2,unit=1,file=${join(dir, 'efivars.qcow2')}`);
  a.push('-device', `virtio-gpu-pci,xres=${s.width},yres=${s.height}`);
  a.push('-device', 'qemu-xhci,id=xhci', '-device', 'usb-tablet,bus=xhci.0', '-device', 'usb-kbd,bus=xhci.0');
  if (s.network === 'nat') a.push('-netdev', 'user,id=n0', '-device', 'virtio-net-pci,netdev=n0');
  else a.push('-nic', 'none');
  a.push('-device', 'virtio-scsi-pci,id=scsi0');
  a.push('-drive', `if=none,id=hd0,format=qcow2,file=${join(dir, 'disk.qcow2')}`);
  a.push('-device', `virtio-blk-pci,drive=hd0,bootindex=${s.iso ? 2 : 1}`);
  if (s.iso) {
    a.push('-drive', `if=none,id=cd0,media=cdrom,readonly=on,format=raw,file=${s.iso}`);
    a.push('-device', 'scsi-cd,bus=scsi0.0,drive=cd0,bootindex=1');
  }
  a.push('-device', 'virtio-rng-pci');
  a.push('-display', opts.window ? 'cocoa' : 'none');
  a.push('-monitor', 'none', '-parallel', 'none');
  a.push('-qmp', `unix:${sockPath(s.name)},server=on,wait=off`);
  a.push('-serial', `file:${join(dir, 'serial.log')}`);
  a.push('-pidfile', join(dir, 'pid'));
  if (opts.loadvm) a.push('-loadvm', opts.loadvm);
  if (s.extraArgs?.length) a.push(...s.extraArgs);
  return a;
}

async function startVm(name: string, opts: BootOptions & { loadvm?: string } = {}): Promise<void> {
  const s = loadSpec(name);
  if (isRunning(name)) return;
  const bin = qemuBin(s.arch);
  if (!bin) throw new PhoneDockError('The virtual device software is missing', 'missing_dependency', 500, ['Install QEMU.'], `qemu-system-${s.arch} not found; brew install qemu`);
  if (s.iso && !existsSync(s.iso)) throw new PhoneDockError("Couldn’t find the virtual device image", 'image_missing', 409, undefined, `ISO missing: ${s.iso}`);
  const dir = vmDir(name);
  for (const f of [sockPath(name), join(dir, 'pid')]) { try { unlinkSync(f); } catch {} }
  // Keep previous serial output for debugging but start a fresh log per boot.
  try { if (existsSync(join(dir, 'serial.log'))) renameSync(join(dir, 'serial.log'), join(dir, 'serial.prev.log')); } catch {}
  const logFd = openSync(join(dir, 'qemu.log'), 'w');
  const child = spawn(bin, buildArgs(s, { window: opts.window || opts.headless === false, loadvm: opts.loadvm }), {
    detached: true, stdio: ['ignore', logFd, logFd], env: toolEnv(), cwd: dir,
  });
  closeSync(logFd);
  let exited: number | null | undefined;
  child.on('exit', (c) => { exited = c; });
  child.unref();
  bootingSet.add(name);
  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (exited !== undefined) {
        const log = existsSync(join(dir, 'qemu.log')) ? readFileSync(join(dir, 'qemu.log'), 'utf8').trim() : '';
        throw new PhoneDockError("The virtual device stopped while starting", 'boot_failed', 500, undefined, `QEMU exited during startup (code ${exited}): ${log.slice(-1500)}`);
      }
      if (Date.now() > deadline) throw new PhoneDockError("The virtual device did not start in time", 'timeout', 504, undefined, 'Timed out waiting for QEMU QMP socket');
      if (existsSync(sockPath(name))) {
        const st = await qmp<{ status: string; running: boolean }>(sockPath(name), 'query-status', undefined, 3000).catch(() => undefined);
        if (st?.running || st?.status === 'running') break;
      }
      await sleep(250);
    }
    // Wait for the display to come up: first non-trivial frame (firmware splash/console), max 30s.
    try {
      await waitFor(async () => { const b = await screendump(name); return b.length > 2000 ? b : false; }, 30_000, 500, 'first frame');
    } catch { /* still usable; guest may simply be slow (TCG) */ }
  } catch (e) {
    try { process.kill(child.pid!, 'SIGKILL'); } catch {}
    throw e;
  } finally { bootingSet.delete(name); }
}

async function screendump(name: string): Promise<Buffer> {
  const dir = vmDir(name);
  const tmp = join(dir, `shot-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    try {
      await qmp(sockPath(name), 'screendump', { filename: tmp + '.png', format: 'png' }, 10_000);
      const buf = readFileSync(tmp + '.png');
      screenCache.set(name, pngSize(buf));
      return buf;
    } catch (e) {
      if (!/format|png|parameter/i.test((e as Error).message)) throw e;
      // Older QEMU / no libpng: PPM then convert with ffmpeg.
      await qmp(sockPath(name), 'screendump', { filename: tmp + '.ppm' }, 10_000);
      const ff = which('ffmpeg'); if (!ff) throw new PhoneDockError('The screenshot could not be converted', 'missing_dependency', 500, ['Install ffmpeg.'], `QEMU produced PPM and ffmpeg is missing; brew install ffmpeg; original error: ${e instanceof PhoneDockError ? e.detail ?? e.message : String(e)}`);
      await run(ff, ['-loglevel', 'error', '-y', '-i', tmp + '.ppm', tmp + '.png']);
      const buf = readFileSync(tmp + '.png');
      screenCache.set(name, pngSize(buf));
      return buf;
    }
  } finally {
    for (const ext of ['.png', '.ppm']) { try { unlinkSync(tmp + ext); } catch {} }
  }
}

async function screenSize(name: string): Promise<{ width: number; height: number }> {
  return screenCache.get(name) ?? pngSize(await screendump(name));
}

function absEvents(x: number, y: number, size: { width: number; height: number }) {
  const ax = Math.round(Math.min(Math.max(x, 0), size.width - 1) / Math.max(1, size.width - 1) * ABS_MAX);
  const ay = Math.round(Math.min(Math.max(y, 0), size.height - 1) / Math.max(1, size.height - 1) * ABS_MAX);
  return [{ type: 'abs', data: { axis: 'x', value: ax } }, { type: 'abs', data: { axis: 'y', value: ay } }];
}
const btn = (down: boolean) => ({ type: 'btn', data: { down, button: 'left' } });
const inputCmd = (events: unknown[]): QmpCommand => ({ execute: 'input-send-event', arguments: { events } });

// ── keyboard mapping (US layout → QEMU qcodes) ─────────────────────────────
const PLAIN: Record<string, string> = {
  ' ': 'spc', '\n': 'ret', '\r': 'ret', '\t': 'tab', '-': 'minus', '=': 'equal', '[': 'bracket_left', ']': 'bracket_right',
  ';': 'semicolon', "'": 'apostrophe', '`': 'grave_accent', '\\': 'backslash', ',': 'comma', '.': 'dot', '/': 'slash',
};
const SHIFTED: Record<string, string> = {
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  '_': 'minus', '+': 'equal', '{': 'bracket_left', '}': 'bracket_right', ':': 'semicolon', '"': 'apostrophe',
  '~': 'grave_accent', '|': 'backslash', '<': 'comma', '>': 'dot', '?': 'slash',
};
function charToKeys(ch: string): string[] {
  if (/^[a-z0-9]$/.test(ch)) return [ch];
  if (/^[A-Z]$/.test(ch)) return ['shift', ch.toLowerCase()];
  if (PLAIN[ch]) return [PLAIN[ch]];
  if (SHIFTED[ch]) return ['shift', SHIFTED[ch]];
  throw new PhoneDockError('The text contains an unsupported character', 'unsupported_char', 400, ['Use US-ASCII characters.'], `Cannot type character ${JSON.stringify(ch)} (QEMU send-key supports US-ASCII only)`);
}
// Semantic keys. Linux mobile shells (Phosh/Plasma Mobile) open the overview with Super, so home → meta_l.
const KEYS: Record<string, string[]> = {
  home: ['meta_l'], back: ['esc'], enter: ['ret'], delete: ['backspace'], tab: ['tab'], escape: ['esc'], space: ['spc'],
  up: ['up'], down: ['down'], left: ['left'], right: ['right'],
  volume_up: ['volumeup'], volume_down: ['volumedown'], power: ['power'], lock: ['meta_l', 'l'],
  app_switch: ['alt', 'tab'], menu: ['menu'], search: ['find'], screenshot: ['print'],
};
function keyToQcodes(key: KeyName): string[] {
  const k = String(key);
  if (KEYS[k.toLowerCase()]) return KEYS[k.toLowerCase()];
  // Raw qcodes and combos: "f2", "ctrl+alt+f2", "qcode:kp_enter".
  const parts = k.replace(/^qcode:/i, '').toLowerCase().split('+').map((p) => p.trim()).filter(Boolean)
    .map((p) => ({ ctrl: 'ctrl', control: 'ctrl', alt: 'alt', option: 'alt', shift: 'shift', cmd: 'meta_l', super: 'meta_l', meta: 'meta_l', win: 'meta_l' } as Record<string, string>)[p] ?? p);
  if (!parts.length || parts.some((p) => !/^[a-z0-9_]+$/.test(p))) throw new PhoneDockError('The key is not recognized', 'unknown_key', 400, undefined, `Unknown key ${JSON.stringify(k)}`);
  return parts;
}
// Explicit key down/up via input-send-event: deterministic ordering. (`send-key` releases asynchronously after
// hold-time, so fast consecutive calls overlap and repeated characters like "((" get swallowed.)
const keyEv = (q: string, down: boolean) => ({ type: 'key', data: { down, key: { type: 'qcode', data: q } } });
async function sendKeys(name: string, qcodes: string[], holdMs = 25): Promise<void> {
  const sock = sockPath(name);
  await qmpBatch(sock, [inputCmd(qcodes.map((q) => keyEv(q, true)))]);
  await sleep(holdMs);
  await qmpBatch(sock, [inputCmd([...qcodes].reverse().map((q) => keyEv(q, false)))]);
  await sleep(20);
}

// ── snapshots ───────────────────────────────────────────────────────────────
function parseSnapshots(text: string): Snapshot[] {
  const out: Snapshot[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\S+)\s+(\S+)\s+([\d.]+\s*[KMGT]?i?B|[\d.]+\s*\w*)\s+(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/);
    if (!m || m[1] === 'ID') continue;
    const sz = m[3].match(/([\d.]+)\s*([KMGT]?)i?B?/);
    const mult: Record<string, number> = { '': 1 / 1048576, K: 1 / 1024, M: 1, G: 1024, T: 1048576 };
    out.push({ name: m[2], createdAt: new Date(m[4].replace(' ', 'T')).toISOString(), sizeMB: sz ? Math.round(Number(sz[1]) * (mult[sz[2]] ?? 1) * 10) / 10 : undefined });
  }
  return out;
}
function validSnap(n: string) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(n)) throw new PhoneDockError('The snapshot name is invalid', 'invalid_name', 400, ['Use letters, digits, periods, underscores, or hyphens.'], `Invalid snapshot name ${JSON.stringify(n)}; maximum length is 64 characters`);
}

// ── backend ─────────────────────────────────────────────────────────────────
export const backend: Backend = {
  id: ID,
  displayName: 'QEMU virtual machines',
  stage: 'experimental',
  platform: 'linux',
  kind: 'virtual',
  capabilities: CAPS,

  async available(): Promise<Availability> {
    const bin = qemuBin('aarch64');
    if (!bin) return { ok: false, reason: 'qemu-system-aarch64 not found', hints: ['brew install qemu'] };
    if (!qemuImg()) return { ok: false, reason: 'qemu-img not found', hints: ['brew install qemu'] };
    if (!firmwareDir()) return { ok: false, reason: 'EDK2 firmware (edk2-aarch64-code.fd) not found', hints: ['brew reinstall qemu'] };
    const v = await run(bin, ['--version'], { allowFail: true, timeoutMs: 10_000 });
    return { ok: true, version: v.stdout.match(/version ([\d.]+)/)?.[1] };
  },

  async listDevices(): Promise<Device[]> {
    const out: Device[] = [];
    for (const n of readdirSync(vmRoot())) {
      if (!existsSync(join(vmRoot(), n, 'vm.json'))) continue;
      try { out.push(toDevice(loadSpec(n))); } catch { /* skip corrupt */ }
    }
    return out;
  },

  async listImages(): Promise<OsImage[]> {
    const imgs: OsImage[] = CATALOG.map((c) => ({
      id: c.id, backend: ID, platform: 'linux', name: c.name, version: c.version,
      installed: existsSync(join(imagesDir(), c.file)), sizeMB: c.sizeMB,
      notes: `${c.arch}${c.arch === 'aarch64' ? ' (HVF)' : ' (TCG emulation)'} · ${c.kind}. ${c.notes ?? ''}`.trim(),
    }));
    // Anything else the user dropped into the image cache (iso / qcow2 / img / raw).
    const known = new Set(CATALOG.map((c) => c.file));
    for (const f of readdirSync(imagesDir())) {
      if (known.has(f) || !/\.(iso|qcow2|img|raw)$/i.test(f)) continue;
      imgs.push({ id: `file:${f}`, backend: ID, platform: 'linux', name: f, installed: true,
        sizeMB: Math.round(statSync(join(imagesDir(), f)).size / 1048576),
        notes: 'Local image in the cache dir (assumed aarch64; set options.arch for x86_64).' });
    }
    return imgs;
  },

  async installImage(imageId: string, onProgress?: (l: string) => void): Promise<void> {
    const c = CATALOG.find((x) => x.id === imageId);
    if (!c) throw new PhoneDockError('The image was not found', 'not_found', 404, ['Choose an available image.'], `Unknown QEMU image ${JSON.stringify(imageId)}; GET /v1/images?backend=qemu; or pass options.isoPath / options.diskPath to create`);
    const final = join(imagesDir(), c.file);
    if (existsSync(final)) { onProgress?.(`${c.id} already installed`); return; }
    const url = typeof c.url === 'string' ? c.url : await c.url();
    const ext = url.endsWith('.xz') ? '.xz' : url.endsWith('.gz') ? '.gz' : '';
    const part = final + ext + '.part';
    onProgress?.(`downloading ${url}`);
    await curlDownload(url, part, onProgress);
    if (c.sha256 && !ext) {
      onProgress?.('verifying sha256');
      const sum = (await run('shasum', ['-a', '256', part], { timeoutMs: 600_000 })).stdout.split(/\s+/)[0];
      if (sum !== c.sha256) { rmSync(part, { force: true }); throw new PhoneDockError("The downloaded image failed its integrity check", 'checksum_mismatch', 502, undefined, `sha256 mismatch for ${c.file}: ${sum}`); }
    }
    if (ext) {
      onProgress?.(`decompressing (${ext})`);
      const packed = final + ext; renameSync(part, packed);
      if (ext === '.xz') await run('xz', ['-d', '-T0', '-f', packed], { timeoutMs: 0 });
      else await run('gunzip', ['-f', packed], { timeoutMs: 0 });
    } else renameSync(part, final);
    onProgress?.(`installed ${final}`);
  },

  async listProfiles(): Promise<HardwareProfile[]> {
    return [
      { id: 'phone', name: 'Phone portrait 720×1440', width: 720, height: 1440, ramMB: 4096 },
      { id: 'tablet', name: 'Tablet 1600×1200', width: 1600, height: 1200, ramMB: 4096 },
      { id: 'desktop', name: 'Desktop 1280×800', width: 1280, height: 800, ramMB: 2048 },
    ];
  },

  async create(spec: DeviceSpec, onProgress?: (l: string) => void): Promise<Device> {
    validName(spec.name);
    const img = needImg();
    if (existsSync(join(vmRoot(), spec.name, 'vm.json'))) throw new PhoneDockError(`The virtual device "${spec.name}" already exists.`, 'exists', 409);
    const o = (spec.options ?? {}) as Record<string, unknown>;
    const prof = spec.profile ? (await backend.listProfiles!()).find((p) => p.id === spec.profile) : undefined;

    // Resolve the image source.
    let iso: string | undefined; let baseDisk: string | undefined; let arch: Arch = o.arch === 'x86_64' ? 'x86_64' : 'aarch64';
    let imageName: string | undefined; let imageId = spec.image;
    const abs = (p: unknown) => { const s = String(p); const r = isAbsolute(s) ? s : resolvePath(s); if (!existsSync(r)) throw new PhoneDockError("Couldn’t find the file", 'not_found', 404, undefined, `File not found: ${r}`); return r; };
    if (o.isoPath) { iso = abs(o.isoPath); imageName = basename(iso); }
    else if (o.diskPath) { baseDisk = abs(o.diskPath); imageName = basename(baseDisk); }
    else if (spec.image) {
      const c = CATALOG.find((x) => x.id === spec.image);
      if (c) {
        const f = join(imagesDir(), c.file);
        if (!existsSync(f)) { onProgress?.(`image ${c.id} not installed – downloading`); await backend.installImage!(c.id, onProgress); }
        if (c.kind === 'iso') iso = f; else baseDisk = f;
        arch = c.arch; imageName = c.name;
      } else if (spec.image.startsWith('file:')) {
        const f = join(imagesDir(), basename(spec.image.slice(5)));
        if (!existsSync(f)) throw new PhoneDockError("Couldn’t find the image", 'not_found', 404, undefined, `Image not found: ${f}`);
        if (/\.iso$/i.test(f)) iso = f; else baseDisk = f; imageName = basename(f);
      } else if (existsSync(spec.image)) {
        const f = abs(spec.image); if (/\.iso$/i.test(f)) iso = f; else baseDisk = f; imageName = basename(f);
      } else throw new PhoneDockError('The image was not found', 'not_found', 404, ['Choose an available image.'], `Unknown image ${JSON.stringify(spec.image)}; GET /v1/images?backend=qemu`);
    } else throw new PhoneDockError('The virtual device needs an image', 'invalid_spec', 400, ['Choose an image for the device.'], 'Provide spec.image (catalog id) or options.isoPath / options.diskPath');
    if (!qemuBin(arch)) throw new PhoneDockError('The virtual device software is missing', 'missing_dependency', 500, ['Install QEMU.'], `qemu-system-${arch} not found; brew install qemu`);

    const s: VmSpec = {
      name: spec.name, arch, platform: 'linux', imageId, imageName, iso, baseDisk,
      cpus: spec.cpus ?? 4, ramMB: spec.ramMB ?? prof?.ramMB ?? 2048, storageMB: spec.storageMB ?? 8192,
      width: spec.width ?? prof?.width ?? 1280, height: spec.height ?? prof?.height ?? 800,
      network: spec.network ?? 'nat', createdAt: new Date().toISOString(),
      extraArgs: Array.isArray(o.qemuArgs) ? (o.qemuArgs as unknown[]).map(String) : undefined,
    };
    const dir = vmDir(s.name); mkdirSync(dir, { recursive: true });
    try {
      const disk = join(dir, 'disk.qcow2');
      if (baseDisk) {
        const info = JSON.parse((await run(img, ['info', '--output=json', '-U', baseDisk])).stdout) as { format: string; 'virtual-size': number };
        const sizeArg = Math.max(info['virtual-size'], s.storageMB * 1048576);
        s.storageMB = Math.round(sizeArg / 1048576);
        onProgress?.(`linked clone of ${baseDisk} (${info.format})`);
        await run(img, ['create', '-q', '-f', 'qcow2', '-b', baseDisk, '-F', info.format, disk, String(sizeArg)]);
      } else {
        await run(img, ['create', '-q', '-f', 'qcow2', disk, `${s.storageMB}M`]);
      }
      // UEFI variable store as qcow2 so `savevm` works (raw pflash blocks internal snapshots).
      const fw = firmware(arch);
      if (fw.varsTemplate) await run(img, ['convert', '-q', '-f', 'raw', '-O', 'qcow2', fw.varsTemplate, join(dir, 'efivars.qcow2')]);
      else await run(img, ['create', '-q', '-f', 'qcow2', join(dir, 'efivars.qcow2'), '64M']);
      saveSpec(s);
    } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
    onProgress?.(`created ${dir}`);
    return toDevice(s);
  },

  async boot(nativeId: string, opts?: BootOptions): Promise<void> { await startVm(nativeId, opts); },

  async shutdown(nativeId: string): Promise<void> {
    loadSpec(nativeId);
    const pid = readPid(nativeId); if (!pid) return;
    const sock = sockPath(nativeId);
    try { await qmp(sock, 'system_powerdown', undefined, 5000); } catch {}
    const gone = async (ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (!isRunning(nativeId)) return true; await sleep(300); } return false; };
    if (await gone(15_000)) return;
    try { await qmp(sock, 'quit', undefined, 5000); } catch {}
    if (await gone(5_000)) return;
    try { process.kill(pid, 'SIGKILL'); } catch {}
    await gone(3000);
  },

  async delete(nativeId: string): Promise<void> {
    loadSpec(nativeId);
    const pid = readPid(nativeId);
    if (pid) { try { await qmp(sockPath(nativeId), 'quit', undefined, 3000); } catch {} await sleep(500); try { process.kill(pid, 'SIGKILL'); } catch {} }
    try { unlinkSync(sockPath(nativeId)); } catch {}
    rmSync(vmDir(nativeId), { recursive: true, force: true });
    screenCache.delete(nativeId);
  },

  async clone(nativeId: string, newName: string): Promise<Device> {
    const s = loadSpec(nativeId); validName(newName);
    if (isRunning(nativeId)) throw new PhoneDockError('The virtual device is running', 'busy', 409, ['Shut down the device before cloning it.']);
    if (existsSync(join(vmRoot(), newName, 'vm.json'))) throw new PhoneDockError(`The virtual device "${newName}" already exists.`, 'exists', 409);
    const src = vmDir(nativeId); const dst = vmDir(newName); mkdirSync(dst, { recursive: true });
    try {
      // APFS copy-on-write clones (instant, no extra space until blocks diverge). Snapshots inside qcow2 come along.
      for (const f of ['disk.qcow2', 'efivars.qcow2']) await run('cp', ['-c', join(src, f), join(dst, f)], { timeoutMs: 600_000 });
      saveSpec({ ...s, name: newName, createdAt: new Date().toISOString() });
    } catch (e) { rmSync(dst, { recursive: true, force: true }); throw e; }
    return toDevice(loadSpec(newName));
  },

  async listSnapshots(nativeId: string): Promise<Snapshot[]> {
    loadSpec(nativeId);
    if (isRunning(nativeId)) return parseSnapshots(await hmp(sockPath(nativeId), 'info snapshots', 30_000).catch((e) => /no snapshot|There is no/i.test(e.message) ? '' : Promise.reject(e)));
    const r = await run(needImg(), ['snapshot', '-U', '-l', join(vmDir(nativeId), 'disk.qcow2')], { allowFail: true });
    return parseSnapshots(r.stdout);
  },

  async saveSnapshot(nativeId: string, name: string): Promise<void> {
    validSnap(name); needRunning(nativeId);
    await hmp(sockPath(nativeId), `savevm ${name}`, 300_000);
  },

  async restoreSnapshot(nativeId: string, name: string): Promise<void> {
    validSnap(name); loadSpec(nativeId);
    if (!isRunning(nativeId)) { await startVm(nativeId, { loadvm: name }); return; }
    await hmp(sockPath(nativeId), `loadvm ${name}`, 300_000);
    screenCache.delete(nativeId);
  },

  async deleteSnapshot(nativeId: string, name: string): Promise<void> {
    validSnap(name); loadSpec(nativeId);
    if (isRunning(nativeId)) { await hmp(sockPath(nativeId), `delvm ${name}`, 120_000); return; }
    const dir = vmDir(nativeId);
    for (const f of ['disk.qcow2', 'efivars.qcow2']) await run(needImg(), ['snapshot', '-d', name, join(dir, f)], { allowFail: f !== 'disk.qcow2' });
  },

  async openWindow(nativeId: string): Promise<void> {
    loadSpec(nativeId);
    if (isRunning(nativeId)) throw new PhoneDockError('A window cannot be opened for this running device', 'unsupported', 409,
      ['Shut down the device and start it with a window.', 'Use the live stream or screenshots instead.'], 'Boot with { window: true } to open a native Cocoa window');
    await startVm(nativeId, { window: true });
  },

  async screenshot(nativeId: string): Promise<Buffer> { needRunning(nativeId); return screendump(nativeId); },

  async screenInfo(nativeId: string): Promise<ScreenInfo> {
    const s = loadSpec(nativeId);
    if (!isRunning(nativeId)) return { width: s.width, height: s.height, scale: 1 };
    return { ...(await screenSize(nativeId)), scale: 1 };
  },

  async tap(nativeId: string, x: number, y: number): Promise<void> {
    await backend.longPress!(nativeId, x, y, 60);
  },

  async longPress(nativeId: string, x: number, y: number, durationMs: number): Promise<void> {
    needRunning(nativeId);
    const size = await screenSize(nativeId); const sock = sockPath(nativeId);
    await qmpBatch(sock, [inputCmd(absEvents(x, y, size)), inputCmd([btn(true)])]);
    await sleep(Math.max(20, durationMs));
    await qmpBatch(sock, [inputCmd([btn(false)])]);
  },

  async swipe(nativeId: string, x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void> {
    needRunning(nativeId);
    const size = await screenSize(nativeId); const sock = sockPath(nativeId);
    const dur = Math.max(50, durationMs || 300); const steps = Math.max(5, Math.min(60, Math.round(dur / 16)));
    await qmpBatch(sock, [inputCmd(absEvents(x1, y1, size)), inputCmd([btn(true)])]);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await sleep(dur / steps);
      await qmpBatch(sock, [inputCmd(absEvents(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, size))]);
    }
    await qmpBatch(sock, [inputCmd([btn(false)])]);
  },

  async type(nativeId: string, text: string): Promise<void> {
    needRunning(nativeId);
    const seq = [...text].map(charToKeys); // validate everything before sending anything
    for (const keys of seq) await sendKeys(nativeId, keys);
  },

  async key(nativeId: string, key: KeyName): Promise<void> {
    needRunning(nativeId);
    await sendKeys(nativeId, keyToQcodes(key), 80);
  },

  async logs(nativeId: string, opts?: { lines?: number; filter?: string }): Promise<string> {
    loadSpec(nativeId);
    const dir = vmDir(nativeId);
    const f = existsSync(join(dir, 'serial.log')) ? join(dir, 'serial.log') : join(dir, 'serial.prev.log');
    if (!existsSync(f)) return '';
    // eslint-disable-next-line no-control-regex
    let lines = readFileSync(f, 'utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '').split('\n');
    if (opts?.filter) { const needle = opts.filter.toLowerCase(); lines = lines.filter((l) => l.toLowerCase().includes(needle)); }
    return lines.slice(-(opts?.lines ?? 200)).join('\n');
  },

  async info(nativeId: string): Promise<Record<string, unknown>> {
    const s = loadSpec(nativeId);
    const running = isRunning(nativeId);
    let status: unknown;
    if (running) { try { status = await qmp(sockPath(nativeId), 'query-status', undefined, 3000); } catch (e) { status = { error: (e as Error).message }; } }
    return { ...s, running, pid: readPid(nativeId), status, dir: vmDir(nativeId), args: buildArgs(s, {}) };
  },
};
