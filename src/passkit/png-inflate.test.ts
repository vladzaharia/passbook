import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { decodeAlpha } from './schema/image-pixels.ts';
import { decodePng, encodePng, PngError } from './stamps/png.ts';

const te = new TextEncoder();

/** A valid 200x200 RGBA PNG whose IDAT is replaced by `idat` (and the IHDR size by `size`). */
function withIdat(idat: Uint8Array, size: [number, number] = [200, 200]): Uint8Array {
  const base = encodePng({
    width: 200,
    height: 200,
    data: new Uint8Array(200 * 200 * 4).fill(254),
  });
  const head = new Uint8Array(base.subarray(0, 33));
  const dv = new DataView(head.buffer);
  dv.setUint32(16, size[0]);
  dv.setUint32(20, size[1]);
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, idat.length);
  const chunks = [
    head,
    len,
    te.encode('IDAT'),
    idat,
    new Uint8Array(4),
    new Uint8Array(4),
    te.encode('IEND'),
    new Uint8Array(4),
  ];
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// 100 MB of zeros deflates to about 100 KB: a decompression bomb for a 200x200 image.
const bomb = () => withIdat(zlibSync(new Uint8Array(100_000_000), { level: 9 }));

describe('PNG decoding is bounded', () => {
  it('refuses an IDAT bomb quickly and without a big allocation', () => {
    const png = bomb();
    const before = process.memoryUsage().arrayBuffers;
    let peak = 0;
    const t = Date.now();
    expect(() => decodePng(png)).toThrow(PngError);
    peak = process.memoryUsage().arrayBuffers - before;
    expect(Date.now() - t).toBeLessThan(2000);
    expect(peak).toBeLessThan(20_000_000);
    expect(decodeAlpha(png)).toBeNull();
  });

  it('refuses zero and huge dimensions', () => {
    const ok = encodePng({ width: 8, height: 8, data: new Uint8Array(256).fill(255) });
    for (const [w, h] of [
      [2 ** 30, 0],
      [0, 8],
      [8, 0],
      [2 ** 30, 1],
    ] as const) {
      const bad = new Uint8Array(ok);
      new DataView(bad.buffer).setUint32(16, w);
      new DataView(bad.buffer).setUint32(20, h);
      expect(() => decodePng(bad)).toThrow(PngError);
      expect(decodeAlpha(bad)).toBeNull();
    }
    expect(decodePng(ok).width).toBe(8);
  });

  it('refuses truncated data and a stream larger than its header says', () => {
    const full = zlibSync(new Uint8Array(200 * 801).fill(0));
    expect(() => decodePng(withIdat(full.subarray(0, full.length - 6)))).toThrow(PngError);
    expect(() => decodePng(withIdat(zlibSync(new Uint8Array(200 * 801 + 1))))).toThrow(PngError);
    expect(decodePng(withIdat(full)).data.length).toBe(200 * 200 * 4);
  });

  it('decodes a normal PNG to the same pixels it was encoded from', () => {
    const data = new Uint8Array(32 * 32 * 4).map((_, i) => (i * 7) % 256);
    const out = decodePng(encodePng({ width: 32, height: 32, data }));
    expect(out.data).toEqual(data);
  });
});
