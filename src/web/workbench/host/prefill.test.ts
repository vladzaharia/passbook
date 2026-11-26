import { afterEach, describe, expect, it } from 'vitest';
import { consolePrefillPath, PREFILL_KEY, readPrefill, writePrefill } from './prefill.ts';

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

  it('makes a nonce when none is given, keeps path and body, and reads nothing for an unknown one', () => {
    const nonce = writePrefill({ op: 'events.getEventsById', path: { id: 'ev1' }, body: { a: 1 } });
    expect(nonce).toMatch(/^[0-9a-f-]{36}$/);
    expect(readPrefill(nonce as string)).toEqual({
      op: 'events.getEventsById',
      path: { id: 'ev1' },
      body: { a: 1 },
    });
    expect(readPrefill('nope')).toBeNull();
  });

  it('refuses a broken entry', () => {
    sessionStorage.setItem(`${PREFILL_KEY}bad`, '{nope');
    expect(readPrefill('bad')).toBeNull();
    sessionStorage.setItem(`${PREFILL_KEY}noop`, JSON.stringify({ query: {} }));
    expect(readPrefill('noop')).toBeNull();
  });

  it('puts the operation and the nonce in the link, never a body', () => {
    const href = consolePrefillPath('o1', { op: 'createPass', body: { name: 'x' } });
    expect(href).toMatch(/^\/workbench\/o\/o1\/console\?op=createPass&prefill=[\w-]+$/);
    expect(href).not.toMatch(/name/);
  });
});
