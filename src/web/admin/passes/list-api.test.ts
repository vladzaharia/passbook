import { describe, expect, it } from 'vitest';
import { EMAIL_KEY } from './find-query.ts';
import { isFiltered } from './list-api.ts';

const emailChip = JSON.stringify([{ k: EMAIL_KEY, o: 'is', v: 'a@example.com' }]);
const fieldChip = JSON.stringify([{ k: 'seat', o: 'is', v: '4' }]);

describe('isFiltered', () => {
  it('counts a holder-email chip across organizations', () => {
    expect(isFiltered({ m: emailChip }, true)).toBe(true);
  });

  it('ignores single-organization chips across organizations', () => {
    expect(isFiltered({ m: fieldChip }, true)).toBe(false);
    expect(isFiltered({ templateId: 'x' }, true)).toBe(false);
  });

  it('ignores orgIds in one organization and counts the chips', () => {
    expect(isFiltered({ orgIds: 'a,b' }, false)).toBe(false);
    expect(isFiltered({ m: fieldChip }, false)).toBe(true);
  });
});
