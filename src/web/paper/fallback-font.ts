/**
 * Noto Sans (SIL OFL 1.1, @fontsource-variable/noto-sans) behind Rubik on the sheet. Rubik has no
 * Vietnamese tone marks or Greek, and the pages serve only its Latin faces, so these three subsets
 * cover Vietnamese, Greek and Cyrillic. unicode-range keeps each file unfetched until a character
 * needs it. `npm run gen` copies the files to public/fonts/noto. No CJK: a subset is megabytes.
 */
export const FALLBACK_FAMILY = 'Noto Sans Print';
export const FALLBACK_FONTS = [
  {
    file: 'noto-sans-vietnamese-wght-normal.woff2',
    range:
      'U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB',
  },
  {
    file: 'noto-sans-greek-wght-normal.woff2',
    range: 'U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF',
  },
  {
    file: 'noto-sans-cyrillic-wght-normal.woff2',
    range: 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116',
  },
] as const;

export const FALLBACK_FONT_CSS = FALLBACK_FONTS.map(
  (f) =>
    `@font-face{font-family:"${FALLBACK_FAMILY}";font-style:normal;font-weight:100 900;font-display:swap;src:url("/fonts/noto/${f.file}") format("woff2");unicode-range:${f.range}}`,
).join('\n');
