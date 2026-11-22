import { describe, expect, it } from 'vitest';
import { type FieldRow, patchOf, rowErrors, rowOp } from './model.ts';

const row = (over: Partial<FieldRow>): FieldRow => ({
  id: 'r1',
  key: 'validUntil',
  op: 'set',
  value: undefined,
  amount: '1',
  unit: 'Y',
  ...over,
});

describe('change rows', () => {
  it('reads each choice as the server op', () => {
    expect(rowOp(row({ op: 'set', value: 'annual' }))).toEqual({ op: { set: 'annual' } });
    expect(rowOp(row({ op: 'clear' }))).toEqual({ op: { clear: true } });
    expect(rowOp(row({ op: 'extend', amount: '1', unit: 'Y' }))).toEqual({ op: { shift: 'P1Y' } });
    expect(rowOp(row({ op: 'shorten', amount: '2', unit: 'W' }))).toEqual({
      op: { shift: '-P2W' },
    });
    expect(rowOp(row({ op: 'add', amount: '5' }))).toEqual({ op: { add: 5 } });
    expect(rowOp(row({ op: 'subtract', amount: '5' }))).toEqual({ op: { add: -5 } });
  });

  it('keeps false and 0 as values, and refuses empty ones', () => {
    expect(rowOp(row({ value: false }))).toEqual({ op: { set: false } });
    expect(rowOp(row({ value: 0 }))).toEqual({ op: { set: 0 } });
    expect(rowOp(row({ value: undefined }))).toEqual({ error: 'Enter a value.' });
    expect(rowOp(row({ op: 'add', amount: '' }))).toEqual({ error: 'Enter a number above 0.' });
    expect(rowOp(row({ op: 'extend', amount: '1.5' }))).toEqual({ error: 'Use a whole number.' });
  });

  it('builds a patch per kind, null while a row is unfinished', () => {
    expect(patchOf('void', [])).toEqual({ $void: true });
    expect(patchOf('design', [])).toEqual({ $design: true });
    expect(patchOf('fields', [])).toBeNull();
    expect(patchOf('fields', [row({ value: undefined })])).toBeNull();
    expect(patchOf('fields', [row({ op: 'clear' })])).toEqual({ validUntil: { clear: true } });
    expect(rowErrors([row({ id: 'a', value: undefined }), row({ id: 'b', op: 'clear' })])).toEqual({
      a: 'Enter a value.',
    });
  });
});
