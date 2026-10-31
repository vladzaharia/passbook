import { describe, expect, it } from 'vitest';
import { diffLines } from './diff.ts';
import { isActivePath } from './nav.ts';
import { loginHref, safeNext } from './redirect.ts';
import { shouldRetry } from './query-client.ts';
import { ApiError } from './errors.ts';
import { compactSearch, sortingFromParam, sortingToParam } from './url-state.ts';

describe('safeNext', () => {
  it('allows same-origin paths', () => {
    expect(safeNext('/admin/passes?x=1')).toBe('/admin/passes?x=1');
  });
  it.each(['//evil.com', 'https://evil.com', '/\\evil.com', '', undefined, null, 'admin'])(
    'rejects %s',
    (value) => {
      expect(safeNext(value as string | undefined)).toBe('/');
    },
  );
  it('encodes the login href', () => {
    expect(loginHref('/admin?a=1&b=2')).toBe('/login?next=%2Fadmin%3Fa%3D1%26b%3D2');
    expect(loginHref('//evil.com')).toBe('/login?next=%2F');
  });
});

describe('diffLines', () => {
  it('marks added, removed and unchanged lines', () => {
    expect(diffLines('a\nb\nc', 'a\nx\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'x' },
      { kind: 'same', text: 'c' },
    ]);
  });
  it('handles empty sides', () => {
    expect(diffLines('', 'a')).toEqual([{ kind: 'add', text: 'a' }]);
    expect(diffLines('a', '')).toEqual([{ kind: 'del', text: 'a' }]);
    expect(diffLines('', '')).toEqual([]);
  });
});

describe('url state', () => {
  it('round-trips sorting', () => {
    expect(sortingToParam([{ id: 'name', desc: false }])).toBe('name');
    expect(sortingToParam([{ id: 'name', desc: true }])).toBe('-name');
    expect(sortingToParam([])).toBeUndefined();
    expect(sortingFromParam('-name')).toEqual([{ id: 'name', desc: true }]);
    expect(sortingFromParam('name')).toEqual([{ id: 'name', desc: false }]);
    expect(sortingFromParam(undefined)).toEqual([]);
  });
  it('compacts empty search values but keeps false and 0', () => {
    expect(compactSearch({ a: '', b: undefined, c: null, d: 0, e: false, f: 'x' })).toEqual({
      d: 0,
      e: false,
      f: 'x',
    });
  });
});

describe('isActivePath', () => {
  it('matches exact roots and nested sections', () => {
    expect(isActivePath('/admin', '/admin')).toBe(true);
    expect(isActivePath('/admin/passes', '/admin')).toBe(false);
    expect(isActivePath('/admin/passes/1', '/admin/passes')).toBe(true);
    expect(isActivePath('/admin/passes-x', '/admin/passes')).toBe(false);
  });
});

describe('shouldRetry', () => {
  it('does not retry client errors, retries transient ones twice', () => {
    expect(shouldRetry(0, new ApiError({ status: 404, code: 'not_found' }))).toBe(false);
    expect(shouldRetry(0, new ApiError({ status: 503, code: 'x' }))).toBe(true);
    expect(shouldRetry(2, new ApiError({ status: 503, code: 'x' }))).toBe(false);
    expect(shouldRetry(1, new Error('boom'))).toBe(true);
  });
});
