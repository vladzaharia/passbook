import { describe, expect, it } from 'vitest';
import { suggestions } from './suggest.ts';
import type { ErrorDoc, OpDoc, SearchIndex } from './types.ts';

const err = (code: string): ErrorDoc => ({
  code,
  status: 400,
  title: '',
  when: '',
  fix: '',
  retryable: false,
  href: '',
});
const op = (id: string, path: string, method = 'GET'): OpDoc => ({
  id,
  method,
  path,
  title: '',
  sdk: '',
  desc: '',
  idempotent: true,
  scopes: [],
  href: '',
});
const index = (errors: ErrorDoc[], ops: OpDoc[]): SearchIndex => ({
  v: 1,
  errors,
  ops,
  guides: [],
  events: [],
  actions: [],
  hints: [],
  secretHelp: [],
});

describe('suggestions', () => {
  it('prefers the well-known ones and takes each from the index', () => {
    const i = index(
      [err('NOT_FOUND'), err('INVALID_INPUT')],
      [op('holders.list', '/holders'), op('passes.create', '/passes', 'POST')],
    );
    expect(suggestions(i)).toEqual(['INVALID_INPUT', '/passes', 'passes.create']);
  });

  it('falls back to the first record, and skips a kind the index lacks', () => {
    expect(suggestions(index([err('X')], [op('a', '/a')]))).toEqual(['X', '/a', 'a']);
    expect(suggestions(index([], []))).toEqual([]);
  });
});
