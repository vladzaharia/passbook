import { describe, expect, it } from 'vitest';
import { type ExprScope, evaluate, lookupPath, testCondition } from './expr.ts';

const scope: ExprScope = {
  input: { name: 'Alex', club: 'qa', n: 0, empty: '' },
  lookups: { clubs: { qa: { name: 'Queen Anne', phone: '206' } } },
};

describe('expressions', () => {
  it('interpolates input and lookups', () => {
    expect(evaluate('Hi {{name}} at {{lookups.clubs[club].name}}', scope)).toBe(
      'Hi Alex at Queen Anne',
    );
    expect(evaluate('{{lookups.clubs[club].phone}}', scope)).toBe('206');
  });
  it('keeps types for whole-value expressions and supports const', () => {
    expect(evaluate('{{n}}', scope)).toBe(0);
    expect(evaluate({ const: [1] }, scope)).toEqual([1]);
    expect(evaluate('{{missing}}', scope)).toBeUndefined();
    expect(evaluate('x{{missing}}y', scope)).toBe('xy');
  });
  it('refuses prototype access', () => {
    expect(lookupPath('__proto__.polluted', scope)).toBeUndefined();
    expect(lookupPath('constructor', scope)).toBeUndefined();
  });
  it('evaluates conditions', () => {
    expect(testCondition({ input: 'club', eq: 'qa' }, scope)).toBe(true);
    expect(testCondition({ input: 'club', in: ['x', 'qa'] }, scope)).toBe(true);
    expect(testCondition({ input: 'empty', empty: true }, scope)).toBe(true);
    expect(
      testCondition(
        { all: [{ input: 'club', eq: 'qa' }, { not: { input: 'name', eq: 'B' } }] },
        scope,
      ),
    ).toBe(true);
    expect(
      testCondition(
        {
          any: [
            { input: 'club', eq: 'x' },
            { input: 'n', eq: 1 },
          ],
        },
        scope,
      ),
    ).toBe(false);
  });
});
