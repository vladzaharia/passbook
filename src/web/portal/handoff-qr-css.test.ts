import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(`${import.meta.dirname}/${path}`, 'utf8');

describe('the scan-to-add card', () => {
  it('is hidden on phones and touch screens, on the pass page and the bundle page', () => {
    for (const css of [read('holder-pass.css'), read('../../worker/ssr/bundle-page.css')]) {
      expect(css).toMatch(/@media \(max-width: 767\.98px\), \(pointer: coarse\)/);
      expect(css).toMatch(/wl-hero-scan/);
    }
  });

  it('keeps a stacked peek tall enough for a two-line header, and Details a visible disclosure', () => {
    expect(read('pass-stack.css')).toMatch(/--wl-peek:\s*4\.25rem/);
    expect(read('../../worker/ssr/bundle-page.css')).toMatch(/\.bd-more > summary::after/);
  });
});
