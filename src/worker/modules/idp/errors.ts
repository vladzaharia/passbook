import { AppError } from '../../platform/errors.ts';
import type { Logger } from '../../platform/log.ts';
import { IDP_CODES, type IdpCode } from './types.ts';

const CODE = /^(IDP_[A-Z_]+): ?/;

export const IDP_UNAVAILABLE_MESSAGE = 'Polaris ID is not reachable. Try again in a few minutes.';

const codeOfMessage = (error: unknown): string | undefined =>
  CODE.exec(error instanceof Error ? error.message : '')?.[1];

/** The binding's code behind a mapped error (kept as its `cause`), or null for anything else. */
export function idpCodeOf(error: unknown): IdpCode | null {
  for (let e: unknown = error, depth = 0; e instanceof Error && depth < 4; depth++) {
    const code = codeOfMessage(e);
    if (code && (IDP_CODES as readonly string[]).includes(code)) return code as IdpCode;
    e = e.cause;
  }
  return null;
}

/** Maps an RPC failure to an AppError. The binding sends its code as the message prefix; its text never reaches users, but the error keeps it as `cause`. */
export function mapIdpError(error: unknown, log?: Logger): AppError {
  if (error instanceof AppError) return error;
  const code = codeOfMessage(error);
  const cause = { cause: error };
  switch (code) {
    case 'IDP_BUDGET':
      return new AppError(
        'IDP_BUDGET',
        429,
        'Too many Polaris ID changes today. Try again tomorrow.',
        {
          ...cause,
          headers: { 'retry-after': '3600' },
        },
      );
    case 'IDP_REFUSED':
      return new AppError(
        'IDP_REFUSED',
        403,
        'Polaris ID refused this change. Ask the PassBook owner.',
        cause,
      );
    case 'IDP_NOT_FOUND':
    case 'IDP_CONFLICT':
      return new AppError('IDP_CONFLICT', 409, 'Polaris ID changed. Try again.', cause);
    case 'IDP_FROZEN':
      return new AppError(
        'IDP_FROZEN',
        503,
        'Polaris ID changes are paused. Ask the PassBook owner.',
        cause,
      );
    case 'IDP_NOT_MANAGED':
      return new AppError(
        'IDP_NOT_MANAGED',
        409,
        "PassBook doesn't manage this Polaris ID account.",
        cause,
      );
    case 'IDP_IN_USE':
      return new AppError('IDP_IN_USE', 409, 'This group still has members or apps.', cause);
    case 'IDP_BREAKER':
      log?.error('idp.breaker', { code: 'IDP_BREAKER' });
      return new AppError('IDP_UNAVAILABLE', 503, IDP_UNAVAILABLE_MESSAGE, cause);
    default:
      // IDP_AUTH, IDP_UPSTREAM, IDP_UNSAFE_CONFIG, IDP_MISCONFIGURED, IDP_DRIFT and anything unknown.
      log?.error('idp.unavailable', { code: code ?? 'IDP_UNKNOWN' });
      return new AppError('IDP_UNAVAILABLE', 503, IDP_UNAVAILABLE_MESSAGE, cause);
  }
}
