import { describe, expect, it } from 'vitest';
import { safeNextPath as safeNext } from './next.ts';

describe('safeNext', () => {
  it('keeps same-origin relative paths with query and hash', () => {
    expect(safeNext('/passes/1?x=1#top')).toBe('/passes/1?x=1#top');
    expect(safeNext('/')).toBe('/');
  });

  it.each([
    'https://evil.example/',
    '//evil.example/path',
    '/\\evil.example',
    '\\\\evil.example',
    'javascript:alert(1)',
    'evil.example',
    '/ /x',
    '/a\nb',
    '/\t/evil.example',
    '/a\u00a0b',
    '/../etc',
    '/a/%2e%2e/b',
    '',
    `/${'a'.repeat(600)}`,
  ])('refuses %j', (value) => {
    expect(safeNext(value)).toBeNull();
  });
});
