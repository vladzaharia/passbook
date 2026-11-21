// Part of `npm run gen`: the developer playground embeds kit components (channel previews, wallet
// report), so it gets their utility classes as src/generated/playground-kit.css.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { playgroundKitCss } from './lib/playground-kit.ts';

const root = resolve(import.meta.dirname, '..');
const css = await playgroundKitCss(root);
writeFileSync(resolve(root, 'src/generated/playground-kit.css'), css);
console.log(`playground kit: ${css.length} bytes`);
