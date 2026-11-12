import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/errors.ts';
import { ScanApiError } from './scan-api.ts';
import { toFail } from './to-fail.ts';

const err = (
  status: number,
  code: string,
  extra: Partial<{ requestId: string; retryAfterMs: number }> = {},
) => new ScanApiError({ status, code, requestId: extra.requestId }, extra.retryAfterMs);

describe('toFail (SA 2.8)', () => {
  it('maps a network failure and an abort', () => {
    expect(toFail(new ApiError({ status: 0, code: 'network' }))).toEqual({ error: 'network' });
    expect(toFail(new DOMException('aborted', 'AbortError'))).toEqual({ error: 'timeout' });
    expect(toFail(new TypeError('Failed to fetch'))).toEqual({ error: 'network' });
  });

  it('maps a 401 on a scanner to the revoked block, an unpaired cookie and an admin to signed out', () => {
    expect(toFail(err(401, 'SCANNER_REVOKED'))).toEqual({ error: 'revoked' });
    expect(toFail(err(401, 'SCANNER_EXPIRED'))).toEqual({ error: 'revoked' });
    expect(toFail(err(401, 'SCANNER_UNAUTHENTICATED'))).toEqual({ error: 'signed_out' });
    expect(toFail(err(401, 'UNAUTHENTICATED'), 'admin')).toEqual({ error: 'signed_out' });
    expect(toFail(err(401, 'WHATEVER'))).toEqual({ error: 'revoked' });
  });

  it('maps the 403s', () => {
    expect(toFail(err(403, 'ORG_INACTIVE'))).toEqual({ error: 'suspended' });
    expect(toFail(err(403, 'STAFF_REQUIRED'))).toEqual({ error: 'staff_required' });
    expect(toFail(err(403, 'SCAN_FORBIDDEN'))).toEqual({ error: 'forbidden' });
    expect(toFail(err(403, 'SCREEN_ONLY'))).toEqual({ error: 'forbidden' });
  });

  it('a staff change asks for the PIN again; neither 409 unpairs', () => {
    expect(toFail(err(409, 'SCAN_STAFF_CHANGED'))).toEqual({ error: 'staff_required' });
    expect(toFail(err(409, 'SCAN_CONFIG_CHANGED')).error).not.toBe('revoked');
  });

  it('maps a 429 to rate_limited with Retry-After', () => {
    expect(toFail(err(429, 'RATE_LIMITED', { retryAfterMs: 7000 }))).toEqual({
      error: 'rate_limited',
      retryAfterMs: 7000,
    });
    expect(toFail(err(429, 'RATE_LIMITED'))).toEqual({ error: 'rate_limited' });
  });

  it('maps 5xx to server with the request id, and a 422 body error to forbidden', () => {
    expect(toFail(err(500, 'server_error', { requestId: 'req-1' }))).toEqual({
      error: 'server',
      requestId: 'req-1',
    });
    expect(toFail(err(422, 'SCAN_ACTION_UNKNOWN'))).toEqual({ error: 'forbidden' });
    expect(toFail(err(409, 'PASS_CONFLICT'))).toEqual({ error: 'server' });
    expect(toFail(err(409, 'SCAN_CONFIG_CHANGED'))).toEqual({ error: 'server' });
    expect(toFail(new Error('boom'))).toEqual({ error: 'server' });
  });
});
