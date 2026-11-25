import { describe, expect, it } from 'vitest';
import { THEME_COLOR } from '../generated/resolved-tokens.ts';
import { ACCENT_PRESETS } from './accent-presets.ts';
import { contrast, parseColor } from './pass-view/color.ts';

const WHITE = { r: 255, g: 255, b: 255 };
const rgb = (hex: string) => {
  const c = parseColor(hex);
  if (!c) throw new Error(`bad colour ${hex}`);
  return c;
};

describe('accent presets', () => {
  it('offers nine', () => {
    expect(ACCENT_PRESETS).toHaveLength(9);
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

  it.each(ACCENT_PRESETS.map((p) => [p.name, p.hex]))(
    '%s passes 4.5:1 with white text and 3:1 on both pages',
    (_n, hex) => {
      const c = rgb(hex as string);
      expect(contrast(c, WHITE)).toBeGreaterThanOrEqual(4.5);
      for (const page of Object.values(THEME_COLOR))
        expect(contrast(c, rgb(page))).toBeGreaterThanOrEqual(3);
    },
  );
});
