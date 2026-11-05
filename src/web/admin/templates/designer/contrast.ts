import { contrast, parseColor, type Rgb } from '@/shared/pass-view/color.ts';
import type { Dict } from './model.ts';

export { contrast, parseColor, type Rgb };

export const toHex = ({ r, g, b }: Rgb): string =>
  `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;

/** How a color is stored in the pass: the Wallet document form. */
export const toRgbText = ({ r, g, b }: Rgb): string => `rgb(${r},${g},${b})`;

export interface ContrastWarning {
  key: 'foregroundColor' | 'labelColor';
  ratio: number;
  message: string;
}

/** The server's thresholds (passkit validate-hig): text 4.5:1, labels 3:1. */
const NEED = { foregroundColor: 4.5, labelColor: 3 } as const;

/** Text colors against the card color, worded as the server words them. */
export function contrastWarnings(pass: Dict): ContrastWarning[] {
  const bg = parseColor(pass.backgroundColor);
  if (!bg) return [];
  const out: ContrastWarning[] = [];
  for (const [key, name] of [
    ['foregroundColor', 'Text'],
    ['labelColor', 'Label'],
  ] as const) {
    const fg = parseColor(pass[key]);
    if (!fg) continue;
    const ratio = contrast(fg, bg);
    if (ratio < NEED[key])
      out.push({
        key,
        ratio,
        message: `${name} contrast is ${ratio.toFixed(1)}:1; use at least ${NEED[key]}:1.`,
      });
  }
  return out;
}
