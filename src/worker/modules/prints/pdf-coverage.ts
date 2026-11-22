/** What the printed fonts hold; keep in step with `text` in tools/build-pdf-fonts.sh. */
const RANGES: [number, number][] = [
  [0x20, 0x7e],
  [0xa0, 0x24f],
  [0x300, 0x36f],
  [0x400, 0x52f],
  [0x2010, 0x2027],
  [0x2030, 0x203a],
  [0x20a0, 0x20bf],
  [0x2116, 0x2116],
  [0x2122, 0x2122],
  [0x2190, 0x2193],
  [0x2212, 0x2212],
  [0x2215, 0x2215],
  [0x2260, 0x2260],
  [0x2264, 0x2265],
];
/** What the print page adds in Noto Sans (src/web/paper/fallback-font.ts): Vietnamese, Greek. */
const PAGE_RANGES: [number, number][] = [
  [0x1e00, 0x1eff],
  [0x370, 0x3ff],
];
const within = (ranges: [number, number][], cp: number) =>
  ranges.some(([a, b]) => cp >= a && cp <= b);

/**
 * True when any string in the value holds a character the fonts cannot draw as written. The PDF
 * fonts are Rubik only; the `page` scope adds the print page's Noto Sans fallback.
 */
export function hasUndrawable(value: unknown, scope: 'pdf' | 'page' = 'pdf'): boolean {
  const ranges = scope === 'page' ? [...RANGES, ...PAGE_RANGES] : RANGES;
  if (typeof value === 'string')
    return [...value.normalize('NFC')].some((c) => {
      const cp = c.codePointAt(0) ?? 0;
      return (
        cp > 0x20 && !within(ranges, cp) && !within(ranges, c.normalize('NFKC').codePointAt(0) ?? 0)
      );
    });
  if (Array.isArray(value)) return value.some((v) => hasUndrawable(v, scope));
  if (value && typeof value === 'object')
    return Object.values(value).some((v) => hasUndrawable(v, scope));
  return false;
}
