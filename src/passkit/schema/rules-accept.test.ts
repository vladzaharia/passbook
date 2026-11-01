import { describe, expect, it } from 'vitest';
import type { PassJson } from '../types.ts';
import { validatePass } from '../validate.ts';
import { FIXTURES } from './fixtures.ts';
import { type Mutator, pet, poster, run } from './rules-helpers.ts';
import { HIG_CODES } from './validate-hig.ts';
import type { PackageContents } from './validate-package.ts';

describe('validatePass strict mode', () => {
  it('turns warnings into errors', () => {
    const f = FIXTURES[0];
    if (!f) throw new Error('fixture');
    const pass = { ...f.pass, futureKey: 1 } as PassJson;
    expect(validatePass(pass, f.assets, f.identity).ok).toBe(true);
    expect(validatePass(pass, f.assets, f.identity, { strict: true }).ok).toBe(false);
  });
});

describe('validatePass accepts', () => {
  const ok = (fixture: string, mutate: Mutator, options?: PackageContents) => {
    const report = run(fixture, mutate, options);
    expect(report.issues.filter((i) => !HIG_CODES.has(i.code))).toEqual([]);
  };

  it('a personalization.json for an NFC identity with a logo', () =>
    ok(pet, (_p, a) => [...a, { name: 'personalizationLogo.png', width: 150, height: 40 }], {
      personalization: {
        requiredPersonalizationFields: ['PKPassPersonalizationFieldName'],
        description: 'Join',
        termsAndConditions: 'See <a href="https://x.example">terms</a>',
      },
    }));
  it('per-location maxDistance next to a root value', () =>
    ok('coupon', (p) => {
      p.maxDistance = 100;
    }));
  it('tel actions and call type', () =>
    ok(poster, (p) => {
      Object.assign(p.featuredActions[0], { type: 'call', url: 'tel:+15550100' });
    }));
  it('a single date moment with both forms', () =>
    ok('eventTicket', (p) => {
      p.relevantDates = [{ date: '2026-12-01T10:00:00Z', relevantDate: '2026-12-01T10:00:00Z' }];
    }));
  it('localized images with equal resolutions in every locale', () =>
    ok('generic', (_p, a) => [
      ...a.filter((x) => !x.name.startsWith('logo')),
      ...['en', 'fr'].flatMap((l) =>
        ['', '@2x', '@3x'].map((s) => ({ name: `${l}.lproj/logo${s}.png` })),
      ),
    ]));
});
