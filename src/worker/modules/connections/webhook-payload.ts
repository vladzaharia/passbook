import { credentialAad, decryptSecretText, loadKekRing } from '../../platform/crypto.ts';
import { UnavailableError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  captureCredentialKeyEnv,
  requireCredentialRefKeyset,
} from '../passes/credential-keyset.ts';
import { legacyCleanupHash, legacyDuplicateHash } from './legacy-duplicate-key.ts';
import type { InboxItem } from './repo-pass-inbox.ts';
import type { RetainedRow } from './repo-webhook-retention.ts';

export interface WebhookPayload {
  refs: string[];
  items: InboxItem[];
  rawBody: string | null;
  /** Older serialized payloads may lack this until explicitly admitted as legacy work. */
  credentialKeysetCommitment: string | null;
  legacySourceId?: string;
  /** Position of this chunk in its event. Absent means 0. */
  chunk?: number;
}

/** The ordinal is part of the identity, so identical ref lists in one event stay distinct chunks. */
export const chunkHash = (chunk: number | undefined, refs: string[]): Promise<string> =>
  sha256Hex(JSON.stringify([chunk ?? 0, refs]));

/** Never include decrypted contents in an exception, even when stored JSON is corrupt. */
export async function decryptRetainedPayload(
  sctx: ServiceContext,
  row: RetainedRow,
): Promise<WebhookPayload> {
  const env = captureCredentialKeyEnv(sctx.env);
  if (row.source === 'legacy_duplicate_unproven' || row.source === 'legacy_cleanup_unproven') {
    await requireCredentialRefKeyset(sctx.env.DB, env);
  }
  let payload: WebhookPayload;
  try {
    const text = await decryptSecretText(
      await loadKekRing(env),
      row.envelope,
      credentialAad(row.id, row.orgId, 'connection.webhook'),
    );
    payload = JSON.parse(text) as WebhookPayload;
  } catch {
    throw new UnavailableError('The webhook payload is unavailable.', 'WEBHOOK_PAYLOAD_MISSING');
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray(payload.refs) ||
    !Array.isArray(payload.items) ||
    payload.refs.length !== payload.items.length ||
    payload.refs.length !== row.itemCount ||
    payload.items.some((item, index) => item.ref !== payload.refs[index])
  ) {
    throw new UnavailableError('The webhook payload is unavailable.', 'WEBHOOK_PAYLOAD_MISSING');
  }
  const proof = payload.credentialKeysetCommitment ?? null;
  if (
    (proof !== null && (typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof))) ||
    (row.source === 'ingress' && (proof === null || proof !== row.credentialKeysetCommitment)) ||
    (row.source !== 'ingress' &&
      proof !== row.credentialKeysetCommitment &&
      !(proof === null && row.source === 'legacy' && row.referenceMode === 'refs-only'))
  ) {
    throw new UnavailableError('The webhook payload is unavailable.', 'WEBHOOK_PAYLOAD_MISSING');
  }
  const identity =
    row.source === 'legacy_duplicate_unproven'
      ? typeof payload.rawBody === 'string'
        ? await legacyDuplicateHash(sctx, row.connectionId, row.eventId, payload.rawBody, env)
        : null
      : row.source === 'legacy_cleanup_unproven'
        ? payload.legacySourceId === undefined ||
          (typeof payload.legacySourceId === 'string' && payload.legacySourceId.length > 0)
          ? await legacyCleanupHash(
              sctx,
              row.connectionId,
              row.eventId,
              payload.legacySourceId,
              env,
            )
          : null
        : await chunkHash(payload.chunk, payload.refs);
  if (identity !== row.refHash) {
    throw new UnavailableError('The webhook payload is unavailable.', 'WEBHOOK_PAYLOAD_MISSING');
  }
  return payload;
}
