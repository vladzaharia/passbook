// A small lossless PNG codec for tools/build-email-art.ts: 8-bit RGB(A) in, the smallest of
// palette, RGB or RGBA out, rows filtered per row and deflated at level 9.
import { deflateSync, inflateSync } from 'node:zlib';

export interface Image {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

function predict(type: number, a: number, b: number, c: number): number {
  if (type === 1) return a;
  if (type === 2) return b;
  if (type === 3) return (a + b) >> 1;
  if (type === 4) return paeth(a, b, c);
  return 0;
}

/** Decodes an 8-bit, non-interlaced palette, RGB or RGBA PNG (Chromium's and encodePng's). */
export function decodePng(file: Uint8Array): Image {
  const buf = Buffer.from(file);
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG.');
  let width = 0;
  let height = 0;
  let channels = 0;
  let palette = Buffer.alloc(0);
  let alpha = Buffer.alloc(0);
  const idat: Buffer[] = [];
  for (let at = 8; at < buf.length; ) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString('ascii', at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, color, , , interlace] = [body[8], body[9], body[10], body[11], body[12]];
      channels = color === 6 ? 4 : color === 2 ? 3 : color === 3 ? 1 : 0;
      if (depth !== 8 || !channels || interlace) throw new Error('Unsupported PNG format.');
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') alpha = body;
    else if (type === 'IDAT') idat.push(body);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const type = raw[y * (stride + 1)] as number;
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x;
      const a = x >= channels ? (rows[i - channels] as number) : 0;
      const b = y > 0 ? (rows[i - stride] as number) : 0;
      const c = x >= channels && y > 0 ? (rows[i - stride - channels] as number) : 0;
      rows[i] = ((raw[y * (stride + 1) + 1 + x] as number) + predict(type, a, b, c)) & 0xff;
    }
  }
  if (channels === 4) return { width, height, data: rows };
  const data = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const k = rows[p] as number;
    const rgb =
      channels === 3 ? rows.subarray(p * 3, p * 3 + 3) : palette.subarray(k * 3, k * 3 + 3);
    data.set(rgb, p * 4);
    data[p * 4 + 3] = channels === 3 ? 255 : (alpha[k] ?? 255);
  }
  return { width, height, data };
}

/** Filters each row with the type whose output has the smallest sum of absolute values. */
function filterRows(pixels: Uint8Array, stride: number, bpp: number, height: number): Uint8Array {
  const out = new Uint8Array((stride + 1) * height);
  const line = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    let best = Number.POSITIVE_INFINITY;
    for (let type = 0; type <= 4; type++) {
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const i = y * stride + x;
        const a = x >= bpp ? (pixels[i - bpp] as number) : 0;
        const b = y > 0 ? (pixels[i - stride] as number) : 0;
        const c = x >= bpp && y > 0 ? (pixels[i - stride - bpp] as number) : 0;
        const v = ((pixels[i] as number) - predict(type, a, b, c)) & 0xff;
        line[x] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < best) {
        best = score;
        out[y * (stride + 1)] = type;
        out.set(line, y * (stride + 1) + 1);
      }
    }
  }
  return out;
}

function encodeAs(image: Image, color: 2 | 3 | 6, palette?: Map<number, number>): Buffer {
  const { width, height, data } = image;
  const bpp = color === 6 ? 4 : color === 2 ? 3 : 1;
  const pixels = new Uint8Array(width * height * bpp);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let p = 0; p < width * height; p++) {
    if (color === 3) pixels[p] = palette?.get(view.getUint32(p * 4)) ?? 0;
    else pixels.set(data.subarray(p * 4, p * 4 + bpp), p * bpp);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, color, 0, 0, 0], 8);
  const parts = [SIGNATURE, chunk('IHDR', ihdr)];
  if (color === 3 && palette) {
    const keys = [...palette.keys()];
    parts.push(
      chunk(
        'PLTE',
        Buffer.from(keys.flatMap((k) => [k >>> 24, (k >>> 16) & 255, (k >>> 8) & 255])),
      ),
    );
    const alpha = keys.map((k) => k & 255);
    const last = alpha.findLastIndex((a) => a < 255);
    if (last >= 0) parts.push(chunk('tRNS', Buffer.from(alpha.slice(0, last + 1))));
  }
  // Palette indices compress best unfiltered.
  const raw =
    color === 3
      ? unfilteredRows(pixels, width, height)
      : filterRows(pixels, width * bpp, bpp, height);
  parts.push(chunk('IDAT', deflateSync(raw, { level: 9, memLevel: 9 })));
  parts.push(chunk('IEND', new Uint8Array(0)));
  return Buffer.concat(parts);
}

function unfilteredRows(pixels: Uint8Array, stride: number, height: number): Buffer {
  const out = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++)
    out.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return out;
}

/** Re-encodes losslessly: invisible pixels cleared, then the smallest colour type wins. */
export function encodePng(image: Image): Buffer {
  const data = Uint8Array.from(image.data);
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] === 0) data.fill(0, i, i + 3);
  const clean = { ...image, data };
  const view = new DataView(data.buffer);
  const unique = new Set<number>();
  for (let i = 0; i < data.length && unique.size <= 256; i += 4) unique.add(view.getUint32(i));
  const opaque = data.every((v, i) => i % 4 !== 3 || v === 255);
  const candidates = [encodeAs(clean, opaque ? 2 : 6)];
  if (unique.size <= 256) {
    // Translucent entries first, so tRNS stops at the last of them.
    const keys = [...unique].sort((a, b) => (a & 255) - (b & 255));
    candidates.push(encodeAs(clean, 3, new Map(keys.map((k, i) => [k, i]))));
  }
  return candidates.reduce((a, b) => (b.length < a.length ? b : a));
}
