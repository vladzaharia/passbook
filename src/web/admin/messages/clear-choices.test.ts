import { describe, expect, it } from 'vitest';
import { ClearAfterSchema } from '@/shared/contracts/broadcasts.ts';
import { CLEAR_CHOICES, clearLabel } from './labels.ts';

describe('clear after choices', () => {
  it('offers six, keeping Never, 1 hour, 6 hours, 1 day and 7 days', () => {
    expect(CLEAR_CHOICES.map((c) => c.value)).toEqual(['never', '15m', '1h', '6h', '1d', '7d']);
  });

  it('are all accepted by the API contract', () => {
    for (const c of CLEAR_CHOICES) expect(ClearAfterSchema.safeParse(c.ms).success).toBe(true);
  });

  it('names a chosen delay', () => {
    expect(clearLabel(15 * 60_000)).toBe('after 15 min');
  });
});
