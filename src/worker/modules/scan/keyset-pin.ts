import type { ServiceContext } from '../../platform/service-context.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';

const pins = new WeakMap<ServiceContext, Promise<string>>();

/**
 * The credential-ref keyset commitment, read once per request. The row is an immutable singleton,
 * so after the pin no statement of the request re-reads or binds the commitment. Throws
 * `CREDENTIAL_REF_KEYSET_UNAVAILABLE` (503) when the stored keyset is not this deployment's. Keyed
 * on the context object, never per isolate: tests swap keysets. A failed pin is not cached.
 */
export function pinKeyset(ctx: ServiceContext): Promise<string> {
  let pin = pins.get(ctx);
  if (!pin) {
    pin = requireCredentialRefKeyset(ctx.env.DB, ctx.env);
    pins.set(ctx, pin);
    pin.catch(() => pins.delete(ctx));
  }
  return pin;
}
