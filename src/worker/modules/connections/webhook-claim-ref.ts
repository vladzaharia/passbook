import { derivedHmacKey } from '../../platform/crypto.ts';
import { toHex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  captureCredentialKeyEnv,
  requireCredentialRefKeyset,
} from '../passes/credential-keyset.ts';

/** Commit to the exact tenant/connection/reference without storing the upstream ref in plaintext. */
export async function retainedWebhookRefHash(
  sctx: ServiceContext,
  orgId: string,
  connectionId: string,
  externalRef: string,
): Promise<{ refHash: string; credentialKeysetCommitment: string }> {
  const env = captureCredentialKeyEnv(sctx.env);
  const credentialKeysetCommitment = await requireCredentialRefKeyset(sctx.env.DB, env);
  const key = await derivedHmacKey(env, 'connection.webhook.item-ref.v1');
  const value = new TextEncoder().encode(JSON.stringify([orgId, connectionId, externalRef]));
  const refHash = toHex(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, value as BufferSource)),
  );
  return { refHash, credentialKeysetCommitment };
}
