import { describe, expect, it } from 'vitest';
import { bakedSlugs } from '../template/baked-fixtures.ts';
import { GOOGLE_COMPILERS } from './google/compilers.ts';
import { samsungCompiler } from './samsung/index.ts';
import { TYPE_NEEDS, unmetNeeds } from './type-needs.ts';
import { viewOf } from './view-fixtures.ts';

const GOOGLE = ['generic', 'loyalty', 'event', 'gift', 'offer'] as const;
const SAMSUNG = ['ticket', 'coupon'] as const;
const NOW = new Date('2026-11-17T10:00:00Z');

describe('TYPE_NEEDS parity', () => {
  it('names every type the manifest schema accepts', () => {
    expect(Object.keys(TYPE_NEEDS.google).sort()).toEqual([...GOOGLE].sort());
    expect(Object.keys(TYPE_NEEDS.samsung).sort()).toEqual(
      ['coupon', 'generic', 'giftcard', 'loyalty', 'ticket'].sort(),
    );
  });

  for (const slug of bakedSlugs()) {
    it(`agrees with the compilers on ${slug}`, async () => {
      for (const type of GOOGLE) {
        const view = await viewOf(slug);
        const result = GOOGLE_COMPILERS[type].compile(view, { now: NOW, omit: [] });
        const unsatisfied = result.blocked?.code === 'TYPE_UNSATISFIED';
        expect(unmetNeeds('google', type, view).length > 0, `google ${type}`).toBe(unsatisfied);
      }
      for (const type of SAMSUNG) {
        const view = await viewOf(slug, { wallets: { schema: 1, samsung: { type } } });
        const result = samsungCompiler.compile(view, { now: NOW, omit: [] });
        const fellBack = result.items.some(
          (i) => i.capability === 'type' && i.message.includes(`needs`),
        );
        expect(unmetNeeds('samsung', type, view).length > 0, `samsung ${type}`).toBe(fellBack);
      }
    });
  }
});
