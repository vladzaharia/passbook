import { describe, expect, it } from 'vitest';
import { formatRecentDateTimeIn } from './format-recent.ts';

describe('formatRecentDateTimeIn', () => {
  const now = Date.UTC(2026, 10, 27, 12);
  it('drops the year in the current year of the zone', () => {
    expect(formatRecentDateTimeIn(Date.UTC(2026, 10, 27, 12, 4), 'America/Los_Angeles', now)).toBe(
      'Nov 27, 4:04 AM',
    );
  });
  it('keeps the year in another year', () => {
    expect(formatRecentDateTimeIn(Date.UTC(2025, 10, 27, 12, 4), 'America/Los_Angeles', now)).toBe(
      'Nov 27, 2025, 4:04 AM',
    );
  });
});
