// Part of `npm run gen`: the SSR pages and emails read the SPA's own tokens and fonts.
// - src/generated/ssr-tokens.css: the brand's Rubik faces, then every custom-property block of
//   @polaris-key/brand tokens.css, src/web/styles/wallet.css and motion.css, same selectors.
// - src/generated/resolved-tokens.ts: those tokens resolved per theme (emails, theme-color).
// - public/fonts/: the woff2 files the faces point at, copied from the brand package.
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
for (const stale of readdirSync(fonts)) if (!files.includes(stale)) rmSync(resolve(fonts, stale));
for (const file of files)
  copyFileSync(resolve(root, dirname(FONT_SOURCE), file), resolve(fonts, file));

console.log(`ssr tokens: ${files.length} font files, tokens and email tokens written`);
