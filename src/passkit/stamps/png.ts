// Minimal deterministic PNG codec on fflate (already a passkit dependency): 8-bit, non-interlaced
// decode to RGBA; encode RGB or RGBA with the smallest-sum filter per row. Same input and the same
// fflate version give the same bytes in workerd, Node and browsers.
import { unzlibSync, zlibSync } from 'fflate';

export interface Rgba {
  width: number;
  height: number;
  /** Straight (not premultiplied) RGBA, 4 bytes per pixel. */
  data: Uint8Array;
}

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, from = 0, to = bytes.length): number {
  let c = 0xffffffff;
  for (let i = from; i < to; i++)
    c = (CRC[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

export class PngError extends Error {}

export function decodePng(bytes: Uint8Array): Rgba {
  if (bytes.length < 33 || SIG.some((b, i) => bytes[i] !== b)) throw new PngError('Not a PNG.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const depth = bytes[24] as number;
  const type = bytes[25] as number;
  const channels = CHANNELS[type];
  if (!channels || depth !== 8 || bytes[28] !== 0)
    throw new PngError('Use an 8-bit, non-interlaced PNG.');
  if (width * height > 1_000_000) throw new PngError('Stamp art is larger than 1 megapixel.');
  const idat: Uint8Array[] = [];
  let plte: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = view.getUint32(at);
    const kind = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (kind === 'IDAT') idat.push(data);
    else if (kind === 'PLTE') plte = data;
    else if (kind === 'tRNS') trns = data;
    else if (kind === 'IEND') break;
    at += 12 + length;
  }
  const joined = new Uint8Array(idat.reduce((n, d) => n + d.length, 0));
  let o = 0;
  for (const d of idat) {
    joined.set(d, o);
    o += d.length;
  }
  const raw = unzlibSync(joined);
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new PngError('PNG data is truncated.');
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)] as number;
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? (px[row + i - channels] as number) : 0;
      const b = y > 0 ? (px[row - stride + i] as number) : 0;
      const c = y > 0 && i >= channels ? (px[row - stride + i - channels] as number) : 0;
      const x = raw[src + i] as number;
      px[row + i] =
        (f === 1
          ? x + a
          : f === 2
            ? x + b
            : f === 3
              ? x + ((a + b) >> 1)
              : f === 4
                ? x + paeth(a, b, c)
                : x) & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const s = p * channels;
    const d = p * 4;
    if (type === 6) data.set(px.subarray(s, s + 4), d);
    else if (type === 2) {
      data.set(px.subarray(s, s + 3), d);
      data[d + 3] = 255;
    } else if (type === 3) {
      const k = px[s] as number;
      data[d] = plte?.[k * 3] ?? 0;
      data[d + 1] = plte?.[k * 3 + 1] ?? 0;
      data[d + 2] = plte?.[k * 3 + 2] ?? 0;
      data[d + 3] = trns && k < trns.length ? (trns[k] as number) : 255;
    } else {
      const g = px[s] as number;
      data[d] = g;
      data[d + 1] = g;
      data[d + 2] = g;
      data[d + 3] = type === 4 ? (px[s + 1] as number) : 255;
    }
  }
  return { width, height, data };
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** RGB when every pixel is opaque, else RGBA. `level` is the deflate level (fflate). */
export function encodePng(img: Rgba, level: 6 | 9 = 6): Uint8Array {
  const { width, height, data } = img;
  let opaque = true;
  for (let i = 3; i < data.length; i += 4)
    if (data[i] !== 255) {
      opaque = false;
      break;
    }
  const bpp = opaque ? 3 : 4;
  const stride = width * bpp;
  const packed = new Uint8Array(stride * height);
  if (opaque)
    for (let p = 0, q = 0; p < data.length; p += 4, q += 3) packed.set(data.subarray(p, p + 3), q);
  else packed.set(data);
  const out = new Uint8Array((stride + 1) * height);
  const cand = Array.from({ length: 5 }, () => new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    let best = 0;
    let bestSum = Number.POSITIVE_INFINITY;
    for (let f = 0; f < 5; f++) {
      const line = cand[f] as Uint8Array;
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const x = packed[row + i] as number;
        const a = i >= bpp ? (packed[row + i - bpp] as number) : 0;
        const b = y > 0 ? (packed[row - stride + i] as number) : 0;
        const c = y > 0 && i >= bpp ? (packed[row - stride + i - bpp] as number) : 0;
        const pred =
          f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? paeth(a, b, c) : 0;
        const v = (x - pred) & 0xff;
        line[i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = f;
      }
    }
    out[y * (stride + 1)] = best;
    out.set(cand[best] as Uint8Array, y * (stride + 1) + 1);
  }
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header.set([8, opaque ? 2 : 6, 0, 0, 0], 8);
  const parts = [
    new Uint8Array(SIG),
    chunk('IHDR', header),
    chunk('IDAT', zlibSync(out, { level })),
    chunk('IEND', new Uint8Array(0)),
  ];
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    bytes.set(p, o);
    o += p.length;
  }
  return bytes;
}
