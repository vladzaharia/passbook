import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The primitives' sheets and the one Sheet. The chip's busy ring keeps turning (it is state), and the
// tool switch's view transition only exists without reduced motion (view-transition.css).
const FILES = ['kit', 'list', 'inspector', 'state', 'toolbar'].map((f) => `bench/${f}.css`);
const sheets = [...FILES, 'ui/sheet.css'].map((file) => ({
  file,
  css: readFileSync(join(process.cwd(), 'src/web/developers', file), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  ),
}));

/** Every `animation` declaration with the @media blocks around it, outermost first. */
function animations(css: string): { at: number; media: string[] }[] {
  const found: { at: number; media: string[] }[] = [];
  const stack: (string | null)[] = [];
  let head = '';
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '{') {
      const sel = head.trim();
      stack.push(sel.startsWith('@media') ? sel : null);
      head = '';
    } else if (c === '}') {
      stack.pop();
      head = '';
    } else if (c === ';') {
      if (/^\s*animation(-name)?\s*:/.test(head) && !/:\s*none\s*$/.test(head))
        found.push({ at: i, media: stack.filter((m): m is string => m !== null) });
      head = '';
    } else head += c;
  }
  return found;
}

describe('bench motion', () => {
  it('moves only for people who did not ask for less: every animation sits in a motion query', () => {
    const loose: string[] = [];
    for (const { file, css } of sheets)
      for (const a of animations(css))
        if (!a.media.some((m) => /prefers-reduced-motion/.test(m))) loose.push(`${file}@${a.at}`);
    expect(loose).toEqual([]);
  });

  it('under reduced motion it only fades: no transform in a reduce block', () => {
    for (const { file, css } of sheets) {
      const reduce = css.split(/@media\s*\(prefers-reduced-motion:\s*reduce\)/).slice(1);
      for (const block of reduce) expect(block.split('@media')[0], file).not.toMatch(/transform/);
    }
  });
});
