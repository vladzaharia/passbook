// Part of `npm run gen`: /p renders the portal's HolderPassView to static markup, so it gets the
// SPA's own CSS for it: src/generated/ssr-holder.css (tools/lib/ssr-holder.ts).
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ssrHolderCss } from './lib/ssr-holder.ts';

const root = resolve(import.meta.dirname, '..');
const css = await ssrHolderCss(root);
writeFileSync(resolve(root, 'src/generated/ssr-holder.css'), css);
console.log(`ssr holder: ${css.length} bytes`);
