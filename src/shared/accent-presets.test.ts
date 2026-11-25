import { describe, expect, it } from 'vitest';
import { ACCENT_PRESETS } from './accent-presets.ts';
import { contrast, parseColor } from './pass-view/color.ts';

const WHITE = { r: 255, g: 255, b: 255 };
const rgb = (hex: string) => {
  const c = parseColor(hex);
  if (!c) throw new Error(`bad colour ${hex}`);
  return c;
};

describe('accent presets', () => {
  it('offers nine, keeping the first six blueprint colours', () => {
    expect(ACCENT_PRESETS).toHaveLength(9);
    expect(ACCENT_PRESETS.slice(0, 6).map((p) => p.hex)).toEqual([
      '#0f766e',
      '#4338ca',
      '#be123c',
      '#c2410c',
      '#1d4ed8',
      '#0f172a',
    ]);
  });

  it('has distinct names and colours that are far apart', () => {
    expect(new Set(ACCENT_PRESETS.map((p) => p.name)).size).toBe(9);
    for (const [i, a] of ACCENT_PRESETS.entries())
      for (const b of ACCENT_PRESETS.slice(i + 1)) {
        const x = rgb(a.hex);
        const y = rgb(b.hex);
        expect(Math.hypot(x.r - y.r, x.g - y.g, x.b - y.b)).toBeGreaterThan(40);
      }
  });

  it.each(ACCENT_PRESETS.map((p) => [p.name, p.hex]))('%s reads with white text', (_n, hex) => {
    expect(contrast(rgb(hex as string), WHITE)).toBeGreaterThanOrEqual(4.5);
  });
});
