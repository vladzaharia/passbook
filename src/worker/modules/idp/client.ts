import { UnavailableError } from '../../platform/errors.ts';
import type { Logger } from '../../platform/log.ts';
import { IDP_UNAVAILABLE_MESSAGE, mapIdpError } from './errors.ts';
import type { IdpRpc } from './types.ts';

/** True when the binding exists. Before the binding is deployed it does not, and the feature stays hidden. */
export const idpConfigured = (env: { IDP?: unknown }): boolean => env.IDP !== undefined;

/** Typed wrapper over the `IDP` service binding. Every failure is an AppError; a missing binding is `IDP_UNAVAILABLE`. */
export function idpClient(env: { IDP?: unknown }, log?: Logger): IdpRpc {
  const rpc = env.IDP as IdpRpc | undefined;
  const call = async <T>(run: (r: IdpRpc) => Promise<T>): Promise<T> => {
    if (!rpc) throw new UnavailableError(IDP_UNAVAILABLE_MESSAGE, 'IDP_UNAVAILABLE');
    try {
      return await run(rpc);
    } catch (error) {
      throw mapIdpError(error, log);
    }
  };
  return {
    health: () => call((r) => r.health()),
    createSignup: (kind, ctx) => call((r) => r.createSignup(kind, ctx)),
    deleteSignup: (tokenId, ctx) => call((r) => r.deleteSignup(tokenId, ctx)),
    proveSignup: (tokenIds, subject) => call((r) => r.proveSignup(tokenIds, subject)),
    findByVerifiedEmail: (email, ctx) => call((r) => r.findByVerifiedEmail(email, ctx)),
    lookup: (subject) => call((r) => r.lookup(subject)),
    apply: (subject, delta, ctx) => call((r) => r.apply(subject, delta, ctx)),
    setDisabled: (subject, disabled, ctx) => call((r) => r.setDisabled(subject, disabled, ctx)),
    snapshot: (ctx) => call((r) => r.snapshot(ctx)),
    freeze: (reason, ctx) => call((r) => r.freeze(reason, ctx)),
    calls: (since) => call((r) => r.calls(since)),
  };
}
