/** HTTP and network errors to the machine's `fail` (SA 2.8, AC 5). */
import { ApiError } from '../../lib/errors.ts';
import type { FailInfo } from '../machine/ports.ts';
import { ScanApiError } from './errors.ts';

/**
 * `principal` tells a scanner's 401 (the credential was revoked or expired) from an admin's (the
 * session ended). A scanner whose cookie is gone altogether is signed out: the boot shows pairing.
 */
export function toFail(error: unknown, principal: 'scanner' | 'admin' = 'scanner'): FailInfo {
  if (error instanceof DOMException && error.name === 'AbortError') return { error: 'timeout' };
  if (!(error instanceof ApiError))
    return error instanceof TypeError ? { error: 'network' } : { error: 'server' };
  switch (error.status) {
    case 0:
      return { error: 'network' };
    case 401:
      if (principal === 'admin' || error.code === 'SCANNER_UNAUTHENTICATED')
        return { error: 'signed_out' };
      return { error: 'revoked' };
    case 403:
      if (error.code === 'ORG_INACTIVE' || error.code === 'ORG_SUSPENDED')
        return { error: 'suspended' };
      if (error.code === 'STAFF_REQUIRED') return { error: 'staff_required' };
      return { error: 'forbidden' };
    case 422:
      return { error: 'forbidden' };
    case 429: {
      const wait = error instanceof ScanApiError ? error.retryAfterMs : undefined;
      return wait === undefined
        ? { error: 'rate_limited' }
        : { error: 'rate_limited', retryAfterMs: wait };
    }
    default:
      return error.status >= 500 && error.requestId
        ? { error: 'server', requestId: error.requestId }
        : { error: 'server' };
  }
}
