import { FALLBACK_FONTS } from '../../../web/paper/fallback-font.ts';

/** What Rubik holds in print; keep in step with `text` in tools/build-pdf-fonts.sh. */
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
/** The Noto Sans fallback's subsets (src/web/paper/fallback-font.ts): Vietnamese, Greek, Cyrillic. */
const FALLBACK_RANGES: [number, number][] = FALLBACK_FONTS.flatMap((f) =>
  f.range.split(',').map((r): [number, number] => {
    const [a = '', b = a] = r.replaceAll('U+', '').split('-');
    return [Number.parseInt(a, 16), Number.parseInt(b, 16)];
  }),
);
const within = (ranges: [number, number][], cp: number) =>
  ranges.some(([a, b]) => cp >= a && cp <= b);
const primary = (cp: number) => within(RANGES, cp);
const fallback = (cp: number) => within(FALLBACK_RANGES, cp);

/** True when Rubik lacks the code point (or its compatibility form) and Noto Sans has it. */
export function inFallback(c: string): boolean {
  const cp = c.codePointAt(0) ?? 0;
  const nfkc = c.normalize('NFKC').codePointAt(0) ?? 0;
  return !primary(cp) && !primary(nfkc) && (fallback(cp) || fallback(nfkc));
}

function anyChar(value: unknown, test: (c: string) => boolean): boolean {
  if (typeof value === 'string')
    return [...value.normalize('NFC')].some((c) => (c.codePointAt(0) ?? 0) > 0x20 && test(c));
  if (Array.isArray(value)) return value.some((v) => anyChar(v, test));
  if (value && typeof value === 'object') return Object.values(value).some((v) => anyChar(v, test));
  return false;
}

/** True when any string in the value needs the Noto Sans fallback (Rubik lacks a character). */
export const needsFallback = (value: unknown) => anyChar(value, inFallback);

/** True when any string in the value holds a character neither Rubik nor Noto Sans can draw. */
export const hasUndrawable = (value: unknown) =>
  anyChar(value, (c) => {
    const cp = c.codePointAt(0) ?? 0;
    const nfkc = c.normalize('NFKC').codePointAt(0) ?? 0;
    return !(primary(cp) || primary(nfkc) || fallback(cp) || fallback(nfkc));
  });
