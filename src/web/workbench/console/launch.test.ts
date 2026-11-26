import { afterEach, describe, expect, it } from 'vitest';
import { forgetHandoffs, stashHandoff, takeHandoff } from './handoff.ts';
import { bodyOfLog, fillFor, launchOf, matchOp, shimHash } from './launch.ts';
import { passesCreate } from './test-support.ts';

afterEach(() => {
  forgetHandoffs();
  sessionStorage.clear();
});

describe('the Console address', () => {
  it('reads the four sources and ignores empty values', () => {
    expect(launchOf('?op=a&sample=s&from=req_1&prefill=n')).toEqual({
      op: 'a',
      sample: 's',
      from: 'req_1',
      prefill: 'n',
    });
    expect(launchOf('?op=&sample=')).toEqual({ op: null, sample: null, from: null, prefill: null });
  });

  it('starts from the operation sample unless a source names a request', () => {
    const none = { op: 'x', sample: null, from: null, prefill: null };
    expect(fillFor(passesCreate, none).source).toBe('reference');
    expect(fillFor(passesCreate, { ...none, from: 'req_1' }).source).toBe('log');
    const op = { ...passesCreate, samples: { s: { body: { a: 1 }, query: { q: '1' } } } };
    expect(fillFor(op, { ...none, sample: 's' })).toMatchObject({
      source: 'guide',
      prefill: { body: { a: 1 }, query: { q: '1' } },
    });
    expect(fillFor(op, { ...none, sample: 'unknown' }).source).toBe('reference');
  });
});

describe('the handoff', () => {
  it('is read once from storage and gone from it', () => {
    const nonce = stashHandoff({ body: { a: 1 }, note: 'n' });
    expect(sessionStorage.getItem(`wb-prefill:${nonce}`)).not.toBeNull();
    expect(takeHandoff(nonce)).toEqual({ body: { a: 1 }, note: 'n' });
    expect(sessionStorage.getItem(`wb-prefill:${nonce}`)).toBeNull();
    // A remount in the same tab still has it.
    expect(takeHandoff(nonce)).toEqual({ body: { a: 1 }, note: 'n' });
  });

  it('is null for an unknown or damaged nonce', () => {
    expect(takeHandoff('nope')).toBeNull();
    sessionStorage.setItem('wb-prefill:bad', '{not json');
    expect(takeHandoff('bad')).toBeNull();
  });

  it('is filled in as the reader’s own: no template swap', () => {
    const nonce = stashHandoff({ body: { templateId: 'mine' } });
    const got = fillFor(passesCreate, { op: 'x', sample: null, from: null, prefill: nonce });
    expect(got).toMatchObject({ source: 'handoff', prefill: { literal: true } });
  });
});

describe('an old hash link', () => {
  it('moves its body into a handoff and rewrites the address', () => {
    const next = shimHash('#passes.create?body=%7B%22a%22%3A1%7D&q.limit=5', '');
    const q = new URLSearchParams(next ?? '');
    expect(q.get('op')).toBe('passes.create');
    expect(next).not.toContain('%22a%22');
    expect(takeHandoff(q.get('prefill') ?? '')).toEqual({ query: { limit: '5' }, body: { a: 1 } });
  });

  it('leaves a plain address alone', () => {
    expect(shimHash('#passes.create', '')).toBeNull();
    expect(shimHash('', '?op=x')).toBeNull();
  });
});

describe('a logged call', () => {
  const ops = [
    { id: 'list', method: 'get', path: '/api/v1/passes' },
    { id: 'get', method: 'get', path: '/api/v1/passes/{id}' },
    { id: 'void', method: 'post', path: '/api/v1/passes/{id}/void' },
  ];
  it('names its operation by method and path, with the ids it carried', () => {
    expect(matchOp(ops, 'POST', '/api/v1/passes/p%201/void')).toEqual({
      id: 'void',
      ids: { id: 'p 1' },
    });
    expect(matchOp(ops, 'GET', '/api/v1/passes/')).toEqual({ id: 'list', ids: {} });
    expect(matchOp(ops, 'DELETE', '/api/v1/passes')).toBeNull();
  });

  it('reads its body when it is JSON, else nothing', () => {
    expect(bodyOfLog('{"a":1}')).toEqual({ a: 1 });
    expect(bodyOfLog('nope')).toBeUndefined();
    expect(bodyOfLog(null)).toBeUndefined();
  });
});
