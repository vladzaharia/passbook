import { describe, expect, it } from 'vitest';
import { DEFAULT_TIME_ZONE, isCalendarMidnight, resolveOrgTimeZone } from './time-zone.ts';

describe('resolveOrgTimeZone', () => {
  it('is Seattle time with no setting', () => {
    expect(DEFAULT_TIME_ZONE).toBe('America/Los_Angeles');
    expect(resolveOrgTimeZone(undefined)).toBe(DEFAULT_TIME_ZONE);
    expect(resolveOrgTimeZone(null)).toBe(DEFAULT_TIME_ZONE);
    expect(resolveOrgTimeZone('')).toBe(DEFAULT_TIME_ZONE);
  });

  it('keeps an explicit zone', () => {
    expect(resolveOrgTimeZone('Europe/Berlin')).toBe('Europe/Berlin');
    expect(resolveOrgTimeZone('UTC')).toBe('UTC');
  });
});

describe('isCalendarMidnight', () => {
  it('is a date stored as midnight UTC, and nothing else', () => {
    expect(isCalendarMidnight('2030-01-01T00:00:00Z')).toBe(true);
    expect(isCalendarMidnight('2030-01-01T00:00:00.000Z')).toBe(true);
    expect(isCalendarMidnight('2030-01-01T00:00:01Z')).toBe(false);
    expect(isCalendarMidnight('2030-01-01T08:00:00Z')).toBe(false);
    expect(isCalendarMidnight('2030-01-01T00:00:00-08:00')).toBe(false);
  });
});
