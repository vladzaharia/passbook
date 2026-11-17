// PNG encoder for the generated art: RGBA8, per-row adaptive filters (None, Sub, Up, Average,
// Paeth), which keeps the event art under the package budget. Deterministic.
import { deflateSync } from 'node:zlib';

export type Rgb = [number, number, number];
export type Pixel = [number, number, number, number];
/** x, y in points; W, H = image size in points; s = pixels per point. */
export type Painter = (x: number, y: number, W: number, H: number, s: number) => Pixel;

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};
/** Filters one row with each type and keeps the one with the smallest sum of signed magnitudes. */
function filterRow(row: Uint8Array, prev: Uint8Array | undefined, out: Uint8Array, at: number): void {
  let best = Number.POSITIVE_INFINITY;
  const trial = new Uint8Array(row.length);
  for (let type = 0; type < 5; type++) {
    let sum = 0;
    for (let i = 0; i < row.length; i++) {
      const a = i >= 4 ? (row[i - 4] as number) : 0;
      const b = prev ? (prev[i] as number) : 0;
      const c = prev && i >= 4 ? (prev[i - 4] as number) : 0;
      const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][type] as number;
      const v = ((row[i] as number) - pred) & 0xff;
      trial[i] = v;
      sum += v < 128 ? v : 256 - v;
    }
    if (sum < best) {
      best = sum;
      out[at] = type;
      out.set(trial, at + 1);
    }
  }
}

export function png(wPt: number, hPt: number, s: number, paint: Painter): Uint8Array {
  const w = wPt * s;
  const h = hPt * s;
  const stride = w * 4;
  const rgba = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      rgba.set(paint((x + 0.5) / s, (y + 0.5) / s, wPt, hPt, s), (y * w + x) * 4);
  const filtered = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++)
    filterRow(
      rgba.subarray(y * stride, (y + 1) * stride),
      y > 0 ? rgba.subarray((y - 1) * stride, y * stride) : undefined,
      filtered,
      y * (stride + 1),
    );
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, w);
  new DataView(header.buffer).setUint32(4, h);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(filtered, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
