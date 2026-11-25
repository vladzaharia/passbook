import { Unzip, UnzipInflate, UnzipPassThrough, unzipSync } from 'fflate';

export type ZipErrorCode =
  | 'ZIP_NOT_ZIP'
  | 'ZIP_INVALID'
  | 'ZIP_DUPLICATE'
  | 'ZIP_COMPRESSION'
  | 'ZIP_TOO_MANY_ENTRIES'
  | 'ZIP_TOO_LARGE'
  | 'ZIP_ENTRY_TOO_LARGE'
  | 'ZIP_RATIO';

export class ZipError extends Error {
  readonly code: ZipErrorCode;
  constructor(code: ZipErrorCode, message: string) {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

export interface ZipLimits {
  archiveBytes: number;
  /** Central-directory entries, selected or not. */
  rawEntries: number;
  /** Inflated bytes of one selected entry. */
  entryBytes: number;
  /** Inflated bytes of all selected entries together. */
  totalBytes: number;
  /** Declared expansion ratio; applied only above `ratioFloor` inflated bytes. */
  ratio: number;
  ratioFloor: number;
}

interface Declared {
  name: string;
  size: number;
  originalSize: number;
  compression: number;
}

export interface Inflated {
  files: Map<string, Uint8Array>;
  /** Every entry name in the central directory. */
  names: string[];
}

const invalid = () => new ZipError('ZIP_INVALID', 'The archive is damaged or unsupported.');

function assertZipMagic(zip: Uint8Array): void {
  const local = zip[0] === 0x50 && zip[1] === 0x4b && zip[2] === 3 && zip[3] === 4;
  const empty = zip[0] === 0x50 && zip[1] === 0x4b && zip[2] === 5 && zip[3] === 6;
  if (!local && !empty) throw new ZipError('ZIP_NOT_ZIP', 'The file is not a zip archive.');
}

function listEntries(zip: Uint8Array, rawEntries: number): Declared[] {
  const declared: Declared[] = [];
  const seen = new Set<string>();
  let packed = 0;
  try {
    unzipSync(zip, {
      filter: (file) => {
        if (declared.length >= rawEntries)
          throw new ZipError('ZIP_TOO_MANY_ENTRIES', 'The archive has too many entries.');
        if (seen.has(file.name))
          throw new ZipError('ZIP_DUPLICATE', 'The archive repeats an entry.');
        seen.add(file.name);
        // Compressed sizes are bytes of this archive, so they cannot exceed it, alone or together.
        packed += file.size;
        if (file.size > zip.length || packed > zip.length) throw invalid();
        declared.push({
          name: file.name,
          size: file.size,
          originalSize: file.originalSize,
          compression: file.compression,
        });
        return false;
      },
    });
  } catch (error) {
    if (error instanceof ZipError) throw error;
    throw invalid();
  }
  return declared;
}

/** Compressed bytes fed per step; bounds one step's output to about 1000x this. */
const FEED = 4096;

function stream(zip: Uint8Array, keep: Map<string, Declared>, limits: ZipLimits) {
  const bufs = new Map<string, Uint8Array>();
  const sizes = new Map<string, number>();
  let failure: ZipError | null = null;
  let inflated = 0;
  const unzipper = new Unzip((file) => {
    const entry = keep.get(file.name);
    if (!entry || failure) return;
    // The central directory names each file once; a repeated local header is a second inflate of it.
    if (bufs.has(file.name)) {
      failure = new ZipError('ZIP_DUPLICATE', 'The archive repeats an entry.');
      return;
    }
    // Sized from the central directory, already checked against the caps; chunks are copied in as
    // they arrive, so memory is the entry's size once, not a list of chunks plus a copy.
    const buf = new Uint8Array(entry.originalSize);
    bufs.set(file.name, buf);
    sizes.set(file.name, 0);
    file.ondata = (err, chunk) => {
      if (failure) return;
      if (err) {
        failure = invalid();
        file.terminate();
        return;
      }
      inflated += chunk.length;
      const before = sizes.get(file.name) ?? 0;
      const size = before + chunk.length;
      sizes.set(file.name, size);
      if (inflated > limits.totalBytes)
        failure = new ZipError('ZIP_TOO_LARGE', 'The archive expands too much.');
      else if (size > limits.entryBytes)
        failure = new ZipError('ZIP_ENTRY_TOO_LARGE', 'An entry in the archive expands too much.');
      else if (size > entry.originalSize)
        failure = new ZipError('ZIP_INVALID', 'An entry does not match its declared size.');
      if (failure) {
        file.terminate();
        return;
      }
      buf.set(chunk, before);
    };
    file.start();
  });
  unzipper.register(UnzipInflate);
  unzipper.register(UnzipPassThrough);
  try {
    for (let i = 0; i < zip.length && !failure; i += FEED)
      unzipper.push(zip.subarray(i, Math.min(i + FEED, zip.length)), i + FEED >= zip.length);
  } catch {
    throw failure ?? invalid();
  }
  if (failure) throw failure;
  return { bufs, sizes };
}

/**
 * Inflates the entries `select` accepts, with limits. Sizes come from the central directory and
 * are checked before anything is inflated; inflation is streamed and stops as soon as an entry
 * passes its declared size or a cap, so a header that understates the real size is caught early.
 * Only ZipError is thrown.
 */
export function inflateGuarded(
  zip: Uint8Array,
  limits: ZipLimits,
  select: (name: string) => boolean,
): Inflated {
  if (zip.length > limits.archiveBytes)
    throw new ZipError('ZIP_TOO_LARGE', 'The archive is too large.');
  assertZipMagic(zip);
  const declared = listEntries(zip, limits.rawEntries);
  const keep = new Map<string, Declared>();
  let total = 0;
  for (const entry of declared) {
    if (!select(entry.name)) continue;
    if (entry.compression !== 0 && entry.compression !== 8)
      throw new ZipError('ZIP_COMPRESSION', 'The archive uses an unsupported compression.');
    if (entry.originalSize > limits.entryBytes)
      throw new ZipError('ZIP_ENTRY_TOO_LARGE', 'An entry in the archive expands too much.');
    if (
      entry.originalSize > limits.ratioFloor &&
      entry.originalSize > Math.max(entry.size, 1) * limits.ratio
    )
      throw new ZipError('ZIP_RATIO', 'An entry in the archive expands too much.');
    total += entry.originalSize;
    if (total > limits.totalBytes)
      throw new ZipError('ZIP_TOO_LARGE', 'The archive expands too much.');
    keep.set(entry.name, entry);
  }

  const { bufs, sizes } = stream(zip, keep, limits);
  const files = new Map<string, Uint8Array>();
  for (const [name, entry] of keep) {
    const bytes = bufs.get(name);
    if (!bytes || sizes.get(name) !== entry.originalSize) throw invalid();
    files.set(name, bytes);
  }
  return { files, names: declared.map((d) => d.name) };
}
