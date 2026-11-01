import { unzlibSync } from 'fflate';

/** Alpha channel of a PNG, row by row (0 transparent, 255 opaque). */
export interface AlphaMap {
  width: number;
  height: number;
  alpha: Uint8Array;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Decodes the alpha of an 8- or 16-bit, non-interlaced PNG. Returns null for formats the lint
 * does not need (interlaced, sub-byte depths) or damaged data: those checks then simply skip.
 */
export function decodeAlpha(bytes: Uint8Array): AlphaMap | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 33 || view.getUint32(12) !== 0x49484452) return null;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const depth = bytes[24] as number;
  const type = bytes[25] as number;
  const interlace = bytes[28];
  const channels = CHANNELS[type];
  if (!channels || interlace !== 0 || (depth !== 8 && depth !== 16)) return null;
  if (width * height > 4_000_000) return null;
  const idat: Uint8Array[] = [];
  let trns: Uint8Array | null = null;
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = view.getUint32(at);
    const kind = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (kind === 'IDAT') idat.push(data);
    else if (kind === 'tRNS') trns = data;
    else if (kind === 'IEND') break;
    at += 12 + length;
  }
  let raw: Uint8Array;
  try {
    const joined = new Uint8Array(idat.reduce((n, d) => n + d.length, 0));
    let o = 0;
    for (const d of idat) {
      joined.set(d, o);
      o += d.length;
    }
    raw = unzlibSync(joined);
  } catch {
    return null; // Damaged data: the structure check reports it; pixel lint skips.
  }
  const bpp = channels * (depth / 8);
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) return null;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? (row[i - bpp] as number) : 0;
      const b = up ? (up[i] as number) : 0;
      const c = up && i >= bpp ? (up[i - bpp] as number) : 0;
      const x = src[i] as number;
      row[i] =
        filter === 1
          ? x + a
          : filter === 2
            ? x + b
            : filter === 3
              ? x + ((a + b) >> 1)
              : filter === 4
                ? x + paeth(a, b, c)
                : x;
    }
  }
  const alpha = new Uint8Array(width * height);
  const step = depth / 8;
  for (let p = 0; p < width * height; p++) {
    const base = p * bpp;
    if (type === 4 || type === 6) alpha[p] = pixels[base + (channels - 1) * step] as number;
    else if (type === 3)
      alpha[p] =
        trns && (pixels[base] as number) < trns.length
          ? (trns[pixels[base] as number] as number)
          : 255;
    else alpha[p] = 255;
  }
  return { width, height, alpha };
}

/** Share of fully transparent columns at the leading edge and rows at the top. */
export function transparentMargins(map: AlphaMap): { leading: number; top: number } {
  const { width, height, alpha } = map;
  const clearColumn = (x: number) => {
    for (let y = 0; y < height; y++) if ((alpha[y * width + x] as number) > 8) return false;
    return true;
  };
  const clearRow = (y: number) => {
    for (let x = 0; x < width; x++) if ((alpha[y * width + x] as number) > 8) return false;
    return true;
  };
  let left = 0;
  while (left < width && clearColumn(left)) left++;
  let top = 0;
  while (top < height && clearRow(top)) top++;
  return { leading: left / width, top: top / height };
}

/** True when the top-left pixel is opaque: the thumbnail is square, not rounded on transparent. */
export const opaqueCorner = (map: AlphaMap): boolean => (map.alpha[0] as number) > 8;

export interface PixelIssue {
  code: 'IMAGE_PADDING' | 'THUMBNAIL_CORNERS';
  message: string;
}

/** IMAGE_PADDING on logo slots (over 15% clear at the leading or top edge) and THUMBNAIL_CORNERS. */
export function pixelIssues(name: string, slot: string, bytes: Uint8Array): PixelIssue[] {
  const logo = slot === 'logo' || slot === 'primaryLogo' || slot === 'secondaryLogo';
  if (!logo && slot !== 'thumbnail') return [];
  const map = decodeAlpha(bytes);
  if (!map) return [];
  if (logo) {
    const m = transparentMargins(map);
    if (m.leading > 0.15 || m.top > 0.15)
      return [
        {
          code: 'IMAGE_PADDING',
          message: `${name} has empty space around the art; trim it so Wallet aligns it.`,
        },
      ];
    return [];
  }
  return opaqueCorner(map)
    ? [
        {
          code: 'THUMBNAIL_CORNERS',
          message: `${name} has square corners; round them on a transparent background.`,
        },
      ]
    : [];
}
