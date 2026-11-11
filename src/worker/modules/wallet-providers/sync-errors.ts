import { GoogleWalletError } from './google-errors.ts';
import { WalletRuntimeError } from './runtime.ts';
import { SamsungNotificationError } from './samsung.ts';

/** Provider responses are reduced to this allowlisted, non-sensitive representation. */
export type WalletSyncReason =
  | 'rate_limited'
  | 'unavailable'
  | 'timeout'
  | 'unauthorized'
  | 'rejected'
  | 'invalid_response'
  | 'provider_error';

export interface WalletSyncFailure {
  reason: WalletSyncReason;
  disposition: 'retry' | 'failed' | 'uncertain';
  status: number | null;
  retryAfterMs: number | null;
}

export const MAX_WALLET_SYNC_ATTEMPTS = 8;
export const MAX_SAMSUNG_SYNC_ATTEMPTS = 3;
const MAX_RETRY_MS = 300_000;

function retryDelay(attempt: number, requested?: number): number {
  const exponential = Math.min(MAX_RETRY_MS, 1_000 * 2 ** Math.max(0, attempt - 1));
  return requested !== undefined && Number.isFinite(requested)
    ? Math.min(MAX_RETRY_MS, Math.max(0, requested))
    : exponential;
}

function statusOf(status: number | undefined): number | null {
  return status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : null;
}

/**
 * Classify only an error from a provider operation. Ambiguous requests are never retried while
 * their transport might still complete: the durable claim stays uncertain until reconciled.
 * In particular, a provider 5xx or an exception without a response is not reported as success.
 */
export function classifyWalletSyncFailure(
  provider: 'google' | 'samsung',
  attempt: number,
  error: unknown,
): WalletSyncFailure {
  const limit = provider === 'samsung' ? MAX_SAMSUNG_SYNC_ATTEMPTS : MAX_WALLET_SYNC_ATTEMPTS;
  const canRetry = Number.isSafeInteger(attempt) && attempt >= 1 && attempt < limit;
  if (error instanceof WalletRuntimeError) {
    return {
      reason: error.code === 'account_unavailable' ? 'unauthorized' : 'provider_error',
      disposition: error.ambiguous ? 'uncertain' : 'failed',
      status: null,
      retryAfterMs: null,
    };
  }
  if (provider === 'google' && error instanceof GoogleWalletError) {
    const status = statusOf(error.status);
    if (
      error.code === 'network' ||
      error.code === 'server_error' ||
      status === 408 ||
      (status !== null && status >= 500)
    ) {
      return {
        reason: status === 408 ? 'timeout' : 'unavailable',
        disposition: 'uncertain',
        status,
        retryAfterMs: null,
      };
    }
    if (error.code === 'rate_limited') {
      return {
        reason: 'rate_limited',
        disposition: canRetry ? 'retry' : 'failed',
        status,
        retryAfterMs: canRetry ? retryDelay(attempt) : null,
      };
    }
    const reason: WalletSyncReason =
      error.code === 'unauthorized' ||
      error.code === 'forbidden' ||
      error.code === 'invalid_credentials'
        ? 'unauthorized'
        : error.code === 'invalid_response'
          ? 'invalid_response'
          : error.code === 'bad_request' ||
              error.code === 'invalid_input' ||
              error.code === 'not_found' ||
              error.code === 'conflict'
            ? 'rejected'
            : 'provider_error';
    return { reason, disposition: 'failed', status, retryAfterMs: null };
  }
  if (provider === 'samsung' && error instanceof SamsungNotificationError) {
    const status = statusOf(error.status);
    const reason: WalletSyncReason =
      error.kind === 'rate_limit'
        ? 'rate_limited'
        : error.kind === 'network' || error.kind === 'unavailable'
          ? 'unavailable'
          : error.kind === 'authentication'
            ? 'unauthorized'
            : error.kind === 'protocol'
              ? 'provider_error'
              : 'rejected';
    if (error.ambiguous) return { reason, disposition: 'uncertain', status, retryAfterMs: null };
    const retry = error.retryable && canRetry;
    return {
      reason,
      disposition: retry ? 'retry' : 'failed',
      status,
      retryAfterMs: retry ? retryDelay(attempt, error.retryAfterMs) : null,
    };
  }
  // Runtime failures can happen after bytes leave the worker. Never include their message, URL,
  // stack, request/response body, or credentials in a durable outcome or a log.
  return { reason: 'provider_error', disposition: 'uncertain', status: null, retryAfterMs: null };
}
