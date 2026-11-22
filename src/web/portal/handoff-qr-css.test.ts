import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(`${import.meta.dirname}/${path}`, 'utf8');

describe('the scan-to-add card', () => {
  it('is hidden on phones and touch screens, on the pass page and the bundle page', () => {
    const pass = read('holder-pass.css');
    expect(pass).toMatch(/@media \(max-width: 767\.98px\), \(pointer: coarse\)/);
    expect(pass).toMatch(/wl-hero-scan/);
  });

  it('waits for the two-column layout on the bundle page: a tablet showed it as a lone wide tile', () => {
    const css = read('../../worker/ssr/bundle-page.css');
    expect(css).toMatch(/@media \(max-width: 1023\.98px\), \(pointer: coarse\)/);
    expect(css).toMatch(/wl-hero-scan/);
  });

  it('cuts a stack peek above where a tile under the header starts (no sliver under the last card)', () => {
    expect(read('pass-stack.css')).toMatch(
      /:last-child \.wl-peek \{\s*height: calc\(var\(--wl-peek\) - 0\.25rem\)/,
    );
  });

  it('keeps a stacked peek tall enough for a two-line header, and Details a visible disclosure', () => {
    expect(read('pass-stack.css')).toMatch(/--wl-peek:\s*4\.25rem/);
    expect(read('../../worker/ssr/bundle-page.css')).toMatch(/\.bd-more > summary::before/);
  });
});
