import { describe, expect, it } from 'vitest';
import { coerceInput } from './import-coerce.ts';

const inputs = {
  properties: {
    name: { type: 'string' },
    points: { type: 'integer' },
    score: { type: 'number' },
    active: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' } },
    nums: { type: 'array', items: { type: 'integer' } },
    loose: {},
  },
};

describe('coerceInput', () => {
  it('trims strings and drops blanks', () => {
    expect(coerceInput(inputs, { name: '  Alex  ', loose: '  x ' })).toEqual({
      name: 'Alex',
      loose: 'x',
    });
    expect(coerceInput(inputs, { name: '   ', points: '' })).toEqual({});
  });

  it('reads integers and numbers, with a comma decimal only when alone', () => {
    expect(coerceInput(inputs, { points: ' 12 ', score: '3.5' })).toEqual({
      points: 12,
      score: 3.5,
    });
    expect(coerceInput(inputs, { score: '1,5' })).toEqual({ score: 1.5 });
    expect(coerceInput(inputs, { score: '1,234.5' })).toEqual({ score: '1,234.5' });
    expect(coerceInput(inputs, { points: '-4' })).toEqual({ points: -4 });
  });

  it('leaves a cell that does not fit its type as text for the template check to word', () => {
    expect(coerceInput(inputs, { points: '3.5', score: 'abc' })).toEqual({
      points: '3.5',
      score: 'abc',
    });
    expect(coerceInput(inputs, { points: '1,5' })).toEqual({ points: '1,5' });
  });

  it.each([
    ['true', true],
    ['Yes', true],
    ['y', true],
    ['1', true],
    ['FALSE', false],
    ['no', false],
    ['N', false],
    ['0', false],
  ])('reads %s as a boolean', (text, want) => {
    expect(coerceInput(inputs, { active: text })).toEqual({ active: want });
  });

  it('keeps an unreadable boolean as text', () => {
    expect(coerceInput(inputs, { active: 'maybe' })).toEqual({ active: 'maybe' });
  });

  it('splits arrays on semicolons', () => {
    expect(coerceInput(inputs, { tags: 'a; b ;;c' })).toEqual({ tags: ['a', 'b', 'c'] });
    expect(coerceInput(inputs, { nums: '1;2;x' })).toEqual({ nums: [1, 2, 'x'] });
    expect(coerceInput(inputs, { tags: ' ; ' })).toEqual({});
  });

  it('passes values that already have a type and unknown keys', () => {
    expect(coerceInput(inputs, { points: 5, active: true, extra: 'x' })).toEqual({
      points: 5,
      active: true,
      extra: 'x',
    });
  });
});
