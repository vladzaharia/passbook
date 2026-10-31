import { describe, expect, it } from 'vitest';
import { isSafePattern, needsInputBound } from './safe-regex.ts';

describe('isSafePattern', () => {
  it('accepts the patterns the starters use', () => {
    for (const p of ['^[A-Z]{3}$', '^[A-Z0-9 .$/+%-]+$', '^https://', '^(?:ab){1,3}$'])
      expect(isSafePattern(p), p).toBe(true);
  });

  it('rejects nested repeats, repeated alternation, backreferences, lookaround and bad syntax', () => {
    for (const p of [
      '^(a+)+$',
      '^(a|aa)*$',
      '^(\\w+\\s?)*$',
      '(a)\\1',
      '(?=a)a',
      '(?<n>a)',
      '(',
      'a)',
      '[',
    ])
      expect(isSafePattern(p), p).toBe(false);
  });

  it('rejects long patterns', () => {
    expect(isSafePattern('a'.repeat(201))).toBe(false);
  });
});

describe('needsInputBound', () => {
  it('is false for patterns without unbounded repeats', () => {
    expect(needsInputBound('^https://')).toBe(false);
    expect(needsInputBound('^[A-Z]{3}$')).toBe(false);
    expect(needsInputBound('^[A-Z+*]{3}$')).toBe(false);
    expect(needsInputBound('^[A-Z]+$')).toBe(true);
    expect(needsInputBound('^a{2,}$')).toBe(true);
  });
});
