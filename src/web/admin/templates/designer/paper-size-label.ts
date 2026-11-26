import { PAPER_SPECS, type PaperSize } from '@/passkit/template/paper.ts';

/** Sizes the print trade names in inches; the rest are metric. */
const INCHES = new Set<PaperSize>(['letter', 'half-letter', 'stub', 'atb']);

const trim = (n: number) => String(Math.round(n * 100) / 100);

/** "Letter, 8.5 x 11 in": the name and the sheet's size, so no option reads as a bare code. */
export function paperSizeLabel(size: PaperSize): string {
  const { label, widthMm, heightMm } = PAPER_SPECS[size];
  if (INCHES.has(size))
    return `${label}, ${trim(widthMm / 25.4)} \u00d7 ${trim(heightMm / 25.4)} in`;
  return `${label}, ${trim(widthMm)} \u00d7 ${trim(heightMm)} mm`;
}
