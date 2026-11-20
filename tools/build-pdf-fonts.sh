#!/bin/sh
# Rebuilds public/fonts/pdf/*.ttf: static instances of the brand package's variable Rubik and
# JetBrains Mono, subset to what the printed ticket draws (Latin, Latin extended, Cyrillic,
# punctuation, currency; Rubik has no Vietnamese tone marks, Hebrew or Arabic glyphs). pdf-lib embeds static fonts only. Needs fonttools and brotli:
#   python3 -m venv .venv && .venv/bin/pip install fonttools brotli && PATH=$PWD/.venv/bin:$PATH sh tools/build-pdf-fonts.sh
set -eu
src=node_modules/@polaris-key/brand/fonts/ttf
out=public/fonts/pdf
tmp=$(mktemp -d)
mkdir -p "$out"
text="U+0020-007E,U+00A0-024F,U+0300-036F,U+0400-052F,U+2010-2027,U+2030-203A,U+20A0-20BF,U+2116,U+2122,U+2190-2193,U+2212,U+2215,U+2260,U+2264-2265"
inst() { # family file weight name unicodes
  fonttools varLib.instancer "$src/$2" "wght=$3" --update-name-table -o "$tmp/$4.ttf" --quiet
  pyftsubset "$tmp/$4.ttf" --unicodes="$5" --layout-features= --no-hinting --notdef-outline \
    --drop-tables+=DSIG,GDEF,GPOS,GSUB --output-file="$out/$4.ttf"
}
inst Rubik Rubik-Variable.ttf 400 Rubik-Regular "$text"
inst Rubik Rubik-Variable.ttf 500 Rubik-Medium "$text"
inst Rubik Rubik-Variable.ttf 600 Rubik-SemiBold "$text"
inst Rubik Rubik-Variable.ttf 700 Rubik-Bold "$text"
inst Mono JetBrainsMono-Variable.ttf 700 JetBrainsMono-Bold "U+0020-007E,U+00A0-00FF"
rm -rf "$tmp"
