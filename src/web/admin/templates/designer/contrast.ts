import type { Dict } from './model.ts';

export type Rgb = readonly [number, number, number];

/** `rgb(r,g,b)`, `#rgb` and `#rrggbb`; null for anything else. */
export function parseColor(value: unknown): Rgb | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(text);
  if (rgb) {
    const parts = [rgb[1], rgb[2], rgb[3]].map(Number) as [number, number, number];
    return parts.every((n) => n <= 255) ? parts : null;
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text)?.[1];
  if (!hex) return null;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

export const toHex = ([r, g, b]: Rgb): string =>
  `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;

export const toRgbText = ([r, g, b]: Rgb): string => `rgb(${r},${g},${b})`;

function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export interface ContrastWarning {
  key: 'foregroundColor' | 'labelColor';
  ratio: number;
  message: string;
}

const NEED = 4.5;

/** Text colors against the card color, at the AA ratio for small text. */
export function contrastWarnings(pass: Dict): ContrastWarning[] {
  const bg = parseColor(pass.backgroundColor);
  if (!bg) return [];
  const out: ContrastWarning[] = [];
  for (const [key, name] of [
    ['foregroundColor', 'Text'],
    ['labelColor', 'Labels'],
  ] as const) {
    const fg = parseColor(pass[key]);
    if (!fg) continue;
    const ratio = contrast(fg, bg);
    if (ratio < NEED)
      out.push({
        key,
        ratio,
        message: `${name} are hard to read on this background (${ratio.toFixed(1)}:1; use ${NEED}:1 or more).`,
      });
  }
  return out;
}
