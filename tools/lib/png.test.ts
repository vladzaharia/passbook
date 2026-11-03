import { describe, expect, it } from 'vitest';
import { decodePng, encodePng, type Image } from './png.ts';
import { quantize } from './quantize.ts';

/** A 24×16 gradient: 384 colours, some translucent, some invisible with stray RGB. */
function gradient(): Image {
  const width = 24;
  const height = 16;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data.set([x * 10, y * 15, 128, y < 2 ? 0 : y < 6 ? 40 * y : 255], i);
    }
  return { width, height, data };
}

const visible = (img: Image) =>
  img.data.map((v, i) => ((img.data[i - (i % 4) + 3] as number) === 0 ? 0 : v));

describe('png codec', () => {
  it('round-trips RGBA losslessly, clearing only invisible pixels', () => {
    const img = gradient();
    const back = decodePng(encodePng(img));
    expect([back.width, back.height]).toEqual([24, 16]);
    expect(back.data).toEqual(visible(img));
  });

  it('writes opaque art as RGB and few colours as a palette', () => {
    const opaque = gradient();
    for (let i = 3; i < opaque.data.length; i += 4) opaque.data[i] = 255;
    expect(encodePng(opaque)[25]).toBe(2);
    const colours = [
      [0, 0, 0, 0],
      [13, 17, 27, 255],
      [45, 212, 191, 255],
      [255, 255, 255, 140],
    ];
    const data = new Uint8Array(64 * 64 * 4).map((_, i) => colours[(i >> 6) % 4]?.[i % 4] ?? 0);
    const flat = { width: 64, height: 64, data };
    const png = encodePng(flat);
    expect(png[25]).toBe(3);
    expect(decodePng(png).data).toEqual(data);
  });
});

describe('quantize', () => {
  it('keeps images that already fit the palette', () => {
    const img = quantize(gradient(), 16);
    expect(quantize(img, 16)).toBe(img);
  });

  it('reduces to the palette size, deterministically, with a small error', () => {
    const img = gradient();
    const a = quantize(img, 64);
    expect(a.data).toEqual(quantize(img, 64).data);
    const colours = new Set<string>();
    let error = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      colours.add(a.data.subarray(i, i + 4).join());
      const alpha = img.data[i + 3] as number;
      for (let c = 0; c < 4; c++) {
        const w = c === 3 ? 1 : alpha / 255;
        error = Math.max(
          error,
          Math.abs((a.data[i + c] as number) - (img.data[i + c] as number)) * w,
        );
      }
    }
    expect(colours.size).toBeLessThanOrEqual(64);
    expect(error).toBeLessThan(24);
  });
});
