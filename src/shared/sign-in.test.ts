import { describe, expect, it } from 'vitest';
import { isRecentSignIn } from './sign-in.ts';

describe('isRecentSignIn', () => {
  it('accepts a sign-in inside the window, edge included', () => {
    expect(isRecentSignIn(1_000, 61_000, 60)).toBe(true);
    expect(isRecentSignIn(1_000, 61_001, 60)).toBe(false);
  });
  it('refuses a missing sign-in time', () => {
    expect(isRecentSignIn(null, 1, 60)).toBe(false);
    expect(isRecentSignIn(undefined, 1, 60)).toBe(false);
  });
});
