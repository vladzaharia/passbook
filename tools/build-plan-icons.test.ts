import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeIcons, planIconsCss } from './build-plan-icons.ts';

const icons = composeIcons(resolve(import.meta.dirname, '..'));

describe('plan and row icons', () => {
  it('has 7 plan icons and 112 row icons', () => {
    expect(Object.keys(icons.plans).sort()).toEqual([
      'business',
      'enterprise',
      'legacy',
      'premium',
      'standard',
      'starter',
      'trial',
    ]);
    expect(Object.keys(icons.rowIcons)).toHaveLength(112);
  });

  it('keeps accents out of every dark-theme selector', () => {
    const css = planIconsCss(icons).replace(/\/\*[\s\S]*?\*\//g, '');
    const blocks = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)];
    expect(blocks.length).toBeGreaterThan(0);
    for (const [, selector, body] of blocks) {
      if (/dark|prefers-color-scheme/.test(selector ?? ''))
        expect(body).not.toMatch(/--(plan-accent|row-area)-/);
    }
    expect(css).not.toMatch(/dark|prefers-color-scheme/);
    expect(css).toContain('--plan-accent-business: #8B4DEB;');
    expect(css).toContain('--row-area-door: #22B45A;');
  });
});
