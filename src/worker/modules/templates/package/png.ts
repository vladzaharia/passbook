import { crc32 } from './hash.ts';

export interface PngInfo {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
export const MAX_PNG_SIDE = 4096;

function u32(bytes: Uint8Array, at: number): number {
  return (
    (((bytes[at] as number) << 24) |
      ((bytes[at + 1] as number) << 16) |
      ((bytes[at + 2] as number) << 8) |
      (bytes[at + 3] as number)) >>>
    0
  );
}

/** Reads IHDR and walks every chunk (lengths and CRCs). Returns an error when malformed. */
export function parsePng(bytes: Uint8Array): PngInfo | { error: string } {
  if (bytes.length < 45 || SIGNATURE.some((b, i) => bytes[i] !== b))
    return { error: 'Not a PNG file.' };
  let at = 8;
  let info: PngInfo | undefined;
  let sawData = false;
  let sawEnd = false;
  while (at + 12 <= bytes.length && !sawEnd) {
    const length = u32(bytes, at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const end = at + 8 + length;
    if (length > 0x7fffffff || end + 4 > bytes.length) return { error: 'PNG is truncated.' };
    if (crc32(bytes, at + 4, end) !== u32(bytes, end))
      return { error: `PNG chunk ${type} is corrupt.` };
    if (at === 8) {
      if (type !== 'IHDR' || length !== 13) return { error: 'PNG header is missing.' };
      info = {
        width: u32(bytes, at + 8),
        height: u32(bytes, at + 12),
        bitDepth: bytes[at + 16] as number,
        colorType: bytes[at + 17] as number,
      };
    }
    if (type === 'IDAT') sawData = true;
    if (type === 'IEND') sawEnd = true;
    at = end + 4;
  }
  if (!info || !sawData || !sawEnd) return { error: 'PNG is incomplete.' };
  if (info.width < 1 || info.height < 1 || info.width > MAX_PNG_SIDE || info.height > MAX_PNG_SIDE)
    return { error: 'PNG dimensions are out of range.' };
  return info;
}

export function isPngInfo(value: PngInfo | { error: string }): value is PngInfo {
  return !('error' in value);
}
