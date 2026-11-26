import type { GoogleType } from '../../../passkit/wallets/google/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { snapshotWalletCredentialContext } from './account-service.ts';
import { googleObjectHasUsers } from './google-rest-typed.ts';
import type { WalletRuntimeScope } from './runtime-core.ts';
import { type GoogleRuntimeObjectIdentity, objectScope, withGoogleRest } from './runtime-google.ts';

/** One GET of the object: whether Google reports users on it. The response is read for that answer only. */
export async function googleRuntimeHasUsers(
  ctx: ServiceContext,
  scope: WalletRuntimeScope,
  input: GoogleRuntimeObjectIdentity & { type?: GoogleType },
): Promise<boolean> {
  ctx = snapshotWalletCredentialContext(ctx);
  return withGoogleRest(ctx, scope, input.assertCurrent, 'google-object', null, (rest, s) =>
    googleObjectHasUsers(rest, input.type ?? 'generic', objectScope(s, input)),
  );
}
