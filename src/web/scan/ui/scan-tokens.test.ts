import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(import.meta.dirname, 'scan.css'), 'utf8');
const tok = (name: string) => new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(css)?.[1] ?? '';
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
const z = (name: string) => Number(new RegExp(`--scan-z-${name}:\\s*(\\d+)`).exec(css)?.[1]);

describe('scan tokens', () => {
  it('each verdict hue holds its on-colour at 4.5:1 or more (both themes share them)', () => {
    for (const [hue, on, min] of [
      ['ok', 'ok-on', 8],
      ['heads', 'heads-on', 8],
      ['refused', 'refused-on', 6.4],
      ['system', 'system-on', 10],
    ] as const) {
      expect(contrast(tok(`--scan-${hue}`), tok(`--scan-${on}`)), hue).toBeGreaterThanOrEqual(min);
    }
  });

  it('keeps BF z-order: camera < dock < card < buddy < capsule < ring', () => {
    const order = ['cam', 'dock', 'card', 'buddy', 'capsule', 'ring'].map(z);
    expect(order.every(Number.isFinite)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(z('tuck')).toBeLessThan(z('dock'));
  });

  it('moves nothing but opacity for the tint, and not at all under reduced motion', () => {
    const block =
      /@media \(prefers-reduced-motion: no-preference\)\s*\{[^{}]*\{[^}]*\}\s*\}/.exec(css)?.[0] ??
      '';
    expect(block).toMatch(/transition: opacity 80ms linear/);
    expect(css.replace(/\/\*[\s\S]*?\*\//g, '').replace(block, '')).not.toMatch(/transition/);
  });

  it('falls back to opaque glass under reduced transparency', () => {
    expect(css).toMatch(/prefers-reduced-transparency: reduce[\s\S]*scan-glass-solid/);
  });
});
