import { connectors } from '../../connectors/registry.ts';
import type { UpstreamRecord } from '../../connectors/types.ts';
import { credentialAad, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ConnectionReleaseSnapshot } from './records.ts';
import type { ConnectionRow } from './repo.ts';
import type { InboxItem } from './repo-pass-inbox.ts';
import type { RetainedMode, RetainedRow, WebhookReferenceMode } from './repo-webhook-retention.ts';
import { chunkHash, type WebhookPayload } from './webhook-payload.ts';

export function referenceMode(conn: ConnectionRow): Exclude<WebhookReferenceMode, 'unknown'> {
  const definition = connectors.get(conn.connectorType);
  const mode = definition?.webhookReferenceMode;
  if (!definition?.verifyWebhook || (mode !== 'embedded-required' && mode !== 'refs-only')) {
    throw new UnavailableError('Webhook configuration is unavailable.', 'WEBHOOK_REFERENCE_MODE');
  }
  return mode;
}

export async function encryptedRow(
  sctx: ServiceContext,
  p: {
    connectionId: string;
    orgId: string;
    eventId: string;
    generation: number;
    connectionMode: RetainedMode;
    referenceMode?: WebhookReferenceMode;
    source: RetainedRow['source'];
    payload: WebhookPayload;
    release: ConnectionReleaseSnapshot;
    snapshotKnown: boolean;
    failure?: string;
    chunkCount?: number;
  },
): Promise<RetainedRow> {
  const id = sctx.ids.id();
  const now = sctx.clock.now();
  const errorCode = p.failure ?? (p.source === 'ingress' ? 'WEBHOOK_DISPATCH_PENDING' : null);
  const state = p.failure ? 'failed' : 'pending';
  return {
    id,
    connectionId: p.connectionId,
    orgId: p.orgId,
    eventId: p.eventId,
    generation: p.generation,
    source: p.source,
    connectionMode: p.connectionMode,
    referenceMode: p.referenceMode ?? 'unknown',
    refHash: await chunkHash(p.payload.chunk, p.payload.refs),
    state,
    errorCode,
    releaseSnapshot: JSON.stringify(p.release),
    snapshotKnown: p.snapshotKnown,
    revision: 0,
    itemCount: p.payload.refs.length,
    chunkCount: p.chunkCount ?? 1,
    replayGeneration: 0,
    credentialKeysetCommitment: p.payload.credentialKeysetCommitment,
    envelope: await encryptSecret(
      await loadKekRing(sctx.env),
      JSON.stringify(p.payload),
      credentialAad(id, p.orgId, 'connection.webhook'),
    ),
    receivedAt: now,
    updatedAt: now,
  };
}

export function itemsFor(
  refs: string[],
  records?: Record<string, UpstreamRecord>,
  deleted?: string[],
): InboxItem[] {
  return refs.map((ref) => ({
    ref,
    record: records?.[ref] ?? null,
    deleted: deleted?.includes(ref) ?? false,
  }));
}
