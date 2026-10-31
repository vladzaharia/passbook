import { unzipSync } from 'fflate';
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

export interface Extracted {
  files: Map<string, Uint8Array>;
  /** Archive paths dropped as junk or directories. */
  dropped: string[];
}

/**
 * Unzips with limits. Sizes and paths are checked from the central directory before anything is
 * inflated; fflate allocates the declared size, so a lying header cannot grow the output.
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

  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(zip, { filter: (file) => keep.has(file.name) });
  } catch {
    throw new ImportError('ZIP_INVALID', 'The archive is damaged or unsupported.');
  }
  const files = new Map<string, Uint8Array>();
  for (const [name, entry] of keep) {
    const bytes = raw[name];
    if (!bytes) throw new ImportError('ZIP_INVALID', `Could not read ${name}.`);
    if (bytes.length !== entry.originalSize)
      throw new ImportError('ZIP_INVALID', `${name} does not match its declared size.`);
    const path = cleanPath(name, prefix);
    if (path) files.set(path, bytes);
  }
  return { files, dropped };
}
