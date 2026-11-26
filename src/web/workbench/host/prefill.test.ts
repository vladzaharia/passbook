import { afterEach, describe, expect, it } from 'vitest';
import { PREFILL_KEY, readPrefill, writePrefill } from './prefill.ts';

afterEach(() => sessionStorage.clear());

describe('prefill', () => {
  it('stores under wb-prefill:<nonce>, reads once and deletes', () => {
    const nonce = writePrefill({ op: 'passes.getPasses', query: { limit: '5' } }, 'n1');
    expect(nonce).toBe('n1');
    expect(sessionStorage.getItem(`${PREFILL_KEY}n1`)).toContain('passes.getPasses');
    expect(readPrefill('n1')).toEqual({ op: 'passes.getPasses', query: { limit: '5' } });
    expect(sessionStorage.getItem(`${PREFILL_KEY}n1`)).toBeNull();
    expect(readPrefill('n1')).toBeNull();
  });

  it('makes a nonce when none is given, and reads nothing for an unknown one', () => {
    const nonce = writePrefill({ op: 'a', body: { x: 1 } });
    expect(nonce).toMatch(/^[0-9a-f-]{36}$/);
    expect(readPrefill('nope')).toBeNull();
  });
});
