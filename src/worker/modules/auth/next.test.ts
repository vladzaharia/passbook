import { describe, expect, it } from 'vitest';
import { nextOrHome, safeNext } from './next.ts';

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
    '/../etc',
    '/a/%2e%2e/b',
    '',
    `/${'a'.repeat(600)}`,
  ])('refuses %j', (value) => {
    expect(safeNext(value)).toBeNull();
    expect(nextOrHome(value)).toBe('/');
  });

  it('falls back to home for null and undefined', () => {
    expect(nextOrHome(null)).toBe('/');
    expect(nextOrHome(undefined)).toBe('/');
  });
});
