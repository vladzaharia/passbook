import { describe, expect, it } from 'vitest';
import { homeFor, safeNextPath as safeNext } from './next.ts';

describe('safeNext', () => {
  it('keeps same-origin relative paths with query and hash', () => {
    expect(safeNext('/passes/1?x=1#top')).toBe('/passes/1?x=1#top');
    expect(safeNext('/')).toBe('/');
  });

  it('keeps a confirm link, so signing in can return to it', () => {
    expect(safeNext('/auth/magic?t=abc_DEF-123')).toBe('/auth/magic?t=abc_DEF-123');
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

describe('homeFor', () => {
  it('follows a safe next for anyone', () => {
    expect(homeFor(['admin', 'user'], '/passes/1')).toBe('/passes/1');
    expect(homeFor(['user'], '/account')).toBe('/account');
    expect(homeFor(['admin', 'user'], '/')).toBe('/');
  });

  it('sends admins to the console and holders to My passes otherwise', () => {
    expect(homeFor(['admin', 'user'])).toBe('/admin');
    expect(homeFor(['admin'], '//evil.example')).toBe('/admin');
    expect(homeFor(['user'], null)).toBe('/');
    expect(homeFor([], 'https://evil.example/')).toBe('/');
  });
});
