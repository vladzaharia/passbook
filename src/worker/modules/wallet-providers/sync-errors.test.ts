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
  it('honours a provider Retry-After on 429, bounded by the retry ceiling', () => {
    const limited = new GoogleWalletError('rate_limited', 'runtime', 429, 7_000);
    expect(classifyWalletSyncFailure('google', 2, limited)).toEqual({
      reason: 'rate_limited',
      disposition: 'retry',
      status: 429,
      retryAfterMs: 7_000,
    });
    const huge = new GoogleWalletError('rate_limited', 'runtime', 429, 3_600_000);
    expect(classifyWalletSyncFailure('google', 2, huge).retryAfterMs).toBe(300_000);
    expect(classifyWalletSyncFailure('google', 8, limited)).toMatchObject({
      disposition: 'failed',
      retryAfterMs: null,
    });
  });

  it('treats a Google timeout as ambiguous and a 401 as retryable once the token is dropped', () => {
    expect(
      classifyWalletSyncFailure('google', 1, new GoogleWalletError('timeout', 'runtime')),
    ).toEqual({ reason: 'timeout', disposition: 'uncertain', status: null, retryAfterMs: null });
    const stale = new GoogleWalletError('unauthorized', 'runtime', 401);
    expect(classifyWalletSyncFailure('google', 1, stale)).toEqual({
      reason: 'unauthorized',
      disposition: 'retry',
      status: 401,
      retryAfterMs: 1_000,
    });
    expect(classifyWalletSyncFailure('google', 8, stale)).toMatchObject({ disposition: 'failed' });
    expect(
      classifyWalletSyncFailure('google', 1, new GoogleWalletError('forbidden', 'runtime', 403)),
    ).toMatchObject({ reason: 'unauthorized', disposition: 'failed' });
  });
});
