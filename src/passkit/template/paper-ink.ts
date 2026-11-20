/**
 * Ink: the template's colours as a printer sees them. A paper band is drawn in the pass colours;
 * on a black and white laser a pastel band vanishes and a mid-tone pair loses its text. The check
 * converts both colours to grey and falls back to the mono band when they would not read.
 */
import { parseColor } from '../schema/image-pixels.ts';
import type { PassJson } from '../types.ts';

export interface PaperColors {
  bg: string;
  fg: string;
  label: string;
}

const DEFAULT_COLORS: PaperColors = { bg: '#333333', fg: '#ffffff', label: '#dddddd' };
/** Above this L* a band is nearly white on paper. */
const LIGHT_BAND = 80;
const MIN_GREY_CONTRAST = 4.5;

const hex = (rgb: [number, number, number]) =>
  `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;

/** The pass's colours as `#rrggbb`; anything missing or unparseable takes the default. */
export function paperColors(
  pass: Pick<PassJson, 'backgroundColor' | 'foregroundColor' | 'labelColor'>,
): PaperColors {
  const pick = (value: unknown, fallback: string) => {
    const rgb = parseColor(value);
    return rgb ? hex(rgb) : fallback;
  };
  const bg = pick(pass.backgroundColor, DEFAULT_COLORS.bg);
  return {
    bg,
    fg: pick(pass.foregroundColor, DEFAULT_COLORS.fg),
    label: pick(pass.labelColor, pick(pass.foregroundColor, DEFAULT_COLORS.label)),
  };
}

const linear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** Relative luminance Y of a `#rrggbb` colour, 0 to 1. */
export function luminance(color: string): number {
  const rgb = parseColor(color) ?? [0, 0, 0];
  return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
}

/** CIE lightness L* of a colour, 0 to 100. */
export function lightness(color: string): number {
  const y = luminance(color);
  return y > 216 / 24389 ? 116 * y ** (1 / 3) - 16 : (24389 / 27) * y;
}

/** Contrast ratio of two colours after conversion to grey (luminance only). */
export function greyContrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Whether the colour band survives greyscale; false means the mono band is used. */
export function paperInk(
  pass: Pick<PassJson, 'backgroundColor' | 'foregroundColor' | 'labelColor'>,
): {
  colour: boolean;
  colors: PaperColors;
} {
  const colors = paperColors(pass);
  const colour =
    lightness(colors.bg) <= LIGHT_BAND && greyContrast(colors.bg, colors.fg) >= MIN_GREY_CONTRAST;
  return { colour, colors };
}
