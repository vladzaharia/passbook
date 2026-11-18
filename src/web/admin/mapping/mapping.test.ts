import { describe, expect, it } from 'vitest';
import { blankRow, fromRows, toRows } from './mapping.ts';

describe('mapping rows', () => {
  it('round-trips a mapping with transforms and options', () => {
    const mapping = {
      name: { from: '/member/name', transform: { kind: 'trim' as const } },
      level: {
        from: '/tier',
        transform: { kind: 'enum' as const, options: { gold: 'copper', silver: 'blue' } },
      },
      plain: { from: '/x' },
    };
    const result = fromRows(toRows(mapping));
    expect(result.errors).toEqual({});
    expect(result.mapping).toEqual(mapping);
  });

  it('skips fully blank rows', () => {
    expect(fromRows([blankRow(), blankRow()])).toEqual({ mapping: {}, errors: {} });
  });

  it('reports a missing input, a missing pointer and duplicates by row', () => {
    const a = { ...blankRow(), from: '/a' };
    const b = { ...blankRow(), input: 'x' };
    const c = { ...blankRow(), input: 'dup', from: '/1' };
    const d = { ...blankRow(), input: 'dup', from: '/2' };
    const { mapping, errors } = fromRows([a, b, c, d]);
    expect(errors[a.id]).toBe('Choose a template input.');
    expect(errors[b.id]).toBe('Enter an upstream pointer.');
    expect(errors[d.id]).toBe('dup is mapped twice.');
    expect(mapping).toEqual({ dup: { from: '/1' } });
  });

  it('rejects transform options that are not a JSON object', () => {
    const bad = { ...blankRow(), input: 'a', from: '/a', kind: 'enum' as const, options: '[1]' };
    const worse = {
      ...blankRow(),
      input: 'b',
      from: '/b',
      kind: 'constant' as const,
      options: '{',
    };
    const { errors } = fromRows([bad, worse]);
    expect(errors[bad.id]).toBe('Options must be a JSON object.');
    expect(errors[worse.id]).toBe('Options must be a JSON object.');
  });

  it('ignores options for transforms that take none', () => {
    const row = { ...blankRow(), input: 'a', from: '/a', kind: 'trim' as const, options: '{' };
    expect(fromRows([row]).mapping).toEqual({ a: { from: '/a', transform: { kind: 'trim' } } });
  });

  it('handles a null mapping', () => {
    expect(toRows(null)).toEqual([]);
  });
});
