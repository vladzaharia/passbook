import { describe, expect, it } from 'vitest';
import {
  paginationErrors,
  paginationFor,
  readIncremental,
  readPagination,
  relativeTo,
  restErrors,
} from './rest-values.ts';

describe('pagination values', () => {
  it('has a start for each of the six styles', () => {
    const none = { style: 'none' } as const;
    expect(paginationFor('cursor', none)).toMatchObject({ style: 'cursor', param: 'cursor' });
    expect(paginationFor('next-link', none)).toEqual({ style: 'next-link', nextPointer: '' });
    expect(paginationFor('link-header', none)).toEqual({ style: 'link-header' });
    expect(paginationFor('page', none)).toMatchObject({ style: 'page', param: 'page', start: 1 });
    expect(paginationFor('offset', none)).toMatchObject({
      style: 'offset',
      param: 'offset',
      sizeParam: 'limit',
      size: 100,
    });
    expect(paginationFor('none', paginationFor('offset', none))).toEqual({ style: 'none' });
  });

  it('keeps the page size when the style changes', () => {
    const offset = { style: 'offset', param: 'skip', sizeParam: 'take', size: 50 } as const;
    expect(paginationFor('page', offset)).toMatchObject({ sizeParam: 'take', size: 50 });
  });

  it('asks for what a style needs', () => {
    expect(paginationErrors(paginationFor('cursor', { style: 'none' }))).toEqual({
      cursorPointer: 'Pick the cursor in the response.',
    });
    expect(
      paginationErrors({
        style: 'cursor',
        param: 'starting_after',
        cursorPointer: '',
        from: 'last-id',
      }),
    ).toEqual({});
    expect(paginationErrors({ style: 'next-link', nextPointer: '' })).toHaveProperty('nextPointer');
    expect(paginationErrors({ style: 'offset', param: 'o', sizeParam: 'l', size: 5000 })).toEqual({
      size: 'Whole number from 1 to 1000.',
    });
    expect(paginationErrors({ style: 'link-header' })).toEqual({});
  });

  it('reads what the form holds and blocks an unnamed filter parameter', () => {
    expect(readPagination({})).toEqual({ style: 'none' });
    const inc = { param: '', field: '/updated_at', format: 'iso', overlapSeconds: 300 };
    expect(readIncremental({ 'list.incremental': inc })).toEqual(inc);
    expect(restErrors({ 'list.incremental': inc })).toEqual({
      'incremental.param': 'Name the query parameter.',
    });
    expect(restErrors({})).toEqual({});
  });

  it('writes a pointer inside a record relative to it', () => {
    expect(relativeTo('/data', '/data/0/email')).toBe('/email');
    expect(relativeTo('/data', '/data/3')).toBe('');
    expect(relativeTo('/data', '/meta/next')).toBeNull();
    expect(relativeTo('/data', '/data/x/email')).toBeNull();
    expect(relativeTo('', '/0/id')).toBe('/id');
  });
});
