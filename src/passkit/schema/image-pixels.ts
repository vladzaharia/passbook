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
  const map = decodePixels(bytes);
  return map ? { width: map.width, height: map.height, alpha: map.alpha } : null;
}

/** Alpha plus 8-bit RGB (three bytes per pixel) of a PNG; same formats as `decodeAlpha`. */
export interface PixelMap extends AlphaMap {
  rgb: Uint8Array;
}

export function decodePixels(bytes: Uint8Array): PixelMap | null {
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
  let plte: Uint8Array | null = null;
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = view.getUint32(at);
    const kind = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (kind === 'IDAT') idat.push(data);
    else if (kind === 'tRNS') trns = data;
    else if (kind === 'PLTE') plte = data;
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
  const rgb = new Uint8Array(width * height * 3);
  const step = depth / 8;
  for (let p = 0; p < width * height; p++) {
    const base = p * bpp;
    const sample = (c: number) => pixels[base + c * step] as number;
    if (type === 3) {
      const at = sample(0) * 3;
      for (let c = 0; c < 3; c++) rgb[p * 3 + c] = plte?.[at + c] ?? 0;
    } else if (type === 0 || type === 4) rgb.fill(sample(0), p * 3, p * 3 + 3);
    else for (let c = 0; c < 3; c++) rgb[p * 3 + c] = sample(c);
    if (type === 4 || type === 6) alpha[p] = pixels[base + (channels - 1) * step] as number;
    else if (type === 3)
      alpha[p] =
        trns && (pixels[base] as number) < trns.length
          ? (trns[pixels[base] as number] as number)
          : 255;
    else alpha[p] = 255;
  }
  return { width, height, alpha, rgb };
}

/** Share of fully transparent columns and rows at each edge. */
export function transparentMargins(map: AlphaMap): {
  leading: number;
  top: number;
  trailing: number;
  bottom: number;
} {
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
  let right = 0;
  while (right < width - left && clearColumn(width - 1 - right)) right++;
  let bottom = 0;
  while (bottom < height - top && clearRow(height - 1 - bottom)) bottom++;
  return {
    leading: left / width,
    top: top / height,
    trailing: right / width,
    bottom: bottom / height,
  };
}

const linear = (c: number) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const relative = (r: number, g: number, b: number) =>
  0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

/**
 * Contrast of `foreground` (rgb) against the mean luminance of the top `share` of the image,
 * where the logo and header fields sit. Transparent pixels are skipped.
 */
export function headerContrast(
  map: PixelMap,
  foreground: [number, number, number],
  share = 0.15,
): number | undefined {
  const rows = Math.max(1, Math.round(map.height * share));
  let sum = 0;
  let count = 0;
  for (let i = 0; i < rows * map.width; i++) {
    if ((map.alpha[i] as number) < 128) continue;
    sum += relative(
      map.rgb[i * 3] as number,
      map.rgb[i * 3 + 1] as number,
      map.rgb[i * 3 + 2] as number,
    );
    count++;
  }
  if (!count) return undefined;
  const bg = sum / count;
  const fg = relative(...foreground);
  return (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
}

/** True when the top-left pixel is opaque: the thumbnail is square, not rounded on transparent. */
export const opaqueCorner = (map: AlphaMap): boolean => (map.alpha[0] as number) > 8;

/** `rgb(r, g, b)` or `#rrggbb`/`#rgb` to channels; undefined for anything else. */
export function parseColor(value: unknown): [number, number, number] | undefined {
  if (typeof value !== 'string') return undefined;
  const m = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(value);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  const h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)?.[1];
  if (!h) return undefined;
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

export interface PixelIssue {
  code: 'IMAGE_PADDING' | 'THUMBNAIL_CORNERS' | 'COLOR_CONTRAST';
  message: string;
}

/**
 * IMAGE_PADDING on logo slots (over 15% clear at any edge), THUMBNAIL_CORNERS, and COLOR_CONTRAST
 * for artwork and background under the header when the pass's foreground colour is known.
 */
export function pixelIssues(
  name: string,
  slot: string,
  bytes: Uint8Array,
  foreground?: [number, number, number],
): PixelIssue[] {
  if (foreground && (slot === 'artwork' || slot === 'background')) {
    const map = decodePixels(bytes);
    const ratio = map ? headerContrast(map, foreground) : undefined;
    return ratio !== undefined && ratio < 3
      ? [
          {
            code: 'COLOR_CONTRAST',
            message: `The header text is ${ratio.toFixed(1)}:1 against ${name}; darken the top of the image or change the text colour (3:1 minimum).`,
          },
        ]
      : [];
  }
  const logo = slot === 'logo' || slot === 'primaryLogo' || slot === 'secondaryLogo';
  if (!logo && slot !== 'thumbnail') return [];
  const map = decodeAlpha(bytes);
  if (!map) return [];
  if (logo) {
    const m = transparentMargins(map);
    if (Math.max(m.leading, m.top, m.trailing, m.bottom) > 0.15)
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
