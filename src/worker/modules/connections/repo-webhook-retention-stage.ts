import { rawCheck } from '../../platform/authority-checks.ts';
import type { SqlValue } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { commitOrNull, connectionGrant, connectionIs, plainWrite } from './repo-grants.ts';
import type { RetainedRow } from './repo-webhook-retention.ts';

export const RETENTION_COLUMNS = `id, connection_id, org_id, event_id, generation, source, connection_mode, reference_mode,
  ref_hash, state, error_code, release_snapshot, snapshot_known, revision, item_count, chunk_count, replay_generation, kek_version, iv, wrapped_dek,
  ciphertext, received_at, updated_at, credential_keyset_commitment`;

function retentionValues(row: RetainedRow) {
  return [
    row.id,
    row.connectionId,
    row.orgId,
    row.eventId,
    row.generation,
    row.source,
    row.connectionMode,
    row.referenceMode,
    row.refHash,
    row.state,
    row.errorCode,
    row.releaseSnapshot,
    row.snapshotKnown ? 1 : 0,
    row.revision,
    row.itemCount,
    row.chunkCount,
    row.replayGeneration,
    row.envelope.kekVersion,
    row.envelope.iv,
    row.envelope.wrappedDek,
    row.envelope.ciphertext,
    row.receivedAt,
    row.updatedAt,
    row.credentialKeysetCommitment,
  ] as const;
}

/** The retention columns an insert names; `org_id` comes from the grant. */
export const RETENTION_INSERT_COLUMNS = RETENTION_COLUMNS.split(',')
  .map((c) => c.trim())
  .filter((c) => c !== 'org_id');

export function retentionInsertValues(row: RetainedRow): SqlValue[] {
  const [id, connectionId, , ...rest] = retentionValues(row);
  return [id, connectionId, ...rest] as SqlValue[];
}

const ordinalsOf = (row: RetainedRow) => Array.from({ length: row.itemCount }, (_, i) => i);

/** Event dedupe and every encrypted chunk commit together or not at all. */
export async function insertStagedWebhook(
  ctx: ServiceContext,
  rows: RetainedRow[],
): Promise<boolean> {
  const row = rows[0];
  if (!row) throw new Error('Webhook must contain a chunk');
  const proof = row.credentialKeysetCommitment;
  if (
    typeof proof !== 'string' ||
    !/^[0-9a-f]{64}$/.test(proof) ||
    row.source !== 'ingress' ||
    rows.length !== row.chunkCount ||
    rows.some(
      (item) =>
        item.source !== 'ingress' ||
        item.orgId !== row.orgId ||
        item.connectionId !== row.connectionId ||
        item.eventId !== row.eventId ||
        item.generation !== row.generation ||
        item.connectionMode !== row.connectionMode ||
        item.referenceMode !== row.referenceMode ||
        item.releaseSnapshot !== row.releaseSnapshot ||
        item.chunkCount !== row.chunkCount ||
        item.credentialKeysetCommitment !== proof,
    )
  )
    return false;
  const actor = { orgId: row.orgId };
  const g = connectionGrant(
    ctx,
    actor,
    'webhook.stage',
    [
      connectionIs({
        id: row.connectionId,
        generation: row.generation,
        syncMode: row.connectionMode,
        enabled: true,
      }),
    ],
    row.eventId,
  );
  // A duplicate event id fails the whole batch with a unique violation, as the caller expects.
  plainWrite(
    g,
    'INSERT INTO webhook_events (connection_id, event_id, received_at) SELECT ?, ?, ? WHERE {grant}',
    [row.connectionId, row.eventId, row.receivedAt],
  );
  for (const item of rows) {
    g.insertSelect(
      'connection_webhook_retention',
      RETENTION_INSERT_COLUMNS,
      retentionInsertValues(item),
    );
    for (const ordinal of ordinalsOf(item))
      g.insertJoined('connection_webhook_items', {
        parents: { retention_id: item.id },
        columns: ['ordinal', 'state', 'prior_unknown', 'release_snapshot'],
        values: [ordinal, 'pending', 0, item.releaseSnapshot],
      });
  }
  return (await commitOrNull(g, actor)) !== null;
}

/**
 * A pre-cutover chunk is kept for review only and never runs, so its items are terminal and must
 * not fence the organization's holder transfers (claim_prior_unbound stays 0). prior_unknown = 1
 * keeps them out of replay.
 */
export async function insertRetainedLegacy(
  ctx: ServiceContext,
  row: RetainedRow,
  guardConnection: boolean,
  credentialKeysetCommitment: string | null,
): Promise<boolean> {
  if (
    credentialKeysetCommitment === null
      ? row.source !== 'legacy' || row.credentialKeysetCommitment !== null
      : !/^[0-9a-f]{64}$/.test(credentialKeysetCommitment) ||
        row.credentialKeysetCommitment !== credentialKeysetCommitment
  )
    return false;
  const actor = { orgId: row.orgId };
  const g = connectionGrant(
    ctx,
    actor,
    'webhook.stage_legacy',
    [
      // INSERT OR IGNORE before: an existing chunk is not written again.
      rawCheck(
        'retention',
        'NOT EXISTS (SELECT 1 FROM connection_webhook_retention WHERE id = ? OR (connection_id = ? AND event_id = ? AND ref_hash = ?))',
        [row.id, row.connectionId, row.eventId, row.refHash],
      ),
      ...(guardConnection
        ? [
            connectionIs({
              id: row.connectionId,
              generation: row.generation,
              syncMode: row.connectionMode,
              enabled: true,
            }),
            rawCheck(
              'retention',
              'EXISTS (SELECT 1 FROM webhook_events WHERE connection_id = ? AND event_id = ?)',
              [row.connectionId, row.eventId],
            ),
          ]
        : []),
    ],
    row.id,
  );
  g.insertSelect(
    'connection_webhook_retention',
    RETENTION_INSERT_COLUMNS,
    retentionInsertValues(row),
  );
  for (const ordinal of ordinalsOf(row))
    g.insertJoined('connection_webhook_items', {
      parents: { retention_id: row.id },
      columns: ['ordinal', 'state', 'error_code', 'prior_unknown', 'release_snapshot'],
      values: [ordinal, 'failed', 'WEBHOOK_LEGACY_UNCERTAIN', 1, row.releaseSnapshot],
    });
  return (await commitOrNull(g, actor)) !== null;
}
