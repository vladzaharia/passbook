import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Read as text: SSR pages inline this sheet (worker/ssr/theme.ts) and raw imports are empty there
// under test.
const ROOT = join(import.meta.dirname, '../../../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const css = read('src/web/ui/layout/brand-mark.css').replace(/\/\*[\s\S]*?\*\//g, '');

/** Top-level blocks: [prelude, body]. */
function blocks(text: string): [string, string][] {
  const out: [string, string][] = [];
  let depth = 0;
  let start = 0;
  let open = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{' && depth++ === 0) open = i;
    else if (text[i] === '}' && --depth === 0) {
      out.push([text.slice(start, open).trim(), text.slice(open + 1, i)]);
      start = i + 1;
    }
  }
  return out;
}

describe('brand mark sheet', () => {
  const top = blocks(css);

  it('moves only under no-preference: the hello, and the hover on fine pointers', () => {
    for (const [sel, body] of top) {
      if (sel.startsWith('@keyframes')) continue;
      if (/(^|[\s;{])(animation|transition)(-[a-z]+)?\s*:/.test(body)) {
        expect(sel).toMatch(/prefers-reduced-motion: no-preference/);
      }
      if (/:hover/.test(body)) {
        expect(sel).toBe(
          '@media (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)',
        );
      }
    }
    expect(css).toMatch(/\.wl-mark\[data-hello\] \[data-p\] \{\s*animation: wl-mark-pop /);
    expect(css).toMatch(/\.wl-mark\[data-hello\] \[data-wink\] \{\s*animation: wl-mark-wink /);
    expect(css).not.toMatch(/infinite/);
  });

  it('animates transforms only, once', () => {
    const frames = top.filter(([sel]) => sel.startsWith('@keyframes'));
    expect(frames.map(([sel]) => sel)).toEqual([
      '@keyframes wl-mark-pop',
      '@keyframes wl-mark-wink',
    ]);
    for (const [, body] of frames) {
      for (const [, frame] of blocks(body)) {
        for (const decl of frame.split(';').filter((d) => d.trim())) {
          expect(['translate', 'scale']).toContain(decl.split(':')[0]?.trim());
        }
      }
    }
  });

  it('is the one mark: SSR renders the same component with the same sheet', () => {
    const theme = read('src/worker/ssr/theme.ts');
    expect(theme).toContain("import markCss from '../../web/ui/layout/brand-mark.css?raw';");
    expect(theme).toContain('renderToStaticMarkup(createElement(BrandMark))');
    // Foil from either renderer's tokens.
    for (const n of [1, 2, 3]) expect(css).toContain(`var(--wl-foil-${n}, var(--foil-${n}))`);
  });
});
