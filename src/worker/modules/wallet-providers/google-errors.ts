export type GoogleWalletErrorCode =
  | 'invalid_credentials'
  | 'invalid_input'
  | 'network'
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

  constructor(code: GoogleWalletErrorCode, operation: string, status?: number) {
    super(`Google Wallet ${operation} failed (${code}).`);
    this.name = 'GoogleWalletError';
    this.code = code;
    this.operation = operation;
    this.status = status;
  }
}

export function googleHttpError(operation: string, status: number): GoogleWalletError {
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
  return new GoogleWalletError(code, operation, status);
}

export async function googleFetch(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  operation: string,
): Promise<Response> {
  try {
    return await fetcher(url, { ...init, redirect: 'error' });
  } catch {
    throw new GoogleWalletError('network', operation);
  }
}
