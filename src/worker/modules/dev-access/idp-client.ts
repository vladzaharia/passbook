import {
  AppError,
  ConflictError,
  ForbiddenError,
  UnavailableError,
} from '../../platform/errors.ts';
import type { IdpRpc } from './idp-types.ts';

const CODE = /^(IDP_[A-Z_]+): ?/;

const UNAVAILABLE = 'Polaris ID is not reachable. Try again in a few minutes.';

/** Maps an RPC failure to an AppError. The provisioner sends its code as the message prefix; its text never reaches users. */
export function mapIdpError(error: unknown): AppError {
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
    // IDP_AUTH, IDP_UPSTREAM, IDP_UNSAFE_CONFIG, IDP_MISCONFIGURED, IDP_DRIFT and anything unknown.
    default:
      return new UnavailableError(UNAVAILABLE, 'IDP_UNAVAILABLE');
  }
}

/** True when the binding exists. Before the provisioner is deployed it does not, and the feature stays hidden. */
export const idpConfigured = (env: { IDP?: unknown }): boolean => env.IDP !== undefined;

/** Typed wrapper over the `IDP` service binding. Every failure is an AppError; a missing binding is `IDP_UNAVAILABLE`. */
export function idpClient(env: { IDP?: unknown }): IdpRpc {
  const rpc = env.IDP as IdpRpc | undefined;
  const call = async <T>(run: (r: IdpRpc) => Promise<T>): Promise<T> => {
    if (!rpc) throw new UnavailableError(UNAVAILABLE, 'IDP_UNAVAILABLE');
    try {
      return await run(rpc);
    } catch (error) {
      throw mapIdpError(error);
    }
  };
  return {
    health: () => call((r) => r.health()),
    createSignup: (ref) => call((r) => r.createSignup(ref)),
    deleteSignup: (tokenId) => call((r) => r.deleteSignup(tokenId)),
    proveSignup: (tokenIds, subject) => call((r) => r.proveSignup(tokenIds, subject)),
    addDeveloper: (subject, ref) => call((r) => r.addDeveloper(subject, ref)),
    removeDeveloper: (subject, reason) => call((r) => r.removeDeveloper(subject, reason)),
    calls: (since) => call((r) => r.calls(since)),
  };
}
