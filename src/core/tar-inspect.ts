// Binary tar.gz header inspector (Node zlib + POSIX ustar + PAX x/g + GNU L/K).
// Validates every entry's real type, path, and link target directly from archive headers — never parsing `tar -tv` text.
import { createReadStream } from 'node:fs';
import { normalize, resolve, sep } from 'node:path';
import { createGunzip } from 'node:zlib';
import { PhoneDockError } from './types.ts';

const BLOCK_SIZE = 512;
const MAX_META_BYTES = 1024 * 1024; // 1 MiB cap for PAX/GNU long-name header payloads

export interface TarEntryInfo {
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'hardlink';
  linkname?: string;
}

function readCString(buf: Buffer, start: number, end: number): string {
  let stop = start;
  while (stop < end && buf[stop] !== 0) stop++;
  return buf.subarray(start, stop).toString('utf8');
}

function parseTarNumber(buf: Buffer, start: number, length: number): number {
  const first = buf[start];
  // GNU base-256 encoding when high bit is set.
  if ((first & 0x80) !== 0) {
    let val = first & 0x7f;
    for (let i = start + 1; i < start + length; i++) {
      val = val * 256 + buf[i];
    }
    return val;
  }
  const raw = readCString(buf, start, start + length).trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) {
    throw new PhoneDockError('Archive contains invalid tar header size', 'unsafe_archive', 502, undefined, `Invalid octal field: ${raw}`);
  }
  return Number.parseInt(raw, 8);
}

function verifyHeaderChecksum(block: Buffer): boolean {
  const stored = parseTarNumber(block, 148, 8);
  let unsignedSum = 0;
  let signedSum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : block[i];
    unsignedSum += b;
    signedSum += b < 128 ? b : b - 256;
  }
  return stored === unsignedSum || stored === signedSum;
}

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < BLOCK_SIZE; i++) {
    if (block[i] !== 0) return false;
  }
  return true;
}

function parsePaxRecords(payload: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let offset = 0;
  while (offset < payload.length) {
    const sp = payload.indexOf(0x20, offset); // ' '
    if (sp < 0) break;
    const lenStr = payload.subarray(offset, sp).toString('ascii');
    const recLen = Number.parseInt(lenStr, 10);
    if (!Number.isInteger(recLen) || recLen <= 0 || offset + recLen > payload.length) {
      throw new PhoneDockError('Archive contains malformed PAX header', 'unsafe_archive', 502);
    }
    const recEnd = offset + recLen;
    const body = payload.subarray(sp + 1, payload[recEnd - 1] === 0x0a ? recEnd - 1 : recEnd).toString('utf8');
    const eq = body.indexOf('=');
    if (eq > 0) {
      out[body.slice(0, eq)] = body.slice(eq + 1);
    }
    offset = recEnd;
  }
  return out;
}

export function hasUnsafeTarPath(p: string): boolean {
  if (!p || p.includes('\0')) return true;
  if (p.startsWith('/') || p.startsWith('\\')) return true;
  return p.split(/[\\/]+/).includes('..');
}

function canonicalRelPath(p: string): string {
  const norm = normalize(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return norm === '.' ? '' : norm;
}

/**
 * Inspect a `.tar.gz` archive by streaming gunzipped 512-byte tar headers directly in Node.
 * Supports POSIX ustar, PAX `x`/`g` extended headers (`path`, `linkpath`, `size`), and GNU `L`/`K` long names.
 * Rejects absolute paths, `..` segments in paths or link targets, disallowed entry types, and hardlinks that do not
 * target an earlier entry inside the archive root.
 */
export async function inspectTarGzHeaders(tarballPath: string, targetDir: string): Promise<TarEntryInfo[]> {
  const base = resolve(targetDir);
  const entries: TarEntryInfo[] = [];
  const seenEntries = new Set<string>();

  let globalPax: Record<string, string> = {};
  let nextPax: Record<string, string> | undefined;
  let nextGnuLongName: string | undefined;
  let nextGnuLongLink: string | undefined;

  let state: 'header' | 'skip' | 'meta' = 'header';
  let headerBuf = Buffer.alloc(0);
  let remainingPayload = 0;
  let remainingPad = 0;
  let metaKind: 'x' | 'g' | 'L' | 'K' | undefined;
  let metaChunks: Buffer[] = [];
  let zeroBlocks = 0;

  const processHeader = (block: Buffer) => {
    if (isZeroBlock(block)) {
      zeroBlocks++;
      return;
    }
    zeroBlocks = 0;

    if (!verifyHeaderChecksum(block)) {
      throw new PhoneDockError('Archive contains corrupt tar header checksum', 'unsafe_archive', 502);
    }

    const typeByte = block[156];
    const typeFlag = typeByte === 0 ? '0' : String.fromCharCode(typeByte);
    const magic = readCString(block, 257, 263);
    const rawName = readCString(block, 0, 100);
    const prefix = magic.startsWith('ustar') ? readCString(block, 345, 500) : '';
    let name = prefix ? `${prefix}/${rawName}` : rawName;
    let linkname = readCString(block, 157, 257);
    let size = parseTarNumber(block, 124, 12);

    // Handle metadata pseudo-entries (PAX x/g, GNU L/K)
    if (typeFlag === 'x' || typeFlag === 'g' || typeFlag === 'L' || typeFlag === 'K') {
      if (size > MAX_META_BYTES) {
        throw new PhoneDockError('Archive metadata header exceeds size limit', 'unsafe_archive', 502);
      }
      metaKind = typeFlag;
      metaChunks = [];
      remainingPayload = size;
      remainingPad = (BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE;
      state = size > 0 ? 'meta' : (remainingPad > 0 ? 'skip' : 'header');
      return;
    }

    // Apply PAX global, PAX per-entry, and GNU long-name overrides
    const mergedPax = nextPax ? { ...globalPax, ...nextPax } : globalPax;
    if (typeof mergedPax.path === 'string') name = mergedPax.path;
    if (typeof mergedPax.linkpath === 'string') linkname = mergedPax.linkpath;
    if (typeof mergedPax.size === 'string') {
      const parsedSize = Number.parseInt(mergedPax.size, 10);
      if (!Number.isSafeInteger(parsedSize) || parsedSize < 0) {
        throw new PhoneDockError('Archive contains invalid PAX size', 'unsafe_archive', 502);
      }
      size = parsedSize;
    }
    if (nextGnuLongName !== undefined) name = nextGnuLongName;
    if (nextGnuLongLink !== undefined) linkname = nextGnuLongLink;
    nextPax = undefined;
    nextGnuLongName = undefined;
    nextGnuLongLink = undefined;

    // Only allow regular files, directories, symlinks, and hardlinks.
    let entryType: TarEntryInfo['type'];
    if (typeFlag === '0') entryType = 'file';
    else if (typeFlag === '5') entryType = 'directory';
    else if (typeFlag === '2') entryType = 'symlink';
    else if (typeFlag === '1') entryType = 'hardlink';
    else {
      throw new PhoneDockError(
        'Archive contains unsupported entry type',
        'unsafe_archive',
        502,
        undefined,
        `Rejected tar typeflag "${typeFlag}" for entry: ${name}`,
      );
    }

    // Validate entry path
    if (hasUnsafeTarPath(name)) {
      throw new PhoneDockError('Archive contains an unsafe entry path', 'unsafe_archive', 502, undefined, `Rejected tar entry path: ${name}`);
    }
    const resolvedEntry = resolve(base, normalize(name));
    if (resolvedEntry !== base && !resolvedEntry.startsWith(base + sep)) {
      throw new PhoneDockError('Archive entry escapes destination directory', 'unsafe_archive', 502, undefined, `Rejected escaping tar entry: ${name}`);
    }

    const canonName = canonicalRelPath(name);

    if (entryType === 'symlink') {
      if (hasUnsafeTarPath(linkname)) {
        throw new PhoneDockError('Archive contains an unsafe symlink target', 'unsafe_archive', 502, undefined, `Rejected symlink ${name} -> ${linkname}`);
      }
      entries.push({ name, type: entryType, linkname });
    } else if (entryType === 'hardlink') {
      if (hasUnsafeTarPath(linkname)) {
        throw new PhoneDockError('Archive contains an unsafe hardlink target', 'unsafe_archive', 502, undefined, `Rejected hardlink ${name} -> ${linkname}`);
      }
      const resolvedLink = resolve(base, normalize(linkname));
      if (resolvedLink !== base && !resolvedLink.startsWith(base + sep)) {
        throw new PhoneDockError('Archive hardlink escapes destination directory', 'unsafe_archive', 502, undefined, `Rejected escaping hardlink ${name} -> ${linkname}`);
      }
      const canonTarget = canonicalRelPath(linkname);
      if (!canonTarget || !seenEntries.has(canonTarget)) {
        throw new PhoneDockError(
          'Archive hardlink does not target an earlier entry inside root',
          'unsafe_archive',
          502,
          undefined,
          `Rejected hardlink ${name} -> ${linkname}`,
        );
      }
      entries.push({ name, type: entryType, linkname });
      if (canonName) seenEntries.add(canonName);
    } else {
      entries.push({ name, type: entryType });
      if (canonName) seenEntries.add(canonName);
    }

    const totalSkip = size + ((BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE);
    if (totalSkip > 0) {
      remainingPayload = totalSkip;
      state = 'skip';
    }
  };

  const finishMeta = () => {
    const buf = Buffer.concat(metaChunks);
    metaChunks = [];
    if (metaKind === 'x') {
      nextPax = { ...(nextPax ?? {}), ...parsePaxRecords(buf) };
    } else if (metaKind === 'g') {
      globalPax = { ...globalPax, ...parsePaxRecords(buf) };
    } else if (metaKind === 'L') {
      nextGnuLongName = buf.toString('utf8').replace(/\0+$/, '');
    } else if (metaKind === 'K') {
      nextGnuLongLink = buf.toString('utf8').replace(/\0+$/, '');
    }
    metaKind = undefined;
  };

  const feed = (chunk: Buffer) => {
    let pos = 0;
    while (pos < chunk.length) {
      if (state === 'skip') {
        const take = Math.min(remainingPayload, chunk.length - pos);
        remainingPayload -= take;
        pos += take;
        if (remainingPayload === 0) state = 'header';
        continue;
      }
      if (state === 'meta') {
        const take = Math.min(remainingPayload, chunk.length - pos);
        metaChunks.push(chunk.subarray(pos, pos + take));
        remainingPayload -= take;
        pos += take;
        if (remainingPayload === 0) {
          finishMeta();
          if (remainingPad > 0) {
            remainingPayload = remainingPad;
            remainingPad = 0;
            state = 'skip';
          } else {
            state = 'header';
          }
        }
        continue;
      }
      // state === 'header'
      const need = BLOCK_SIZE - headerBuf.length;
      const take = Math.min(need, chunk.length - pos);
      headerBuf = headerBuf.length === 0 ? Buffer.from(chunk.subarray(pos, pos + take)) : Buffer.concat([headerBuf, chunk.subarray(pos, pos + take)]);
      pos += take;
      if (headerBuf.length === BLOCK_SIZE) {
        const block = headerBuf;
        headerBuf = Buffer.alloc(0);
        processHeader(block);
      }
    }
  };

  await new Promise<void>((resolveStream, rejectStream) => {
    const file = createReadStream(tarballPath);
    const gunzip = createGunzip();
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      file.destroy();
      gunzip.destroy();
      rejectStream(err instanceof PhoneDockError
        ? err
        : new PhoneDockError('Could not inspect downloaded archive', 'unsafe_archive', 502, undefined, err instanceof Error ? err.message : String(err)));
    };
    file.on('error', fail);
    gunzip.on('error', fail);
    gunzip.on('data', (chunk: Buffer) => {
      if (settled) return;
      try { feed(chunk); } catch (err) { fail(err); }
    });
    gunzip.on('end', () => {
      if (settled) return;
      if (state !== 'header' || headerBuf.length !== 0) {
        fail(new PhoneDockError('Downloaded archive is truncated', 'unsafe_archive', 502));
        return;
      }
      if (entries.length === 0) {
        fail(new PhoneDockError('Downloaded archive is empty', 'unsafe_archive', 502));
        return;
      }
      settled = true;
      resolveStream();
    });
    file.pipe(gunzip);
  });

  return entries;
}
