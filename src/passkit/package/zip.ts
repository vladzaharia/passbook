import type { SignedPass } from '../sign/index.ts';
import { crc32 } from './crc32.ts';

export const PKPASS_CONTENT_TYPE = 'application/vnd.apple.pkpass';
export const PKPASSES_CONTENT_TYPE = 'application/vnd.apple.pkpasses';
/** Apple: a .pkpasses bundle holds at most 10 passes and 150 MB. */
export const PKPASSES_MAX_PASSES = 10;
export const PKPASSES_MAX_BYTES = 150_000_000;

export class PackageLimitError extends Error {
  readonly code: 'TOO_MANY_PASSES' | 'BUNDLE_TOO_LARGE' | 'INVALID_ENTRY';
  constructor(code: PackageLimitError['code'], message: string) {
    super(message);
    this.name = 'PackageLimitError';
    this.code = code;
  }
}

type BytesSource = Uint8Array | (() => Promise<Uint8Array>);
export type ZipEntry =
  | {
      name: string;
      bytes: BytesSource;
      /** Known CRC-32. Computed from the bytes when absent. */
      crc32?: number;
    }
  | {
      name: string;
      /** Body that is never buffered; `size` and `crc32` must be exact. */
      body: () => Promise<ReadableStream<Uint8Array>>;
      size: number;
      crc32: number;
    };

const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1; // fixed, so output is reproducible
const DOS_TIME = 0;
const FLAGS = 0x0800; // UTF-8 names
const encoder = new TextEncoder();

interface Planned {
  name: Uint8Array;
  size: number;
  crc: number;
  offset: number;
}

function checkName(name: string): void {
  if (
    name === '' ||
    name.startsWith('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    name.split('/').some((part) => part === '..' || part === '')
  )
    throw new PackageLimitError('INVALID_ENTRY', `Unsafe archive entry name: ${name}`);
}

function localHeader(entry: Planned): Uint8Array {
  const out = new Uint8Array(30 + entry.name.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, 20, true);
  v.setUint16(6, FLAGS, true);
  v.setUint16(10, DOS_TIME, true);
  v.setUint16(12, DOS_DATE, true);
  v.setUint32(14, entry.crc, true);
  v.setUint32(18, entry.size, true);
  v.setUint32(22, entry.size, true);
  v.setUint16(26, entry.name.length, true);
  out.set(entry.name, 30);
  return out;
}

function centralDirectory(entries: Planned[], start: number): Uint8Array {
  const total = entries.reduce((sum, e) => sum + 46 + e.name.length, 0);
  const out = new Uint8Array(total + 22);
  const v = new DataView(out.buffer);
  let p = 0;
  for (const e of entries) {
    v.setUint32(p, 0x02014b50, true);
    v.setUint16(p + 4, 20, true);
    v.setUint16(p + 6, 20, true);
    v.setUint16(p + 8, FLAGS, true);
    v.setUint16(p + 12, DOS_TIME, true);
    v.setUint16(p + 14, DOS_DATE, true);
    v.setUint32(p + 16, e.crc, true);
    v.setUint32(p + 20, e.size, true);
    v.setUint32(p + 24, e.size, true);
    v.setUint16(p + 28, e.name.length, true);
    v.setUint32(p + 42, e.offset, true);
    out.set(e.name, p + 46);
    p += 46 + e.name.length;
  }
  v.setUint32(p, 0x06054b50, true);
  v.setUint16(p + 8, entries.length, true);
  v.setUint16(p + 10, entries.length, true);
  v.setUint32(p + 12, total, true);
  v.setUint32(p + 16, start, true);
  return out;
}

function plan(name: string, size: number, crc: number, offset: number, seen: Set<string>): Planned {
  checkName(name);
  if (seen.has(name)) throw new PackageLimitError('INVALID_ENTRY', `Duplicate entry: ${name}`);
  seen.add(name);
  const encoded = encoder.encode(name);
  if (encoded.length > 0xffff || size > 0xffffffff || offset + size > 0xffffffff)
    throw new PackageLimitError('BUNDLE_TOO_LARGE', 'Archive exceeds the non-ZIP64 limits.');
  return { name: encoded, size, crc, offset };
}

export interface ZipStreamOptions {
  /** Abort once more than this many bytes of entry data were written. */
  maxBytes?: number;
}

/**
 * Streaming STORE-only zip. Entries are emitted one per pull and their bytes are enqueued
 * as given (no copies), so memory stays near one entry. Known CRCs skip hashing.
 */
export function zipStream(
  entries: ZipEntry[],
  options: ZipStreamOptions = {},
): ReadableStream<Uint8Array> {
  const planned: Planned[] = [];
  const seen = new Set<string>();
  let index = 0;
  let offset = 0;
  let written = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let current: { name: string; remaining: number; crc: number; expected: number } | undefined;

  const account = (n: number) => {
    written += n;
    if (options.maxBytes !== undefined && written > options.maxBytes)
      throw new PackageLimitError('BUNDLE_TOO_LARGE', 'The archive is larger than allowed.');
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          if (current && reader) {
            const { done, value } = await reader.read();
            if (value) {
              current.remaining -= value.length;
              current.crc = crc32(value, current.crc);
              account(value.length);
              if (current.remaining < 0) throw new Error('Entry body is longer than its size.');
              controller.enqueue(value);
            }
            if (done) {
              if (current.remaining !== 0 || current.crc !== current.expected)
                throw new Error(`Entry ${current.name} does not match its size or CRC.`);
              current = undefined;
              reader = undefined;
            }
            if (value?.length) return;
            continue;
          }
          const entry = entries[index++];
          if (!entry) {
            controller.enqueue(centralDirectory(planned, offset));
            controller.close();
            return;
          }
          if ('body' in entry) {
            const p = plan(entry.name, entry.size, entry.crc32, offset, seen);
            planned.push(p);
            offset += 30 + p.name.length + p.size;
            controller.enqueue(localHeader(p));
            if (entry.size === 0) return;
            reader = (await entry.body()).getReader();
            current = { name: entry.name, remaining: p.size, crc: 0, expected: p.crc };
            return;
          }
          const bytes = typeof entry.bytes === 'function' ? await entry.bytes() : entry.bytes;
          const p = plan(entry.name, bytes.length, entry.crc32 ?? crc32(bytes), offset, seen);
          planned.push(p);
          offset += 30 + p.name.length + p.size;
          account(bytes.length);
          controller.enqueue(localHeader(p));
          if (bytes.length > 0) controller.enqueue(bytes);
          return;
        }
      } catch (error) {
        await reader?.cancel().catch(() => undefined);
        throw error;
      }
    },
    async cancel() {
      await reader?.cancel().catch(() => undefined);
    },
  });
}

/** Synchronous variant: one allocation for the whole archive. For R2 puts and attachments. */
export function zipBytes(
  entries: { name: string; bytes: Uint8Array; crc32?: number }[],
): Uint8Array {
  const planned: Planned[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (const e of entries) {
    const p = plan(e.name, e.bytes.length, e.crc32 ?? crc32(e.bytes), offset, seen);
    planned.push(p);
    offset += 30 + p.name.length + p.size;
  }
  const directory = centralDirectory(planned, offset);
  const out = new Uint8Array(offset + directory.length);
  planned.forEach((p, i) => {
    out.set(localHeader(p), p.offset);
    out.set((entries[i] as { bytes: Uint8Array }).bytes, p.offset + 30 + p.name.length);
  });
  out.set(directory, offset);
  return out;
}

function passEntries(
  signed: SignedPass,
  prefix = '',
): { name: string; bytes: Uint8Array; crc32?: number }[] {
  return Object.keys(signed.files)
    .sort()
    .map((name) => ({
      name: `${prefix}${name}`,
      bytes: signed.files[name] as Uint8Array,
      ...(signed.crc32?.[name] !== undefined ? { crc32: signed.crc32[name] } : {}),
    }));
}

/** .pkpass as a streaming zip (STORE: PNGs are already compressed). */
export function packagePass(signed: SignedPass): ReadableStream<Uint8Array> {
  return zipStream(passEntries(signed));
}

/** .pkpass as bytes, for R2 puts and email attachments. */
export function packagePassBytes(signed: SignedPass): Uint8Array {
  return zipBytes(passEntries(signed));
}

export interface BundledPass {
  name: string;
  bytes: BytesSource;
  /** Byte length when known; lets the limit check fail before any pass is read. */
  size?: number;
  crc32?: number;
}

/** .pkpasses bundle: a zip of complete .pkpass files. Throws PackageLimitError over the limits. */
export function packagePasses(passes: BundledPass[]): ReadableStream<Uint8Array> {
  if (passes.length > PKPASSES_MAX_PASSES)
    throw new PackageLimitError(
      'TOO_MANY_PASSES',
      `A bundle holds at most ${PKPASSES_MAX_PASSES} passes.`,
    );
  if (passes.length === 0)
    throw new PackageLimitError('INVALID_ENTRY', 'A bundle needs at least one pass.');
  let known = 0;
  for (const pass of passes) {
    const size = pass.size ?? (typeof pass.bytes === 'function' ? undefined : pass.bytes.length);
    known += size ?? 0;
  }
  if (known > PKPASSES_MAX_BYTES)
    throw new PackageLimitError('BUNDLE_TOO_LARGE', 'A bundle is limited to 150 MB.');
  return zipStream(
    passes.map((pass, i) => ({
      name: pass.name.endsWith('.pkpass') ? pass.name : `${pass.name || `pass-${i + 1}`}.pkpass`,
      bytes: pass.bytes,
      ...(pass.crc32 !== undefined ? { crc32: pass.crc32 } : {}),
    })),
    { maxBytes: PKPASSES_MAX_BYTES },
  );
}
