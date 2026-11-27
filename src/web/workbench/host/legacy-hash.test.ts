import { afterEach, describe, expect, it } from 'vitest';
import { legacyHref } from './legacy-hash.ts';
import { readPrefill } from './prefill.ts';

afterEach(() => sessionStorage.clear());

describe('legacyHref', () => {
  it('moves an old console body into sessionStorage and names it by nonce', () => {
    const hash = `passes.postPasses?body=${encodeURIComponent('{"input":{"a":1}}')}&q.dry=1`;
    const href = legacyHref('console', hash, () => 'n1');
    expect(href).toBe('/workbench/console?op=passes.postPasses&prefill=n1');
    expect(href).not.toContain('input');
    expect(readPrefill('n1')).toEqual({
      op: 'passes.postPasses',
      body: { input: { a: 1 } },
      query: { dry: '1' },
    });
    // The stored entry is gone after the first read; a remount in the same page still has it.
    expect(sessionStorage.getItem('wb-prefill:n1')).toBeNull();
    expect(readPrefill('n1')).not.toBeNull();
  });

  it('keeps a plain operation as `?op=` and drops a body that is not JSON', () => {
    expect(legacyHref('console', 'passes.getPasses?body=%7Bnope')).toBe(
      '/workbench/console?op=passes.getPasses',
    );
    expect(sessionStorage.length).toBe(0);
  });

  it('leaves selections alone', () => {
    expect(legacyHref('console', 'req_1')).toBeNull();
    expect(legacyHref('logs', 'op?body=1')).toBeNull();
    expect(legacyHref('quickstart', 'step-2')).toBeNull();
  });

  it('sends the old Quickstart sandbox hashes to the Sandbox area', () => {
    // The Quickstart's own step 2 (sign-in returns to it) is not a moved hash.
    expect(legacyHref('quickstart', 'sandbox')).toBeNull();
    expect(legacyHref('quickstart', 'start-over')).toBe('/workbench/sandbox#start-over');
    expect(legacyHref('quickstart', 'delete-sandbox')).toBe('/workbench/sandbox#delete-sandbox');
  });
});
