import { describe, expect, it } from 'vitest';
import { KEY_EXPIRY_DAYS } from './developers-keys.ts';

describe('key expiry choices', () => {
  it('offers six, ascending, keeping 7, 30 and 90', () => {
    expect([...KEY_EXPIRY_DAYS]).toEqual([1, 7, 14, 30, 60, 90]);
  });

  it('stays inside the server cap of 90 days', () => {
    expect(Math.max(...KEY_EXPIRY_DAYS)).toBeLessThanOrEqual(90);
  });
});
