import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(import.meta.dirname, 'display.css'), 'utf8');

/** The three token blocks in file order: dark (default), light by media query, light by switch. */
function themes(): Record<'dark' | 'light' | 'switch', Record<string, string>> {
  const blocks = [...css.matchAll(/\{([^{}]*--sd-inset:[^{}]*)\}/g)].map((m) => m[1] ?? '');
  const parse = (body: string) =>
    Object.fromEntries(
      [...body.matchAll(/(--sd-[\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]),
    ) as Record<string, string>;
  return {
    dark: parse(blocks[0] ?? ''),
    light: parse(blocks[1] ?? ''),
    switch: parse(blocks[2] ?? ''),
  };
}

const lin = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const lum = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

describe('display tokens', () => {
  const t = themes();
  it('define the same names in every theme', () => {
    expect(Object.keys(t.light).sort()).toEqual(Object.keys(t.dark).sort());
    expect(t.switch).toEqual(t.light);
  });

  for (const theme of ['dark', 'light'] as const) {
    const v = t[theme];
    it(`chip and note pairs are at least 4.5:1 in ${theme}`, () => {
      for (const tone of ['gold', 'violet', 'teal', 'neutral']) {
        expect(
          contrast(v[`--sd-chip-${tone}-bg`] ?? '', v[`--sd-chip-${tone}-fg`] ?? ''),
          tone,
        ).toBeGreaterThanOrEqual(4.5);
      }
      expect(
        contrast(v['--sd-note-info-bg'] ?? '', v['--sd-note-info-fg'] ?? ''),
      ).toBeGreaterThanOrEqual(4.5);
    });
    it(`text on the inset panel is at least 4.5:1 in ${theme}`, () => {
      for (const name of ['--sd-strong', '--sd-body', '--sd-muted']) {
        expect(contrast(v['--sd-inset'] ?? '', v[name] ?? ''), name).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`template tones on the inset panel are at least 3:1 in ${theme} (stamps, icons)`, () => {
      for (const tone of ['violet', 'teal', 'gold']) {
        expect(
          contrast(v['--sd-inset'] ?? '', v[`--sd-tone-${tone}`] ?? ''),
          tone,
        ).toBeGreaterThanOrEqual(3);
      }
    });
  }
});

describe('/scan stays free of the authored display schema', () => {
  const SRC = join(import.meta.dirname, '..');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) return walk(p);
      return /\.tsx?$/.test(n) && !n.includes('.test') ? [p] : [];
    });
  it('imports only the icon ids from passkit scan-display', () => {
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/from '([^']*scan-display\/[^']*)'/g)) {
        expect(m[1], file).toMatch(/scan-display\/icons\.ts$/);
      }
      expect(text, file).not.toMatch(/renderScanDisplay|scan-display:render/);
    }
  });
});
