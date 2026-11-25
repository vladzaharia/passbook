import {
  AppError,
  ConflictError,
  ForbiddenError,
  UnavailableError,
} from '../../platform/errors.ts';
import type { Logger } from '../../platform/log.ts';

const CODE = /^(IDP_[A-Z_]+): ?/;

export const IDP_UNAVAILABLE_MESSAGE = 'Polaris ID is not reachable. Try again in a few minutes.';
const unavailable = (): AppError =>
  new UnavailableError(IDP_UNAVAILABLE_MESSAGE, 'IDP_UNAVAILABLE');

/** Maps an RPC failure to an AppError. The binding sends its code as the message prefix; its text never reaches users. */
export function mapIdpError(error: unknown, log?: Logger): AppError {
  if (error instanceof AppError) return error;
  const code = CODE.exec(error instanceof Error ? error.message : '')?.[1];
  switch (code) {
    case 'IDP_BUDGET':
      return new AppError(
        'IDP_BUDGET',
        429,
        'Too many Polaris ID setups today. Try again tomorrow.',
        { headers: { 'retry-after': '3600' } },
      );
    case 'IDP_REFUSED':
      return new ForbiddenError(
        "This Polaris ID can't take developer access here. Ask the PassBook owner.",
        'IDP_REFUSED',
      );
    case 'IDP_NOT_FOUND':
    case 'IDP_CONFLICT':
      return new ConflictError('Polaris ID changed. Try again.', 'IDP_CONFLICT');
    case 'IDP_FROZEN':
      return new UnavailableError(
        'Polaris ID changes are paused. Ask the PassBook owner.',
        'IDP_FROZEN',
      );
    case 'IDP_NOT_MANAGED':
      return new ConflictError(
        "PassBook doesn't manage this Polaris ID account.",
        'IDP_NOT_MANAGED',
      );
    case 'IDP_BREAKER':
      log?.error('idp.breaker', { code: 'IDP_BREAKER' });
      return unavailable();
    // IDP_AUTH, IDP_UPSTREAM, IDP_UNSAFE_CONFIG, IDP_MISCONFIGURED, IDP_DRIFT and anything unknown.
    default:
      return unavailable();
  }
}
