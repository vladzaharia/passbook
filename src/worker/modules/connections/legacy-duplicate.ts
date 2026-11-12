import type { UpstreamRecord } from '../../connectors/types.ts';
import { credentialAad, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { UnavailableError } from '../../platform/errors.ts';
import { toBase64 } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  captureCredentialKeyEnv,
  requireCredentialRefKeyset,
} from '../passes/credential-keyset.ts';
import { legacyDuplicateHash } from './legacy-duplicate-key.ts';
import { sealLegacyWebhookInbox } from './legacy-inbox.ts';
import { type ConnectionRow, getConnection } from './repo.ts';
import {
  insertRetainedLegacy,
  type RetainedRow,
  retainedByChunk,
  type WebhookReferenceMode,
} from './repo-webhook-retention.ts';

/** Keep a re-delivery distinct from the unproven original legacy event and its old jobs. */
export async function retainLegacyDuplicate(
  sctx: ServiceContext,
  conn: ConnectionRow,
  verified: {
    eventId: string;
    refs: string[];
    records?: Record<string, UpstreamRecord>;
    deleted?: string[];
  },
  rawBody: Uint8Array,
  referenceMode: Exclude<WebhookReferenceMode, 'unknown'>,
  credentialKeysetCommitment: string,
): Promise<void> {
  const env = captureCredentialKeyEnv(sctx.env);
  const body = toBase64(rawBody);
  if (
    !/^[0-9a-f]{64}$/.test(credentialKeysetCommitment) ||
    (await requireCredentialRefKeyset(sctx.env.DB, env)) !== credentialKeysetCommitment
  ) {
    throw new UnavailableError(
      'Credential references are unavailable.',
      'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    );
  }
  if (conn.mode !== 'webhook' && conn.mode !== 'hybrid') {
    throw new UnavailableError('The connection changed. Retry the webhook.', 'WEBHOOK_UNAVAILABLE');
  }
  await sealLegacyWebhookInbox(sctx, conn.id, conn.orgId, verified.eventId, {
    env,
    commitment: credentialKeysetCommitment,
  });
  const refHash = await legacyDuplicateHash(sctx, conn.id, verified.eventId, body, env);
  const id = sctx.ids.id();
  const now = sctx.clock.now();
  const payload = {
    refs: verified.refs,
    items: verified.refs.map((ref) => ({
      ref,
      record: verified.records?.[ref] ?? null,
      deleted: verified.deleted?.includes(ref) ?? false,
    })),
    rawBody: body,
    credentialKeysetCommitment,
  };
  const row: RetainedRow = {
    id,
    connectionId: conn.id,
    orgId: conn.orgId,
    eventId: verified.eventId,
    generation: conn.generation,
    source: 'legacy_duplicate_unproven',
    connectionMode: conn.mode,
    referenceMode,
    refHash,
    state: 'failed',
    errorCode: 'WEBHOOK_LEGACY_UNCERTAIN',
    releaseSnapshot: 'null',
    snapshotKnown: false,
    revision: 0,
    itemCount: verified.refs.length,
    chunkCount: 1,
    replayGeneration: 0,
    credentialKeysetCommitment,
    envelope: await encryptSecret(
      await loadKekRing(env),
      JSON.stringify(payload),
      credentialAad(id, conn.orgId, 'connection.webhook'),
    ),
    receivedAt: now,
    updatedAt: now,
  };
  if (!(await insertRetainedLegacy(sctx, row, true, credentialKeysetCommitment))) {
    if ((await requireCredentialRefKeyset(sctx.env.DB, env)) !== credentialKeysetCommitment) {
      throw new UnavailableError(
        'Credential references are unavailable.',
        'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
      );
    }
    const existing = await retainedByChunk(sctx.env.DB, conn.id, verified.eventId, refHash);
    const current = await getConnection(sctx.env.DB, conn.id);
    if (
      existing?.source !== 'legacy_duplicate_unproven' ||
      existing.orgId !== conn.orgId ||
      existing.generation !== conn.generation ||
      (existing.credentialKeysetCommitment !== null &&
        existing.credentialKeysetCommitment !== credentialKeysetCommitment) ||
      !current?.enabled ||
      current.orgId !== conn.orgId ||
      current.generation !== conn.generation ||
      current.mode !== conn.mode
    ) {
      throw new UnavailableError('Could not retain the webhook.', 'WEBHOOK_RETENTION_FAILED');
    }
  }
}
