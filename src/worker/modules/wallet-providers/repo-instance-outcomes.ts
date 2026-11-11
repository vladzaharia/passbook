import type { Envelope } from '../../platform/crypto.ts';
import { first, run } from '../../platform/db.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import type {
  WalletCredentialKeysetProof,
  WalletOperationRef,
  WalletReasonCode,
} from './instance-types.ts';
import { isCredentialKeysetCommitment } from './instance-types.ts';

export type OutcomeReceipt = 'recorded' | 'replay' | 'conflict' | 'stale';

/** Retains untrusted encrypted response bytes; never changes operation or installation state. */
export async function insertOutcome(
  db: D1Database,
  p: WalletOperationRef &
    WalletCredentialKeysetProof & {
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
      now: number;
    },
): Promise<OutcomeReceipt> {
  p = { ...p };
  if (!isCredentialKeysetCommitment(p.credentialKeysetCommitment)) return 'stale';
  const result = await run(
    db,
    `INSERT OR IGNORE INTO wallet_provider_instance_outcomes
      (id, operation_id, attempt, sequence, event_hash, payload_hash, reason_code, http_status,
       kek_version, iv, wrapped_dek, ciphertext, received_at)
    SELECT ?, op.id, op.attempts, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    FROM wallet_provider_instance_operations op JOIN wallet_provider_instances i ON i.id = op.instance_id
    WHERE i.id = ? AND i.org_id = ? AND i.mode = ? AND i.provider = ? AND op.id = ?
      AND op.version = ? AND op.attempts = ? AND op.claim_hash = ? AND op.state IN ('claimed', 'uncertain')
      AND op.credential_keyset_commitment = ? AND i.credential_keyset_commitment = ? AND ${credentialRefKeysetSql}`,
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
      p.instanceId,
      p.orgId,
      p.mode,
      p.provider,
      p.operationId,
      p.version,
      p.attempt,
      p.claimHash,
      p.credentialKeysetCommitment,
      p.credentialKeysetCommitment,
      p.credentialKeysetCommitment,
    ],
  );
  if (result.changes === 1) return 'recorded';
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
       AND op.credential_keyset_commitment = ? AND i.credential_keyset_commitment = ? AND ${credentialRefKeysetSql}`,
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
      p.credentialKeysetCommitment,
      p.credentialKeysetCommitment,
      p.credentialKeysetCommitment,
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
