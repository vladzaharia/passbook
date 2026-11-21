import { describe, expect, it } from 'vitest';
import { contrast, parseColor } from '@/shared/pass-view/color.ts';
import { dominantColors, fixAccent, fixPassColors, paletteFromPixels } from './palette.ts';

/** RGBA pixels: `n` of each colour. */
const pixels = (...runs: [number, number, number, number][]) =>
  Uint8ClampedArray.from(
    runs.flatMap(([r, g, b, n]) => Array.from({ length: n }, () => [r, g, b, 255]).flat()),
  );
const ratio = (a: string, b: string) => {
  const x = parseColor(a);
  const y = parseColor(b);
  if (!x || !y) throw new Error('bad colour');
  return contrast(x, y);
};

describe('palette from a logo', () => {
  it('ranks colours by how much of the logo they fill and ignores transparent pixels', () => {
    const data = new Uint8ClampedArray([
      ...pixels([20, 33, 61, 30], [252, 163, 17, 10]),
      0,
      0,
      0,
      0,
    ]);
    const colors = dominantColors(data);
    expect(colors[0]).toMatchObject({ r: 20, g: 33, b: 61 });
    expect(colors).toHaveLength(2);
  });

  it('offers Dark, Bold and Light, each clearing Apple minimums', () => {
    const palettes = paletteFromPixels(
      pixels([20, 33, 61, 60], [252, 163, 17, 25], [240, 240, 235, 15]),
    );
    expect(palettes.map((p) => p.id)).toEqual(['dark', 'bold', 'light']);
    for (const p of palettes) {
      expect(ratio(p.foreground, p.background)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(p.label, p.background)).toBeGreaterThanOrEqual(3);
      expect(p.swatches).toEqual([p.background, p.foreground, p.label]);
    }
  });

  it('offers nothing for an empty image', () => {
    expect(paletteFromPixels(new Uint8ClampedArray([0, 0, 0, 0]))).toEqual([]);
  });
});

describe('fixes', () => {
  it('moves text and labels to the nearest passing colours and keeps the background', () => {
    const fixed = fixPassColors('#14213d', '#2a3a60', '#303a5c');
    expect(ratio(fixed.foreground, '#14213d')).toBeGreaterThanOrEqual(4.5);
    expect(ratio(fixed.label, '#14213d')).toBeGreaterThanOrEqual(3);
  });

  it('moves a faint accent until it reads on both pages', () => {
    const fixed = fixAccent('#f5f5dc');
    expect(ratio(fixed, '#f6f8ff')).toBeGreaterThanOrEqual(3);
    expect(ratio(fixed, '#060912')).toBeGreaterThanOrEqual(3);
  });
});
