import { writePart } from '../../platform/authority-include.ts';
import type { Envelope } from '../../platform/crypto.ts';
import { first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { WalletOperationRef, WalletReasonCode } from './instance-types.ts';
import { instanceCheck } from './repo-instance-current.ts';
import { pinnedKeysetSql } from './repo-keyset-pin.ts';
import { commitWalletGrant, walletQueueGrant } from './repo-queue-grant.ts';

export type OutcomeReceipt = 'recorded' | 'replay' | 'conflict' | 'stale';

/**
 * Retains untrusted encrypted response bytes; never changes operation or installation state. A response is recorded
 * whatever the org's state and however stale the operation is: lineage only.
 */
export async function insertOutcome(
  ctx: ServiceContext,
  p: WalletOperationRef & {
    claimHash: string;
    operationId: string;
    attempt: number;
    sequence: number;
    eventHash: string;
    payloadHash: string;
    id: string;
    envelope: Envelope;
    reason: WalletReasonCode;
    httpStatus: number | null;
    /** What the response answered, when the caller knows (a Google revoke's confirmation needs a GET). */
    method?: string;
    stage?: string;
    now: number;
  },
): Promise<OutcomeReceipt> {
  p = { ...p };
  const db = ctx.env.DB;
  const g = walletQueueGrant(ctx, 'record', p, [instanceCheck(p.instanceId)]);
  g.include(
    writePart(
      `INSERT OR IGNORE INTO wallet_provider_instance_outcomes
      (id, operation_id, attempt, sequence, event_hash, payload_hash, reason_code, http_status,
       kek_version, iv, wrapped_dek, ciphertext, received_at, method, stage)
    SELECT ?, op.id, op.attempts, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    FROM wallet_provider_instance_operations op JOIN wallet_provider_instances i ON i.id = op.instance_id
    WHERE i.id = ? AND i.org_id = {org} AND i.mode = {mode} AND i.provider = ? AND op.id = ?
      AND op.version = ? AND op.attempts = ? AND op.claim_hash = ? AND op.state IN ('claimed', 'uncertain')
      AND op.credential_keyset_commitment = ${pinnedKeysetSql} AND i.credential_keyset_commitment = ${pinnedKeysetSql}
      AND {grant}
    RETURNING id`,
      [
        p.id,
        p.sequence,
        p.eventHash,
        p.payloadHash,
        p.reason,
        p.httpStatus,
        p.envelope.kekVersion,
        p.envelope.iv,
        p.envelope.wrappedDek,
        p.envelope.ciphertext,
        p.now,
        p.method ?? null,
        p.stage ?? null,
        p.instanceId,
        p.provider,
        p.operationId,
        p.version,
        p.attempt,
        p.claimHash,
      ],
    ),
  );
  const committed = await commitWalletGrant(g);
  const inserted = 'results' in committed && (committed.results[0]?.results.length ?? 0) === 1;
  if (inserted) return 'recorded';
  const previous = await first<{
    sequence: number;
    event_hash: string;
    payload_hash: string;
    reason_code: string | null;
    http_status: number | null;
  }>(
    db,
    `SELECT outcome.sequence, outcome.event_hash, outcome.payload_hash, outcome.reason_code, outcome.http_status
     FROM wallet_provider_instance_outcomes outcome
     JOIN wallet_provider_instance_operations op ON op.id = outcome.operation_id
     JOIN wallet_provider_instances i ON i.id = op.instance_id
     WHERE i.id = ? AND i.org_id = ? AND i.mode = ? AND i.provider = ? AND op.id = ?
       AND op.version = ? AND op.attempts = ? AND op.claim_hash = ?
       AND outcome.attempt = ? AND (outcome.event_hash = ? OR outcome.sequence = ?)
       AND op.credential_keyset_commitment = ${pinnedKeysetSql} AND i.credential_keyset_commitment = ${pinnedKeysetSql}`,
    [
      p.instanceId,
      p.orgId,
      p.mode,
      p.provider,
      p.operationId,
      p.version,
      p.attempt,
      p.claimHash,
      p.attempt,
      p.eventHash,
      p.sequence,
    ],
  );
  if (!previous) return 'stale';
  return previous.sequence === p.sequence &&
    previous.event_hash === p.eventHash &&
    previous.payload_hash === p.payloadHash &&
    previous.reason_code === p.reason &&
    previous.http_status === p.httpStatus
    ? 'replay'
    : 'conflict';
}
