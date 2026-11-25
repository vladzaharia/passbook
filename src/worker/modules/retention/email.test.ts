import { describe, expect, it } from 'vitest';
import { shortenEmail } from './email.ts';

describe('shortenEmail', () => {
  it('names the day in the org zone', () => {
    // 03:00 UTC on 1 June is still 31 May in Seattle.
    const from = Date.UTC(2026, 5, 1, 3);
    const seattle = shortenEmail('https://x.test', 'scans', 30, from, 'America/Los_Angeles');
    const tokyo = shortenEmail('https://x.test', 'scans', 30, from, 'Asia/Tokyo');
    expect(seattle.html).toContain('2026-05-31');
    expect(tokyo.html).toContain('2026-06-01');
  });
});
