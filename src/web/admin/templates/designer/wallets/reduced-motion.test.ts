import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const css = (name: string) => readFileSync(`${import.meta.dirname}/${name}`, 'utf8');
const reduced = (text: string) =>
  [...text.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)]
    .map((m) => m[1])
    .join('\n');

describe('Wallets tab under reduced motion', () => {
  const tab = css('wallets.css');
  const report = readFileSync(
    `${import.meta.dirname}/../../../../wallet-report/wallet-report.css`,
    'utf8',
  );

  it('stops every entrance, deal, fade, lift, arrow dot and lock bounce', () => {
    const still = reduced(tab);
    for (const selector of [
      '.wm-lock',
      '.wm-fade > *',
      '.wallets-mode',
      '.wt-tiles > .wt',
      '.wm-deal',
      '.wt-arrow[data-play] .wt-dot-run',
    ])
      expect(still, selector).toContain(selector);
    expect(still).toMatch(/animation: none/);
    expect(still).toMatch(/\.wt-tiles > \[aria-checked="true"\] \.wt-card \{\s*transform: none/);
  });

  it('stops the count pop', () => {
    expect(reduced(report)).toMatch(/\.wr-count \{\s*animation: none/);
  });

  describe('a part dropping onto the card', () => {
    afterEach(() => vi.unstubAllGlobals());
    it('only fades', async () => {
      vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), media: q }));
      const { prefersReducedMotion } = await import('../../../../lib/motion.ts');
      expect(prefersReducedMotion()).toBe(true);
    });
  });
});
