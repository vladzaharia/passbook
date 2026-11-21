import { Validator } from '@cfworker/json-schema';
import { describe, expect, it } from 'vitest';
import {
  decidePatterns,
  isLinearPattern,
  onUnsupportedPattern,
  patternMatches,
} from './safe-pattern.ts';

describe('RE2 patterns', () => {
  it('accepts what RE2 runs, including nested quantifiers', () => {
    for (const p of [
      '^[A-Z]{3}$',
      '^https://',
      '^(?:ab){1,3}$',
      '^(a+)+$',
      '^(a|aa)*$',
      '^[\\p{L} ]+$',
    ])
      expect(isLinearPattern(p), p).toBe(true);
  });

  it('rejects backreferences, lookaround and bad syntax', () => {
    for (const p of ['(a)\\1', '(?=a)a', '(?!a)', '(?<=a)b', '(?<!a)b', '(', '[']) {
      expect(isLinearPattern(p), p).toBe(false);
    }
  });

  it('answers a catastrophic pattern in linear time (the audit input)', () => {
    const pattern = `^${'a*'.repeat(12)}$`;
    const started = performance.now();
    expect(patternMatches(pattern, `${'a'.repeat(60_000)}b`)).toBe(false);
    expect(patternMatches('^(a+)+$', `${'a'.repeat(5_000)}b`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('treats an unsupported pattern as advisory and reports it once', () => {
    const seen: string[] = [];
    onUnsupportedPattern((p) => seen.push(p));
    expect(patternMatches('(a)\\1$', 'xyz')).toBe(true);
    expect(patternMatches('(a)\\1$', 'xyz')).toBe(true);
    expect(seen).toEqual(['(a)\\1$']);
    onUnsupportedPattern(() => undefined);
  });
});

describe('decidePatterns', () => {
  const schema = {
    type: 'object',
    properties: {
      code: { type: 'string', pattern: '^[A-Z]{3}$' },
      tags: { type: 'array', items: { type: 'string', pattern: '^[a-z]+$' } },
      other: { anyOf: [{ type: 'string', pattern: '^x' }, { type: 'number' }] },
    },
  };
  const run = (value: unknown) =>
    new Validator(decidePatterns(schema, [value]) as never, '2020-12', false).validate(
      value as never,
    ).valid;

  it('keeps JSON Schema meaning without the validator compiling a regex', () => {
    expect(run({ code: 'ABC', tags: ['a', 'b'], other: 'xy' })).toBe(true);
    expect(run({ code: 'abc' })).toBe(false);
    expect(run({ tags: ['a', 'B'] })).toBe(false);
    expect(run({ other: 'yx' })).toBe(false);
    expect(run({ other: 4 })).toBe(true);
  });

  it('never compiles a catastrophic pattern for the validator', () => {
    const hostile = {
      type: 'object',
      properties: { v: { type: 'string', maxLength: 512, pattern: `^${'a*'.repeat(12)}$` } },
    };
    const value = { v: `${'a'.repeat(60_000)}b` };
    const started = performance.now();
    const valid = new Validator(
      decidePatterns(hostile, [value]) as never,
      '2020-12',
      false,
    ).validate(value as never).valid;
    expect(valid).toBe(false);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
