import { describe, expect, it } from 'vitest';
import { developerFailures, type Guide } from './lib/developers-check.ts';
import type { Doc } from './lib/openapi-diff.ts';

const doc = (codes: string[], security: object[] = [{ apiKey: ['passes:read'] }]): Doc =>
  ({ paths: { '/api/v1/passes': { get: { security, 'x-codes': codes } } } }) as unknown as Doc;
const entry = { title: 'T', when: 'W', fix: 'F', retryable: false };
const same = { 'docs/api/errors.json': { on: 'a', fresh: 'a' } };
const run = (d: Doc, guide: Guide, catalog = ['NOT_FOUND'], generated = same) =>
  developerFailures({ doc: d, catalog, guide, generated });

describe('check-developers', () => {
  it('passes when every key-reachable code has an entry', () => {
    expect(run(doc(['NOT_FOUND']), { NOT_FOUND: entry })).toEqual([]);
  });

  it('fails on a key-reachable code with no guide entry', () => {
    expect(run(doc(['NOT_FOUND']), {})).toEqual([
      'NOT_FOUND: key-reachable code has no entry in error-guide.json',
    ]);
  });

  it('ignores codes only reachable by sessions', () => {
    expect(run(doc(['NOT_FOUND'], [{ session: [] }]), {})).toEqual([]);
  });

  it('fails on a stale generated file', () => {
    const stale = { 'docs/api/errors.json': { on: 'a', fresh: 'b' } };
    expect(run(doc([]), {}, [], stale)).toEqual(['docs/api/errors.json is stale; run npm run gen']);
  });

  it('fails on an operation without x-codes and on a malformed entry', () => {
    const bare = { paths: { '/x': { get: {} } } } as unknown as Doc;
    expect(run(bare, { NOT_FOUND: { ...entry, fix: '' } })).toEqual([
      'GET /x: no x-codes',
      'NOT_FOUND: guide entry needs fix',
    ]);
  });
});
