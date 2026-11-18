import { describe, expect, it } from 'vitest';
import { GoogleWalletError } from './google-errors.ts';
import { WalletRuntimeError } from './runtime.ts';
import { SamsungNotificationError } from './samsung.ts';
import { classifyWalletSyncFailure } from './sync-errors.ts';

describe('wallet sync failure policy', () => {
  it('bounds Google retries and does not mark rate limiting successful', () => {
    const error = new GoogleWalletError('rate_limited', 'object PATCH', 429);
    expect(classifyWalletSyncFailure('google', 1, error)).toEqual({
      reason: 'rate_limited',
      disposition: 'retry',
      status: 429,
      retryAfterMs: 1_000,
    });
    expect(classifyWalletSyncFailure('google', 8, error)).toEqual({
      reason: 'rate_limited',
      disposition: 'failed',
      status: 429,
      retryAfterMs: null,
    });
  });

  it('bounds Samsung attempts independently and caps a provider retry delay', () => {
    const error = new SamsungNotificationError({
      kind: 'rate_limit',
      status: 429,
      retryable: true,
      ambiguous: false,
      retryAfterMs: 999_999,
    });
    expect(classifyWalletSyncFailure('samsung', 2, error)).toEqual({
      reason: 'rate_limited',
      disposition: 'retry',
      status: 429,
      retryAfterMs: 300_000,
    });
    expect(classifyWalletSyncFailure('samsung', 3, error)).toEqual({
      reason: 'rate_limited',
      disposition: 'failed',
      status: 429,
      retryAfterMs: null,
    });
  });

  it('holds ambiguous requests for reconciliation, even when the retry budget is exhausted', () => {
    expect(
      classifyWalletSyncFailure('google', 8, new GoogleWalletError('network', 'object PATCH')),
    ).toEqual({
      reason: 'unavailable',
      disposition: 'uncertain',
      status: null,
      retryAfterMs: null,
    });
    expect(
      classifyWalletSyncFailure(
        'samsung',
        3,
        new SamsungNotificationError({
          kind: 'unavailable',
          status: 503,
          retryable: false,
          ambiguous: true,
        }),
      ),
    ).toEqual({ reason: 'unavailable', disposition: 'uncertain', status: 503, retryAfterMs: null });
  });

  it('never exposes arbitrary error text and distinguishes preflight account failures', () => {
    expect(
      classifyWalletSyncFailure('google', 1, new Error('private bearer and holder data')),
    ).toEqual({
      reason: 'provider_error',
      disposition: 'uncertain',
      status: null,
      retryAfterMs: null,
    });
    expect(
      classifyWalletSyncFailure('google', 1, new WalletRuntimeError('account_unavailable')),
    ).toEqual({ reason: 'unauthorized', disposition: 'failed', status: null, retryAfterMs: null });
    expect(
      classifyWalletSyncFailure('google', 1, new WalletRuntimeError('account_unavailable', true)),
    ).toEqual({
      reason: 'unauthorized',
      disposition: 'uncertain',
      status: null,
      retryAfterMs: null,
    });
  });
  it('lets a provider Retry-After lengthen the backoff but never shorten it, up to the ceiling', () => {
    const wait = (attempt: number, retryAfterMs: number) =>
      classifyWalletSyncFailure(
        'google',
        attempt,
        new GoogleWalletError('rate_limited', 'runtime', 429, retryAfterMs),
      );
    expect(wait(2, 7_000)).toEqual({
      reason: 'rate_limited',
      disposition: 'retry',
      status: 429,
      retryAfterMs: 7_000,
    });
    expect(wait(4, 0).retryAfterMs).toBe(8_000);
    expect(wait(4, 1_000).retryAfterMs).toBe(8_000);
    expect(wait(1, 3_600_000).retryAfterMs).toBe(300_000);
    expect(wait(8, 7_000)).toMatchObject({ disposition: 'failed', retryAfterMs: null });
  });

  it('retries a 401 only when a cached token went stale, and never one from the token endpoint', () => {
    const stale = new GoogleWalletError('unauthorized', 'runtime', 401, undefined, true);
    expect(classifyWalletSyncFailure('google', 1, stale)).toEqual({
      reason: 'unauthorized',
      disposition: 'retry',
      status: 401,
      retryAfterMs: 1_000,
    });
    expect(classifyWalletSyncFailure('google', 8, stale)).toMatchObject({ disposition: 'failed' });
    const fresh = new GoogleWalletError('unauthorized', 'runtime', 401);
    expect(classifyWalletSyncFailure('google', 1, fresh)).toEqual({
      reason: 'unauthorized',
      disposition: 'failed',
      status: 401,
      retryAfterMs: null,
    });
    const oauth = new GoogleWalletError('unauthorized', 'oauth', 401);
    expect(classifyWalletSyncFailure('google', 1, oauth)).toMatchObject({ disposition: 'failed' });
    expect(
      classifyWalletSyncFailure('google', 1, new GoogleWalletError('forbidden', 'runtime', 403)),
    ).toMatchObject({ reason: 'unauthorized', disposition: 'failed' });
  });

  it('retries a token-exchange timeout but treats a REST timeout as ambiguous', () => {
    expect(
      classifyWalletSyncFailure('google', 2, new GoogleWalletError('timeout', 'oauth')),
    ).toEqual({ reason: 'timeout', disposition: 'retry', status: null, retryAfterMs: 2_000 });
    expect(
      classifyWalletSyncFailure('google', 8, new GoogleWalletError('timeout', 'oauth')),
    ).toMatchObject({ disposition: 'failed' });
    expect(
      classifyWalletSyncFailure('google', 1, new GoogleWalletError('timeout', 'runtime')),
    ).toEqual({ reason: 'timeout', disposition: 'uncertain', status: null, retryAfterMs: null });
    expect(
      classifyWalletSyncFailure('google', 1, new GoogleWalletError('server_error', 'oauth', 500)),
    ).toMatchObject({ disposition: 'uncertain' });
  });
});
