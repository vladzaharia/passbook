// Part of `npm run gen`: the SSR pages and emails read the SPA's own tokens and fonts.
// - src/generated/ssr-tokens.css: the brand's Rubik faces, then every custom-property block of
//   @polaris-key/brand tokens.css, src/web/styles/wallet.css and motion.css, same selectors.
// - src/generated/resolved-tokens.ts: those tokens resolved per theme (emails, theme-color).
// - public/fonts/: the woff2 files the faces point at, copied from the brand package.
// - public/fonts/noto/: the print sheet's Noto Sans subsets, from assets/fonts/noto.
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { FALLBACK_FONTS, FALLBACK_PDF_FONTS } from '../src/web/paper/fallback-font.ts';
import {
  FONT_SOURCE,
  fontSheet,
  readSources,
  resolvedTokensTs,
  ssrTokensCss,
} from './lib/ssr-tokens.ts';

const root = resolve(import.meta.dirname, '..');
const sources = readSources(root);

writeFileSync(resolve(root, 'src/generated/ssr-tokens.css'), ssrTokensCss(sources));
writeFileSync(resolve(root, 'src/generated/resolved-tokens.ts'), resolvedTokensTs(sources));

const fonts = resolve(root, 'public/fonts');
const { files } = fontSheet(sources);
mkdirSync(fonts, { recursive: true });
// Subfolders (public/fonts/pdf, the ticket PDF's fonts) are not generated here.
for (const stale of readdirSync(fonts, { withFileTypes: true }))
  if (stale.isFile() && !files.includes(stale.name)) rmSync(resolve(fonts, stale.name));
for (const file of files)
  copyFileSync(resolve(root, dirname(FONT_SOURCE), file), resolve(fonts, file));

// The print sheet's Noto Sans fallback: woff2 for the page, static TTFs for the PDF.
const noto = resolve(root, 'assets/fonts/noto');
mkdirSync(resolve(fonts, 'noto'), { recursive: true });
for (const { file } of FALLBACK_FONTS)
  copyFileSync(resolve(noto, file), resolve(fonts, 'noto', file));
for (const file of FALLBACK_PDF_FONTS)
  copyFileSync(resolve(noto, file), resolve(fonts, 'pdf', file));
for (const dir of ['noto', 'pdf'])
  copyFileSync(resolve(noto, 'OFL-NotoSans.txt'), resolve(fonts, dir, 'OFL-NotoSans.txt'));

console.log(`ssr tokens: ${files.length} font files, tokens and email tokens written`);
