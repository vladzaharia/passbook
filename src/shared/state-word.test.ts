import { describe, expect, it } from 'vitest';
import { stateWordOf, stateWordOption } from './state-word.ts';

describe('stateWordOf', () => {
  it('names the ended state; removal wins over void', () => {
    expect(stateWordOf({ removedAt: null, status: 'active' })).toBeUndefined();
    expect(stateWordOf({ removedAt: null, status: 'voided' })).toBe('Voided');
    expect(stateWordOf({ removedAt: 1, status: 'voided' })).toBe('Removed');
  });

  it('makes the normalize option', () => {
    expect(stateWordOption({ removedAt: null, status: 'active' })).toEqual({});
    expect(stateWordOption({ removedAt: null, status: 'voided' })).toEqual({ stateWord: 'Voided' });
  });
});
