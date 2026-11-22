import type { GoogleType } from '../../../passkit/wallets/google/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { snapshotWalletCredentialContext } from './account-service.ts';
import {
  addGoogleObjectMessage,
  findGoogleObjectMessage,
  type GoogleAddMessage,
} from './google-rest-typed.ts';
import type { WalletRuntimeScope } from './runtime-core.ts';
import { type GoogleRuntimeObjectIdentity, objectScope, withGoogleRest } from './runtime-google.ts';
import type { WalletRuntimeResponseSink } from './runtime-response.ts';

interface GoogleRuntimeMessageInput extends GoogleRuntimeObjectIdentity {
  type: GoogleType;
  onProviderResponse: WalletRuntimeResponseSink;
}

/** The one runtime entry that sends a change message: object `addMessage`, never a class or a PATCH body. */
export async function addGoogleRuntimeMessage(
  ctx: ServiceContext,
  scope: WalletRuntimeScope,
  input: GoogleRuntimeMessageInput & { message: GoogleAddMessage },
): Promise<void> {
  ctx = snapshotWalletCredentialContext(ctx);
  await withGoogleRest(
    ctx,
    scope,
    input.assertCurrent,
    'google-message',
    input.onProviderResponse,
    (rest, s) => addGoogleObjectMessage(rest, input.type, objectScope(s, input), input.message),
  );
}

/** One GET of the object to settle a message whose transport was ambiguous. */
export async function findGoogleRuntimeMessage(
  ctx: ServiceContext,
  scope: WalletRuntimeScope,
  input: GoogleRuntimeMessageInput & { messageId: string },
): Promise<GoogleAddMessage['messageType'] | null> {
  ctx = snapshotWalletCredentialContext(ctx);
  return withGoogleRest(
    ctx,
    scope,
    input.assertCurrent,
    'google-object',
    input.onProviderResponse,
    (rest, s) => findGoogleObjectMessage(rest, input.type, objectScope(s, input), input.messageId),
  );
}
