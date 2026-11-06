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
