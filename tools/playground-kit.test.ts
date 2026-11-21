import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { playgroundKitCss } from './lib/playground-kit.ts';

const root = resolve(import.meta.dirname, '..');

describe('generated playground kit CSS (tools/build-playground-kit.ts)', () => {
  it('is what the generator makes from the kit sources today (run `npm run gen`)', async () => {
    const generated = readFileSync(resolve(root, 'src/generated/playground-kit.css'), 'utf8');
    expect(generated).toBe(await playgroundKitCss(root));
  });

  it('has the classes the embedded kit pieces use, and no preflight that would reset the portal', () => {
    const css = readFileSync(resolve(root, 'src/generated/playground-kit.css'), 'utf8');
    for (const cls of ['.min-w-0', '.flex-col', '.gap-4', '.text-fg-muted', '.divide-border'])
      expect(css, cls).toContain(cls);
    expect(css).not.toMatch(/(^|\})(html|body|\*),?(:before|:after|::backdrop)?\{/);
    expect(css).not.toContain('tailwindcss v');
  });
});
