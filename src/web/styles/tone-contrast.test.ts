import { describe, expect, it } from 'vitest';
import { resolveTheme } from '../../../tools/lib/css-tokens.ts';
import { readSources, tokenSheet } from '../../../tools/lib/ssr-tokens.ts';

const rules = tokenSheet(readSources(process.cwd()));
const THEMES = [
  ['light', { system: 'light', attr: 'light' }],
  ['dark', { system: 'dark', attr: 'dark' }],
  ['light by system', { system: 'light' }],
  ['dark by system', { system: 'dark' }],
] as const;
const TONES = ['ok', 'heads-up', 'refused', 'system'] as const;

type Rgb = [number, number, number];
const hex = (value: string): Rgb => {
  const m = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!m?.[1]) throw new Error(`not a hex colour: ${value}`);
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
/** A colour token: a hex, or the `color-mix(in srgb, A p%, B)` the wash tokens resolve to. */
function colour(value: string): Rgb {
  const mix = /^color-mix\(in srgb,\s*(#[0-9a-f]{6})\s+(\d+)%,\s*(#[0-9a-f]{6})\)$/i.exec(value);
  if (!mix?.[1] || !mix[2] || !mix[3]) return hex(value);
  const [a, b, p] = [hex(mix[1]), hex(mix[3]), Number(mix[2]) / 100];
  return a.map((c, i) => c * p + (b[i] ?? 0) * (1 - p)) as Rgb;
}
const lum = (rgb: Rgb) => {
  const [r = 0, g = 0, b = 0] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
};

describe('tone tokens', () => {
  for (const [name, env] of THEMES) {
    const tokens = resolveTheme(rules, env);
    const get = (token: string) => {
      const v = tokens.get(token);
      if (!v) throw new Error(`${token} is not defined in ${name}`);
      return colour(v);
    };

    it(`keeps band text at 4.5:1 and the glyph at 3:1 per tone (${name})`, () => {
      for (const tone of TONES) {
        const wash = get(`--pk-tone-${tone}-wash`);
        expect(ratio(get(`--pk-tone-${tone}`), wash), `${tone} text`).toBeGreaterThanOrEqual(4.5);
        expect(ratio(get('--pk-text-strong'), wash), `${tone} headline`).toBeGreaterThanOrEqual(
          4.5,
        );
        expect(
          ratio(get(`--pk-tone-${tone}`), get('--pk-surface-page')),
          `${tone} glyph`,
        ).toBeGreaterThanOrEqual(3);
      }
    });

    it(`keeps the slate readable (${name})`, () => {
      const bg = get('--pk-slate-bg');
      expect(ratio(get('--pk-slate-fg'), bg), 'slate text').toBeGreaterThanOrEqual(4.5);
      expect(ratio(get('--pk-slate-line'), bg), 'slate line').toBeGreaterThanOrEqual(3);
    });

    it(`washes 10 % in light and 14 % in dark (${name})`, () => {
      const wash = tokens.get('--pk-tone-wash');
      expect(wash).toBe(
        env.system === 'light' && (env as { attr?: string }).attr !== 'dark' ? '10%' : '14%',
      );
    });
  }
});
