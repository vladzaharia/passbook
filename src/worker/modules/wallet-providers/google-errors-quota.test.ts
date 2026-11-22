import { describe, expect, it } from 'vitest';
import { isGoogleNotifyQuota } from './google-errors.ts';

const body = (error: unknown) => JSON.stringify({ error });

describe('isGoogleNotifyQuota', () => {
  it('matches a 429 naming the quota', () => {
    expect(
      isGoogleNotifyQuota(
        429,
        body({
          code: 429,
          message: 'QuotaExceededException: too many',
          status: 'RESOURCE_EXHAUSTED',
        }),
      ),
    ).toBe(true);
  });

  it('matches 400 and 403 bodies, including errors[].reason', () => {
    expect(isGoogleNotifyQuota(400, body({ message: 'x', status: 'QUOTAEXCEEDED' }))).toBe(true);
    expect(isGoogleNotifyQuota(403, body({ errors: [{ reason: 'quotaExceeded' }] }))).toBe(true);
  });

  it('treats a plain 429 as rate limiting', () => {
    expect(isGoogleNotifyQuota(429, body({ message: 'Too many requests' }))).toBe(false);
    expect(isGoogleNotifyQuota(429, 'not json')).toBe(false);
  });

  it('does not match a permission error or other statuses', () => {
    expect(isGoogleNotifyQuota(403, body({ message: 'PermissionDenied' }))).toBe(false);
    expect(isGoogleNotifyQuota(500, body({ message: 'QuotaExceededException' }))).toBe(false);
  });
});
