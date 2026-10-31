import { Unzip, UnzipInflate, UnzipPassThrough, unzipSync } from 'fflate';
import { cleanPath, detectPrefix, PathError } from './names.ts';

export const LIMITS = {
  archiveBytes: 15 * 1024 * 1024,
  /** Entries in the central directory, junk included. */
  rawEntries: 400,
  /** Entries kept after dropping directories and junk. */
  entries: 100,
  entryBytes: 5 * 1024 * 1024,
  totalBytes: 15 * 1024 * 1024,
  /** Declared expansion ratio; only applied above `ratioFloor` bytes. */
  ratio: 100,
  ratioFloor: 64 * 1024,
} as const;

export class ImportError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

interface Declared {
  name: string;
  size: number;
  originalSize: number;
  compression: number;
}

/** Cheap structural check before any parsing. */
function assertZipMagic(zip: Uint8Array): void {
  const local = zip[0] === 0x50 && zip[1] === 0x4b && zip[2] === 3 && zip[3] === 4;
  const empty = zip[0] === 0x50 && zip[1] === 0x4b && zip[2] === 5 && zip[3] === 6;
  if (!local && !empty) throw new ImportError('NOT_A_ZIP', 'The file is not a zip archive.');
}

function listEntries(zip: Uint8Array): Declared[] {
  const declared: Declared[] = [];
  try {
    unzipSync(zip, {
      filter: (file) => {
        declared.push({
          name: file.name,
          size: file.size,
          originalSize: file.originalSize,
          compression: file.compression,
        });
        if (declared.length > LIMITS.rawEntries)
          throw new ImportError('TOO_MANY_ENTRIES', 'The archive has too many entries.');
        return false;
      },
    });
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError('ZIP_INVALID', 'The archive is damaged or unsupported.');
  }
  return declared;
}

/** Compressed bytes fed per step; bounds one step's output to about 1000x this. */
const FEED = 4096;

/**
 * Inflates the kept entries with streaming limits. A header that understates the real size is
 * caught as soon as the output passes the declared size, before the rest is decoded.
 */
function inflateKept(zip: Uint8Array, keep: Map<string, Declared>): Map<string, Uint8Array> {
  const chunks = new Map<string, Uint8Array[]>();
  const sizes = new Map<string, number>();
  let failure: ImportError | null = null;
  const unzipper = new Unzip((file) => {
    const entry = keep.get(file.name);
    if (!entry || failure) return;
    const parts: Uint8Array[] = [];
    chunks.set(file.name, parts);
    sizes.set(file.name, 0);
    file.ondata = (err, chunk) => {
      if (failure) return;
      if (err) {
        failure = new ImportError('ZIP_INVALID', `Could not read ${file.name}.`);
        file.terminate();
        return;
      }
      const size = (sizes.get(file.name) ?? 0) + chunk.length;
      sizes.set(file.name, size);
      if (size > entry.originalSize) {
        failure = new ImportError('ZIP_INVALID', `${file.name} does not match its declared size.`);
        file.terminate();
        return;
      }
      parts.push(chunk);
    };
    file.start();
  });
  unzipper.register(UnzipInflate);
  unzipper.register(UnzipPassThrough);
  try {
    for (let i = 0; i < zip.length && !failure; i += FEED)
      unzipper.push(zip.subarray(i, Math.min(i + FEED, zip.length)), i + FEED >= zip.length);
  } catch {
    throw failure ?? new ImportError('ZIP_INVALID', 'The archive is damaged or unsupported.');
  }
  if (failure) throw failure;
  const out = new Map<string, Uint8Array>();
  for (const [name, parts] of chunks) {
    const bytes = new Uint8Array(sizes.get(name) ?? 0);
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.length;
    }
    out.set(name, bytes);
  }
  return out;
}

export interface Extracted {
  files: Map<string, Uint8Array>;
  /** Archive paths dropped as junk or directories. */
  dropped: string[];
}

/**
 * Unzips with limits. Sizes and paths are checked from the central directory before anything is
 * inflated; inflation is streamed and aborted once an entry passes its declared size.
 */
export function extractArchive(zip: Uint8Array): Extracted {
  if (zip.length > LIMITS.archiveBytes)
    throw new ImportError('ARCHIVE_TOO_LARGE', 'The archive is larger than 15 MB.');
  assertZipMagic(zip);
  const declared = listEntries(zip);
  const prefix = detectPrefix(declared.map((d) => d.name));

  const keep = new Map<string, Declared>();
  const dropped: string[] = [];
  const lower = new Set<string>();
  let total = 0;
  for (const entry of declared) {
    let path: string | null;
    try {
      path = cleanPath(entry.name, prefix);
    } catch (error) {
      if (error instanceof PathError) throw new ImportError(error.code, error.message);
      throw error;
    }
    if (path === null) {
      dropped.push(entry.name);
      continue;
    }
    if (entry.compression !== 0 && entry.compression !== 8)
      throw new ImportError('ZIP_COMPRESSION', `Unsupported compression in ${path}.`);
    if (entry.originalSize > LIMITS.entryBytes)
      throw new ImportError('ENTRY_TOO_LARGE', `${path} is larger than 5 MB.`);
    if (
      entry.originalSize > LIMITS.ratioFloor &&
      entry.originalSize > Math.max(entry.size, 1) * LIMITS.ratio
    )
      throw new ImportError('COMPRESSION_RATIO', `${path} expands too much.`);
    total += entry.originalSize;
    if (total > LIMITS.totalBytes)
      throw new ImportError('ARCHIVE_TOO_LARGE', 'The archive expands to more than 15 MB.');
    const key = path.toLowerCase();
    if (lower.has(key)) throw new ImportError('PATH_DUPLICATE', `Duplicate path ${path}.`);
    lower.add(key);
    keep.set(entry.name, entry);
    if (keep.size > LIMITS.entries)
      throw new ImportError('TOO_MANY_ENTRIES', 'The archive has more than 100 files.');
  }

  const raw = inflateKept(zip, keep);
  const files = new Map<string, Uint8Array>();
  for (const [name, entry] of keep) {
    const bytes = raw.get(name);
    if (!bytes) throw new ImportError('ZIP_INVALID', `Could not read ${name}.`);
    if (bytes.length !== entry.originalSize)
      throw new ImportError('ZIP_INVALID', `${name} does not match its declared size.`);
    const path = cleanPath(name, prefix);
    if (path) files.set(path, bytes);
  }
  return { files, dropped };
}
