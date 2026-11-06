import { describe, expect, it } from 'vitest';
import { localDayStart } from './counts.ts';

describe('scanner local midnight', () => {
  it.each([
    ['2026-11-01T18:00:00Z', 'America/New_York', '2026-11-01T04:00:00Z'],
    ['2026-03-08T18:00:00Z', 'America/New_York', '2026-03-08T05:00:00Z'],
    ['2026-10-04T10:00:00Z', 'Australia/Lord_Howe', '2026-10-03T13:30:00Z'],
    ['2026-11-05T18:00:00Z', 'Asia/Kolkata', '2026-11-04T18:30:00Z'],
  ])('finds midnight across offset changes in %s, %s', (now, zone, midnight) => {
    expect(localDayStart(Date.parse(now), zone)).toBe(Date.parse(midnight));
  });
});
