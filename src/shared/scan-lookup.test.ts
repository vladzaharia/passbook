import { describe, expect, it } from 'vitest';
import { normalizeLookup } from './scan-lookup.ts';

describe('normalizeLookup', () => {
  it('drops space, dash, dot and slash', () => {
    expect(normalizeLookup('12-34 56')).toBe('123456');
    expect(normalizeLookup(' a.b/c ')).toBe('ABC');
  });
  it('upper-cases and applies NFKC', () => {
    expect(normalizeLookup('ab-12')).toBe('AB12');
    expect(normalizeLookup('１２３')).toBe('123');
    expect(normalizeLookup('ﬁ')).toBe('FI');
  });
});
