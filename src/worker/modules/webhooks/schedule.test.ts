import { describe, expect, it } from 'vitest';
import {
  MAX_ATTEMPTS,
  parseRetryAfter,
  RETRY_AFTER_CAP_MS,
  RETRY_DELAYS_MS,
  retryDelay,
} from './schedule.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('retry schedule', () => {
  it('follows the table with the final failure on the ninth attempt', () => {
    expect(RETRY_DELAYS_MS).toEqual([
      MIN,
      5 * MIN,
      30 * MIN,
      2 * HOUR,
      6 * HOUR,
      12 * HOUR,
      24 * HOUR,
      24 * HOUR,
    ]);
    expect(MAX_ATTEMPTS).toBe(9);
    expect(retryDelay(1, 0.5)).toBe(MIN);
    expect(retryDelay(8, 0.5)).toBe(24 * HOUR);
    expect(retryDelay(9, 0.5)).toBeNull();
    // About 68.6 h in all.
    const total = RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total / HOUR).toBeCloseTo(68.6, 1);
  });

  it('jitters by at most 10 percent either way', () => {
    for (let attempt = 1; attempt <= 8; attempt++) {
      const base = RETRY_DELAYS_MS[attempt - 1] as number;
      expect(retryDelay(attempt, 0)).toBe(Math.round(base * 0.9));
      expect(retryDelay(attempt, 0.999999)).toBeLessThanOrEqual(Math.round(base * 1.1));
      expect(retryDelay(attempt, 0.999999)).toBeGreaterThan(base);
    }
  });

  it('honours Retry-After when it is longer than the schedule, capped at 6 h', () => {
    expect(retryDelay(1, 0.5, 10 * MIN)).toBe(10 * MIN);
    expect(retryDelay(1, 0.5, 5_000)).toBe(MIN);
    expect(retryDelay(1, 0.5, 48 * HOUR)).toBe(RETRY_AFTER_CAP_MS);
    // A long schedule step is not shortened by a short header.
    expect(retryDelay(7, 0.5, 10 * MIN)).toBe(24 * HOUR);
  });

  it('parses delta-seconds and HTTP dates, and ignores junk', () => {
    expect(parseRetryAfter('120', 0)).toBe(120_000);
    expect(parseRetryAfter(null, 0)).toBeNull();
    expect(parseRetryAfter('soon', 0)).toBeNull();
    const now = Date.UTC(2026, 11, 1, 0, 0, 0);
    expect(parseRetryAfter('Tue, 01 Dec 2026 00:10:00 GMT', now)).toBe(10 * MIN);
    expect(parseRetryAfter('Tue, 01 Dec 2026 00:00:00 GMT', now + MIN)).toBe(0);
  });
});
