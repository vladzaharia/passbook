// Bounded zlib inflate for PNG IDAT data: the output size is known from the header, so anything
// that would inflate past it (a decompression bomb) stops at once, and a short stream is an error.
import { Unzlib } from 'fflate';

export class PngError extends Error {}

/** Largest width or height either decoder accepts. */
export const PNG_MAX_SIDE = 16_384;
const PUSH = 64 * 1024;

/** Refuses empty or oversize dimensions. */
export function assertPngDimensions(width: number, height: number): void {
  if (width < 1 || height < 1 || width > PNG_MAX_SIDE || height > PNG_MAX_SIDE)
    throw new PngError('PNG size is out of range.');
}

/** Concatenates IDAT chunks and inflates them into exactly `expected` bytes. */
export function inflateIdat(idat: Uint8Array[], expected: number): Uint8Array {
  const total = idat.reduce((n, d) => n + d.length, 0);
  // Deflate cannot be larger than stored blocks (5 bytes per 64 KB) plus the zlib wrapper.
  if (total > expected + Math.ceil(expected / 16_384) * 5 + 64)
    throw new PngError('PNG data is larger than its size allows.');
  const out = new Uint8Array(expected);
  let at = 0;
  const stream = new Unzlib((chunk) => {
    if (at + chunk.length > expected)
      throw new PngError('PNG data is larger than its size allows.');
    out.set(chunk, at);
    at += chunk.length;
  });
  try {
    for (const part of idat)
      for (let i = 0; i < part.length; i += PUSH) stream.push(part.subarray(i, i + PUSH));
    stream.push(new Uint8Array(0), true);
  } catch (e) {
    if (e instanceof PngError) throw e;
    throw new PngError('PNG data is damaged.');
  }
  if (at < expected) throw new PngError('PNG data is truncated.');
  return out;
}
