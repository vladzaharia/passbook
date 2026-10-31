import { describe, expect, it } from 'vitest';
import { validatePass } from '../validate.ts';
import { FIXTURES } from './fixtures.ts';
import { normalizePass } from './normalize.ts';

const cases = FIXTURES.map((f) => [f.name, f] as const);

describe('golden passes', () => {
  it.each(cases)('%s validates without issues', (_name, f) => {
    const report = validatePass(normalizePass(f.pass), f.assets, f.identity);
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it.each(cases)('%s is stable under normalization', (_name, f) => {
    const once = normalizePass(f.pass);
    expect(normalizePass(once)).toEqual(once);
  });
});
