import type { Envelope } from '../../platform/crypto.ts';
import { all, first } from '../../platform/db.ts';
import { RETENTION_COLUMNS } from './repo-webhook-retention-stage.ts';

export {
  completeDispatch,
  hasStagedEvent,
  hasUncertainDispatch,
  parkStalledReplay,
  reopenEnqueueFailed,
  stalledReplays,
  undispatchedEvents,
} from './repo-webhook-retention-dispatch.ts';
export {
  insertRetainedLegacy,
  insertStagedWebhook,
  RETENTION_INSERT_COLUMNS,
  retentionInsertValues,
} from './repo-webhook-retention-stage.ts';
export {
  failPendingEvent,
  markRetainedDeadLetter,
  setRetainedState,
} from './repo-webhook-retention-state.ts';

export type RetentionState = 'pending' | 'failed' | 'blocked' | 'resolved' | 'ignored';
export type RetainedMode = 'webhook' | 'hybrid' | 'unknown';
export type WebhookReferenceMode = 'embedded-required' | 'refs-only' | 'unknown';

export interface RetainedRow {
  id: string;
  connectionId: string;
  orgId: string;
  eventId: string;
  generation: number;
  source: 'ingress' | 'legacy' | 'legacy_duplicate_unproven' | 'legacy_cleanup_unproven';
  connectionMode: RetainedMode;
  referenceMode: WebhookReferenceMode;
  refHash: string;
  state: RetentionState;
  errorCode: string | null;
  releaseSnapshot: string;
  snapshotKnown: boolean;
  revision: number;
  itemCount: number;
  chunkCount: number;
  replayGeneration: number;
  credentialKeysetCommitment: string | null;
  envelope: Envelope;
  receivedAt: number;
  updatedAt: number;
}

type RawRow = {
  id: string;
  connection_id: string;
  org_id: string;
  event_id: string;
  generation: number;
  source: RetainedRow['source'];
  connection_mode: RetainedMode;
  reference_mode: WebhookReferenceMode;
  ref_hash: string;
  state: RetentionState;
  error_code: string | null;
  release_snapshot: string;
  snapshot_known: number;
  revision: number;
  item_count: number;
  chunk_count: number;
  replay_generation: number;
  kek_version: number;
  iv: unknown;
  wrapped_dek: unknown;
  ciphertext: unknown;
  received_at: number;
  updated_at: number;
  credential_keyset_commitment: string | null;
};

function bytes(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return Uint8Array.from(value as number[]);
}

function fromRow(r: RawRow): RetainedRow {
  return {
    id: r.id,
    connectionId: r.connection_id,
    orgId: r.org_id,
    eventId: r.event_id,
    generation: r.generation,
    source: r.source,
    connectionMode: r.connection_mode,
    referenceMode: r.reference_mode,
    refHash: r.ref_hash,
    state: r.state,
    errorCode: r.error_code,
    releaseSnapshot: r.release_snapshot,
    snapshotKnown: r.snapshot_known === 1,
    revision: r.revision,
    itemCount: r.item_count,
    chunkCount: r.chunk_count,
    replayGeneration: r.replay_generation,
    credentialKeysetCommitment: r.credential_keyset_commitment,
    envelope: {
      kekVersion: r.kek_version,
      iv: bytes(r.iv),
      wrappedDek: bytes(r.wrapped_dek),
      ciphertext: bytes(r.ciphertext),
    },
    receivedAt: r.received_at,
    updatedAt: r.updated_at,
  };
}

export async function retainedByChunk(
  db: D1Database,
  connectionId: string,
  eventId: string,
  refHash: string,
): Promise<RetainedRow | null> {
  const row = await first<RawRow>(
    db,
    `SELECT ${RETENTION_COLUMNS} FROM connection_webhook_retention
    WHERE connection_id = ? AND event_id = ? AND ref_hash = ?`,
    [connectionId, eventId, refHash],
  );
  return row ? fromRow(row) : null;
}

/** Every ingress chunk of one event, in staging order. */
export async function retainedIngressChunks(
  db: D1Database,
  connectionId: string,
  eventId: string,
): Promise<RetainedRow[]> {
  const rows = await all<RawRow>(
    db,
    `SELECT ${RETENTION_COLUMNS} FROM connection_webhook_retention
    WHERE connection_id = ? AND event_id = ? AND source = 'ingress' ORDER BY id`,
    [connectionId, eventId],
  );
  return rows.map(fromRow);
}

export async function retainedById(
  db: D1Database,
  connectionId: string,
  id: string,
): Promise<RetainedRow | null> {
  const row = await first<RawRow>(
    db,
    `SELECT ${RETENTION_COLUMNS} FROM connection_webhook_retention
    WHERE connection_id = ? AND id = ?`,
    [connectionId, id],
  );
  return row ? fromRow(row) : null;
}

export async function listRetained(db: D1Database, connectionId: string) {
  const rows = await all<{
    id: string;
    connection_id: string;
    event_id: string;
    generation: number;
    connection_mode: RetainedMode;
    state: RetentionState;
    error_code: string | null;
    uncertain_items: number;
    received_at: number;
    updated_at: number;
  }>(
    db,
    `SELECT r.id, r.connection_id, r.event_id, r.generation, r.connection_mode, r.state,
      COALESCE((SELECT i.error_code FROM connection_webhook_items i WHERE i.retention_id = r.id
        AND i.state = 'blocked' AND i.error_code IS NOT NULL ORDER BY i.ordinal LIMIT 1), r.error_code) AS error_code,
      (SELECT COUNT(*) FROM connection_webhook_items i WHERE i.retention_id = r.id
        AND i.state = 'uncertain') AS uncertain_items,
      r.received_at, r.updated_at FROM connection_webhook_retention r
    WHERE r.connection_id = ? AND r.state IN ('pending', 'failed', 'blocked', 'ignored') ORDER BY r.received_at DESC, r.id DESC`,
    [connectionId],
  );
  return rows.map((r) => ({
    id: r.id,
    connectionId: r.connection_id,
    eventId: r.event_id,
    generation: r.generation,
    connectionMode: r.connection_mode,
    state: r.state,
    errorCode: r.error_code,
    uncertainItems: r.uncertain_items,
    receivedAt: r.received_at,
    updatedAt: r.updated_at,
  }));
}
