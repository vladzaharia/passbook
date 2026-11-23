export type GoogleWalletErrorCode =
  | 'invalid_credentials'
  | 'invalid_input'
  | 'network'
  | 'timeout'
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'server_error'
  | 'provider_error'
  | 'invalid_response';

/** Messages and properties deliberately exclude provider bodies, credentials, and request URLs. */
export class GoogleWalletError extends Error {
  readonly code: GoogleWalletErrorCode;
  readonly operation: string;
  readonly status: number | undefined;
  /** Provider `Retry-After`, already parsed to milliseconds and capped. */
  readonly retryAfterMs: number | undefined;
  /** A 401 on a REST call that used a cached token: a fresh token may succeed. */
  readonly staleToken: boolean;

  constructor(
    code: GoogleWalletErrorCode,
    operation: string,
    status?: number,
    retryAfterMs?: number,
    staleToken = false,
  ) {
    super(`Google Wallet ${operation} failed (${code}).`);
    this.name = 'GoogleWalletError';
    this.code = code;
    this.operation = operation;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.staleToken = staleToken;
  }
}

/** Every Google request is bounded; a timeout leaves the outcome unknown. */
export const GOOGLE_FETCH_TIMEOUT_MS = 10_000;
const MAX_RETRY_AFTER_MS = 3_600_000;

/** `Retry-After` is delta-seconds or an HTTP date (the latter needs `nowMs`). */
export function parseRetryAfter(value: string | null, nowMs?: number): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d{1,7}$/.test(text)) return Math.min(Number(text) * 1000, MAX_RETRY_AFTER_MS);
  const at = nowMs === undefined || !/[A-Za-z]/.test(text) ? Number.NaN : Date.parse(text);
  return Number.isFinite(at)
    ? Math.min(Math.max(0, at - (nowMs ?? 0)), MAX_RETRY_AFTER_MS)
    : undefined;
}

export function googleHttpError(
  operation: string,
  status: number,
  headers?: Headers,
  nowMs?: number,
  staleToken = false,
): GoogleWalletError {
  const code: GoogleWalletErrorCode =
    status === 400
      ? 'bad_request'
      : status === 401
        ? 'unauthorized'
        : status === 403
          ? 'forbidden'
          : status === 404
            ? 'not_found'
            : status === 409
              ? 'conflict'
              : status === 429
                ? 'rate_limited'
                : status >= 500
                  ? 'server_error'
                  : 'provider_error';
  const retryAfterMs =
    status === 429 || status === 503
      ? parseRetryAfter(headers?.get('retry-after') ?? null, nowMs)
      : undefined;
  return new GoogleWalletError(code, operation, status, retryAfterMs, staleToken);
}

export async function googleFetch(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  operation: string,
  timeoutMs = GOOGLE_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  let response: Response;
  try {
    // workerd refuses redirect 'error'. 'manual' never follows, so a credential goes to one host only.
    response = await fetcher(url, { ...init, redirect: 'manual', signal });
  } catch (error) {
    throw new GoogleWalletError(
      timeout.aborted && error instanceof Error && error.name === 'TimeoutError'
        ? 'timeout'
        : 'network',
      operation,
    );
  }
  if (response.status >= 300 && response.status < 400)
    throw new GoogleWalletError('provider_error', operation, response.status);
  return response;
}

/**
 * Google's refusal of a fourth notifying message in 24 h (docs/design/wallet-providers/google-messages.md section 7). Google
 * documents no status for it, so any of 400, 403 or 429 whose JSON error names QuotaExceeded counts.
 */
export function isGoogleNotifyQuota(status: number, body: string): boolean {
  if (status !== 400 && status !== 403 && status !== 429) return false;
  let error: unknown;
  try {
    error = (JSON.parse(body) as { error?: unknown }).error;
  } catch {
    return false;
  }
  if (typeof error !== 'object' || error === null) return false;
  const { message, status: name, errors } = error as Record<string, unknown>;
  const reasons = Array.isArray(errors)
    ? errors.map((e) => (e as { reason?: unknown })?.reason)
    : [];
  return [message, name, ...reasons].some(
    (v) => typeof v === 'string' && /quotaexceeded/iu.test(v),
  );
}
