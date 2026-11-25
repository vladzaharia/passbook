import { describe, expect, it } from 'vitest';
import { DEFAULT_TIME_ZONE, resolveOrgTimeZone } from './time-zone.ts';

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
