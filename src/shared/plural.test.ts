import { describe, expect, it } from 'vitest';
import { plural } from './plural.ts';

describe('plural', () => {
  it('uses the singular only for exactly one', () => {
    expect(plural(1, 'type')).toBe('1 type');
    expect(plural(0, 'type')).toBe('0 types');
    expect(plural(2, 'type')).toBe('2 types');
  });

  it('takes an irregular plural and groups thousands', () => {
    expect(plural(1, 'pass', 'passes')).toBe('1 pass');
    expect(plural(1234, 'pass', 'passes')).toBe('1,234 passes');
  });
});
