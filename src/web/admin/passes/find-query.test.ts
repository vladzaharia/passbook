import { describe, expect, it } from 'vitest';
import { PassMatchSchema } from '@/shared/contracts/broadcasts.ts';
import { inputFields } from '@/shared/issuing/fields.ts';
import {
  allChips,
  canonical,
  chipFilter,
  parseChips,
  searchOfFilter,
  suggest,
  toPassFilter,
} from './find-query.ts';

const fields = inputFields({
  properties: {
    memberId: { type: 'string', 'x-label': 'Member ID' },
    name: { type: 'string', 'x-label': 'Name' },
    plan: { type: 'string', enum: ['monthly', 'annual'], 'x-enumLabels': { monthly: 'Monthly' } },
    paidThrough: { type: 'string', format: 'date' },
  },
});

describe('suggest', () => {
  it('reads an id-like text as starts with, then name, then any field', () => {
    const s = suggest('M-20', fields);
    expect(s[0]?.chip).toEqual({ k: 'memberId', o: 'startsWith', v: 'M-20' });
    expect(s.at(-1)?.chip.k).toBe('$any');
  });
  it('reads an email as the holder, and a plan label as that plan', () => {
    expect(suggest('ana@example.com', fields)[0]?.chip).toEqual({
      k: '$email',
      o: 'is',
      v: 'ana@example.com',
    });
    expect(suggest('monthly', fields)[0]?.chip).toEqual({ k: 'plan', o: 'is', v: 'monthly' });
  });
  it('offers name contains for plain words and nothing for blanks', () => {
    expect(suggest('ana', fields)[0]?.chip).toEqual({ k: 'name', o: 'contains', v: 'ana' });
    expect(suggest('  ', fields)).toEqual([]);
  });
});

describe('chips', () => {
  it('compile to a match the API accepts, with email and free text on their own', () => {
    const chips = allChips({
      q: 'x',
      m: JSON.stringify([
        { k: 'plan', o: 'is', v: 'monthly' },
        { k: 'memberId', o: 'startsWith', v: 'M-2' },
        { k: '$email', o: 'is', v: 'a@b.co' },
      ]),
    });
    const f = chipFilter(chips);
    expect(PassMatchSchema.safeParse(f.match).success).toBe(true);
    expect([f.q, f.holderEmail]).toEqual(['x', 'a@b.co']);
  });
  it('ignore a malformed URL value', () => {
    expect(parseChips('{nope')).toEqual([]);
    expect(parseChips(JSON.stringify([{ k: 'a', o: 'bad', v: 'c' }]))).toEqual([]);
  });
  it('round-trip through a saved filter', () => {
    const chips = [
      { k: 'plan', o: 'is' as const, v: 'monthly' },
      { k: 'name', o: 'contains' as const, v: 'ana' },
    ];
    const filter = toPassFilter({ templateId: 't1', status: 'active', chips });
    const back = searchOfFilter(filter);
    expect(toPassFilter({ ...back, chips: allChips(back) })).toEqual(filter);
    expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
  });
});
