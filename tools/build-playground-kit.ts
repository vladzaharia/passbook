// Part of `npm run gen`: the developer playground embeds kit components (channel previews, wallet
// report), so it gets their utility classes as src/generated/playground-kit.css; the ⌘K palette gets
// src/generated/search-kit.css, and the shared top bar and account menu get src/generated/menubar-kit.css.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { menubarKitCss, playgroundKitCss, searchKitCss } from './lib/playground-kit.ts';

const root = resolve(import.meta.dirname, '..');
const css = await playgroundKitCss(root);
writeFileSync(resolve(root, 'src/generated/playground-kit.css'), css);
console.log(`playground kit: ${css.length} bytes`);
const search = await searchKitCss(root);
writeFileSync(resolve(root, 'src/generated/search-kit.css'), search);
console.log(`search kit: ${search.length} bytes`);
const menubar = await menubarKitCss(root);
writeFileSync(resolve(root, 'src/generated/menubar-kit.css'), menubar);
console.log(`menubar kit: ${menubar.length} bytes`);
