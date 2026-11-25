import { describe, expect, it } from 'vitest';
import { ENTITLEMENT_KEYS, presetValues } from './contracts/entitlements.ts';
import { COMPARE_ROWS, NOT_COMPARED } from './copy/plans.ts';
import { planFacts } from './plan-facts.ts';

describe('planFacts', () => {
  it('reads numbers, no limit and off from the values', () => {
    expect(planFacts(presetValues('standard'))).toEqual({
      passes: 5000,
      templates: 25,
      google: true,
      samsung: true,
      print: true,
      nfc: 'basic',
      footer: 'quiet',
    });
    expect(planFacts(presetValues('legacy'))).toMatchObject({
      passes: null,
      templates: null,
      nfc: 'secure',
      footer: 'none',
    });
    expect(planFacts(presetValues('trial'))).toMatchObject({
      google: false,
      samsung: false,
      print: false,
      nfc: 'off',
      footer: 'full',
    });
    expect(planFacts(presetValues('developer')).passes).toBe(0);
  });

  it('fails closed on a missing or invalid value', () => {
    expect(planFacts({})).toEqual({
      passes: 0,
      templates: 0,
      google: false,
      samsung: false,
      print: false,
      nfc: 'off',
      footer: 'full',
    });
    expect(
      planFacts({ 'passes.live': -4, nfc: 'huge', 'brand.mark': 'tiny', 'wallet.google': 2 }),
    ).toMatchObject({ passes: 0, nfc: 'off', footer: 'full', google: false });
  });

  it('names each footer level a plan can allow', () => {
    for (const [preset, level] of [
      ['premium', 'none'],
      ['standard', 'quiet'],
      ['starter', 'full'],
    ] as const)
      expect(planFacts(presetValues(preset)).footer).toBe(level);
  });
});

describe('compare rows', () => {
  it('lists every registry key once: compared, or left out with a reason', () => {
    const compared = COMPARE_ROWS.flatMap((g) => g.rows.map((r) => r.key));
    const left = Object.keys(NOT_COMPARED);
    expect(new Set(compared).size).toBe(compared.length);
    expect([...compared, ...left].sort()).toEqual([...ENTITLEMENT_KEYS].sort());
  });
});
