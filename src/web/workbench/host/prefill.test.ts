import { afterEach, describe, expect, it } from 'vitest';
import { consolePrefillPath, PREFILL_KEY, readPrefill, writePrefill } from './prefill.ts';

afterEach(() => sessionStorage.clear());

describe('prefill', () => {
  it('is read once, then gone', () => {
    const nonce = writePrefill({ op: 'events.getEventsById', path: { id: 'ev1' }, body: { a: 1 } });
    expect(nonce).toBeTruthy();
    expect(readPrefill(nonce as string)).toEqual({
      op: 'events.getEventsById',
      path: { id: 'ev1' },
      body: { a: 1 },
    });
    expect(sessionStorage.getItem(`${PREFILL_KEY}${nonce}`)).toBeNull();
    expect(readPrefill(nonce as string)).toBeNull();
  });

  it('refuses a broken entry', () => {
    sessionStorage.setItem(`${PREFILL_KEY}bad`, '{nope');
    expect(readPrefill('bad')).toBeNull();
    sessionStorage.setItem(`${PREFILL_KEY}noop`, JSON.stringify({ query: {} }));
    expect(readPrefill('noop')).toBeNull();
  });

  it('puts the operation and the nonce in the link, never a body', () => {
    const href = consolePrefillPath('o1', { op: 'createPass', body: { name: 'x' } });
    expect(href).toMatch(/^\/workbench\/o\/o1\/console\?op=createPass&prefill=[\w-]{8}$/);
    expect(href).not.toMatch(/name/);
  });
});
