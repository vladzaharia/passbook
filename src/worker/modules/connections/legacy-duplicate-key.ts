import { derivedHmacKey } from '../../platform/crypto.ts';
import { toHex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { captureCredentialKeyEnv } from '../passes/credential-keyset.ts';

/** Keyed identity is deliberately disjoint from queue chunk identities. */
export async function legacyDuplicateHash(
  sctx: ServiceContext,
  connectionId: string,
  eventId: string,
  rawBody: string,
  keyEnv: Readonly<Record<string, string>> = captureCredentialKeyEnv(sctx.env),
): Promise<string> {
  const key = await derivedHmacKey(keyEnv, 'connection.webhook.legacy-duplicate.v1');
  const bytes = new TextEncoder().encode(JSON.stringify([connectionId, eventId, rawBody]));
  const digest = await crypto.subtle.sign('HMAC', key, bytes as BufferSource);
  return `legacy-duplicate:${toHex(new Uint8Array(digest))}`;
}

export async function legacyCleanupHash(
  sctx: ServiceContext,
  connectionId: string,
  eventId: string,
  sourceId?: string,
  keyEnv: Readonly<Record<string, string>> = captureCredentialKeyEnv(sctx.env),
): Promise<string> {
  const key = await derivedHmacKey(keyEnv, 'connection.webhook.legacy-cleanup.v1');
  const identity =
    sourceId === undefined ? [connectionId, eventId] : [connectionId, eventId, sourceId];
  const bytes = new TextEncoder().encode(JSON.stringify(identity));
  return `legacy-cleanup:${toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes as BufferSource)))}`;
}
