import { describe, expect, it } from 'vitest';
import type { Condition } from '../types.ts';
import {
  checkExpr,
  EXPR_LIMITS,
  type ExprScope,
  evaluate,
  exprReferences,
  lookupPath,
  testCondition,
} from './expr.ts';

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
    expect(lookupPath('toString', scope)).toBeUndefined();
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

describe('expression errors and limits', () => {
  it('rejects unclosed, empty, nested and bad-path interpolations', () => {
    expect(() => evaluate('a {{name', scope)).toThrow(/Unclosed/);
    expect(() => evaluate('{{ }}', scope)).toThrow(/Empty/);
    expect(() => evaluate('{{a {{b}} }}', scope)).toThrow(/Nested/);
    expect(() => evaluate('{{a b}}', scope)).toThrow(/Bad path segment/);
    expect(() => evaluate('{{a|nope}}', scope)).toThrow(/Unknown filter "nope"/);
    expect(() => evaluate('{{a|html|url}}', scope)).toThrow(/one filter/);
  });
  it('bounds length, interpolation count, path depth and output', () => {
    expect(() => evaluate('x'.repeat(EXPR_LIMITS.length + 1), scope)).toThrow(/longer than/);
    expect(() => evaluate('{{name}}'.repeat(EXPR_LIMITS.interpolations + 1), scope)).toThrow(
      /interpolations/,
    );
    expect(() => evaluate('{{a.b.c.d.e.f.g.h.i}}', scope)).toThrow(/deeper/);
  });
  it('names the expression in the error', () => {
    expect(() => evaluate('hello {{a|nope}}', scope)).toThrow(/hello \{\{a\|nope\}\}/);
  });
  it('escapes with filters', () => {
    const s: ExprScope = { input: { u: 'a"b<c>&' }, lookups: {} };
    expect(evaluate('<a href="{{u|html}}">', s)).toBe('<a href="a&quot;b&lt;c&gt;&amp;">');
    expect(evaluate('?q={{u|url}}', s)).toBe('?q=a%22b%3Cc%3E%26');
  });
  it('lists references and statically checks', () => {
    expect(checkExpr('{{a')).toMatch(/Unclosed/);
    expect(checkExpr('ok')).toBeNull();
    expect(exprReferences('{{lookups.clubs[club].name}} {{n}}')).toEqual({
      inputs: ['club', 'n'],
      lookups: ['clubs'],
    });
  });
  it('limits condition nesting', () => {
    let c: Condition = { input: 'n', eq: 0 };
    for (let i = 0; i < 12; i++) c = { not: c };
    expect(() => testCondition(c, scope)).toThrow(/nested too deeply/);
  });
});
