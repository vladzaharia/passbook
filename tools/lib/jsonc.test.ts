import { describe, expect, it } from 'vitest';
import { parseJsonc, setJsonc } from './jsonc.ts';

const text = `{
  // comment
  "a": [1, 2,],
  "b": { "c": "x" },
}`;

describe('jsonc', () => {
  it('parses comments and trailing commas', () => {
    expect(parseJsonc(text)).toEqual({ a: [1, 2], b: { c: 'x' } });
  });
  it('edits while keeping comments', () => {
    const out = setJsonc(text, ['b', 'c'], 'y');
    expect(out).toContain('// comment');
    expect(parseJsonc(out)).toMatchObject({ b: { c: 'y' } });
  });
  it('rejects broken input', () => {
    expect(() => parseJsonc('{ "a": }')).toThrow();
  });
});
