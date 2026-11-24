import { describe, expect, it } from 'vitest';
import { liveDraft, nextDraft, splitHeadline } from './customer-draft.ts';

const view = { band: { headline: 'To pay $12.00', sub: null } } as never;

describe('customer draft', () => {
  it('splits the headline by the copy', () => {
    expect(splitHeadline('To pay $12.00')).toEqual({ label: 'To pay', value: '$12.00' });
    expect(splitHeadline('Adding 20,00 €')).toEqual({ label: 'Adding', value: '20,00 €' });
    expect(splitHeadline('Hello')).toEqual({ label: '', value: 'Hello' });
  });
  it('the latest at wins and a cancel for the same ref clears', () => {
    const a = nextDraft(null, { ref: 'r', at: 10, customer: view });
    expect(nextDraft(a, { ref: 'r', at: 5, customer: view })).toBe(a);
    expect(nextDraft(a, { ref: 'r', at: 11, cancelled: true })).toBeNull();
    expect(nextDraft(a, { ref: 'other', at: 11, cancelled: true })).toBe(a);
  });
  it('ignores a draft for another ref or older than 60 s', () => {
    const a = nextDraft(null, { ref: 'r', at: 1000, customer: view });
    expect(liveDraft(a, 'r', 1000 + 59_999)).toBe(a);
    expect(liveDraft(a, 'r', 1000 + 60_000)).toBeNull();
    expect(liveDraft(a, 'x', 1000)).toBeNull();
    expect(liveDraft(a, undefined, 1000)).toBeNull();
  });
});
