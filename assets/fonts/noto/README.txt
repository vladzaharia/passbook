Noto Sans, the fallback behind Rubik on the printed ticket (SIL Open Font License 1.1, OFL-NotoSans.txt).

Source: npm package @fontsource-variable/noto-sans 5.3.0 (Noto Sans from github.com/notofonts/latin-greek-cyrillic),
files/noto-sans-{vietnamese,greek,cyrillic}-wght-normal.woff2, unchanged. The package is not a dependency;
install it temporarily to refresh these files.

Subset ranges (the packages' own unicode-range values; the same list is in src/web/paper/fallback-font.ts):
  vietnamese  U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB
  greek       U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF
  cyrillic    U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116

NotoSans-Regular.ttf and NotoSans-Bold.ttf are static instances (wght 400, 700) of those three files plus the
package's latin file, merged and subset to Basic Latin, Latin-1 and the ranges above, for the PDF
(tools/build-noto-fonts.sh). Modified Versions; no Reserved Font Name is declared.

`npm run gen` copies the woff2 files to public/fonts/noto and the TTFs to public/fonts/pdf.
