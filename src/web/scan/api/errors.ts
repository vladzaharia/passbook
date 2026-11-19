import { ApiError, type ApiErrorInit } from '../../lib/errors.ts';

/** An `ApiError` that also carries the `Retry-After` of a 429 or 409, in ms. */
export class ScanApiError extends ApiError {
  readonly retryAfterMs: number | undefined;
  constructor(init: ApiErrorInit, retryAfterMs?: number) {
    super(init);
    this.name = 'ScanApiError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * A 409 for configuration drift reloads the session and retries once. The session read itself is
 * excluded: its refetch is that very request, so waiting on it would never end.
 */
export function canReload(
  deps: { refreshConfig?: () => Promise<void> },
  path: string,
  call: { signal?: AbortSignal },
): boolean {
  return Boolean(deps.refreshConfig) && !call.signal?.aborted && path.split('?')[0] !== '/session';
}
