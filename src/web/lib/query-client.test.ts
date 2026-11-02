import { describe, expect, it } from 'vitest';
import { ApiError } from './errors.ts';
import { shouldRetry } from './query-client.ts';

describe('shouldRetry', () => {
  it('does not retry a response that failed its schema', () => {
    expect(shouldRetry(0, new ApiError({ status: 502, code: 'invalid_response' }))).toBe(false);
  });

  it('retries transient failures twice', () => {
    const error = new ApiError({ status: 503, code: 'unavailable' });
    expect(shouldRetry(0, error)).toBe(true);
    expect(shouldRetry(1, error)).toBe(true);
    expect(shouldRetry(2, error)).toBe(false);
  });

  it('does not retry client errors', () => {
    expect(shouldRetry(0, new ApiError({ status: 404, code: 'not_found' }))).toBe(false);
  });
});
