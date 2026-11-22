#!/bin/sh
# Rebuilds assets/fonts/noto/NotoSans-{Regular,Bold}.ttf, the static fallback faces the ticket PDF
# embeds (pdf-lib embeds static fonts only): Noto Sans at wght 400 and 700, Basic Latin and Latin-1
# plus the three fallback subsets, merged. Source: the @fontsource-variable/noto-sans woff2 files
# (install the package temporarily; it is not a dependency). Needs fonttools and brotli:
#   python3 -m venv .venv && .venv/bin/pip install fonttools brotli && PATH=$PWD/.venv/bin:$PATH sh tools/build-noto-fonts.sh
set -eu
src=${1:-node_modules/@fontsource-variable/noto-sans/files}
out=assets/fonts/noto
tmp=$(mktemp -d)
for w in 400:Regular 700:Bold; do
  wght=${w%%:*}; name=${w##*:}; parts=""
  for s in latin vietnamese greek cyrillic; do
    fonttools varLib.instancer "$src/noto-sans-$s-wght-normal.woff2" "wght=$wght" --update-name-table -o "$tmp/$s-$wght.ttf" --quiet
    parts="$parts $tmp/$s-$wght.ttf"
  done
  fonttools merge $parts --output-file="$tmp/m-$wght.ttf"
  pyftsubset "$tmp/m-$wght.ttf" --unicodes="U+0020-007E,U+00A0-00FF,U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB,U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116,U+2010-2027,U+2030-203A,U+20AC" \
    --layout-features= --no-hinting --notdef-outline --drop-tables+=DSIG,GDEF,GPOS,GSUB,STAT,fvar,gvar,avar,HVAR --output-file="$out/NotoSans-$name.ttf"
done
rm -rf "$tmp"
