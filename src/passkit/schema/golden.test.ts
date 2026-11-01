import { describe, expect, it } from 'vitest';
import { validatePass } from '../validate.ts';
import { FIXTURES } from './fixtures.ts';
import { normalizePass } from './normalize.ts';
import { HIG_CODES } from './validate-hig.ts';

const cases = FIXTURES.map((f) => [f.name, f] as const);

describe('golden passes', () => {
  it.each(cases)('%s validates without issues', (_name, f) => {
    const report = validatePass(normalizePass(f.pass), f.assets, f.identity);
    // HIG lint has its own fixtures (rules-hig.test.ts); golden passes check structure.
    expect(report.issues.filter((i) => !HIG_CODES.has(i.code))).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it.each(cases)('%s is stable under normalization', (_name, f) => {
    const once = normalizePass(f.pass);
    expect(normalizePass(once)).toEqual(once);
  });
});
