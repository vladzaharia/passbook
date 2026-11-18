import { describe, expect, it } from 'vitest';
import { ConnectorError } from '../types.ts';
import { assertSafeRef } from './http.ts';
import { getPointer, isPointer } from './pointer.ts';

describe('json pointer', () => {
  const doc = { a: { 'b/c': [10, { d: 'x' }], 'e~f': 1 }, n: null };

  it('resolves nested keys, arrays and escapes', () => {
    expect(getPointer(doc, '/a/b~1c/1/d')).toBe('x');
    expect(getPointer(doc, '/a/e~0f')).toBe(1);
    expect(getPointer(doc, '/a/b~1c/0')).toBe(10);
    expect(getPointer(doc, '')).toBe(doc);
  });

  it('returns undefined for missing paths and never walks the prototype', () => {
    expect(getPointer(doc, '/a/zzz')).toBeUndefined();
    expect(getPointer(doc, '/a/b~1c/9')).toBeUndefined();
    expect(getPointer(doc, '/a/b~1c/length')).toBeUndefined();
    expect(getPointer(doc, '/__proto__')).toBeUndefined();
    expect(getPointer(doc, '/constructor')).toBeUndefined();
    expect(getPointer(doc, '/n/x')).toBeUndefined();
  });

  it('treats a bare name as a top-level key', () => {
    expect(getPointer({ memberName: 'A' }, 'memberName')).toBe('A');
    expect(isPointer('memberName')).toBe(true);
    expect(isPointer('/a/~2')).toBe(false);
  });
});

describe('assertSafeRef', () => {
  it('encodes ordinary refs', () => {
    expect(assertSafeRef('a b&c')).toBe('a%20b%26c');
  });

  it.each(['..', 'a/../b', 'a/b', 'a\\b', '', 'x?y', 'x#y', 'a\u0000b', 'a'.repeat(201)])(
    'rejects %j',
    (ref) => {
      expect(() => assertSafeRef(ref)).toThrow(ConnectorError);
    },
  );
});
