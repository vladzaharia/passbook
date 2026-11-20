import type { Envelope } from '../../platform/crypto.ts';
import { batch, first, stmt } from '../../platform/db.ts';
import type { WalletOperationState, WalletProviderResult } from './instance-types.ts';
import {
  type Claim,
  CURRENT,
  CURRENT_OPERATION,
  RETRY_DELAY,
  SCOPE,
  scope,
} from './repo-instance-claim-sql.ts';
import { pinnedKeysetSql } from './repo-keyset-pin.ts';
import { SAMSUNG_UNCONFIRMED_SERVE_MS } from './samsung-limits.ts';

export async function finishOperation(
  db: D1Database,
  p: Claim & {
    operationId: string;
    attempt: number;
    result: WalletProviderResult;
    raw?: { id: string; eventHash: string; payloadHash: string; envelope: Envelope };
  },
): Promise<WalletOperationState | null> {
  p = { ...p };
  const success = p.result.kind !== 'failure';
  const retryable = p.result.kind === 'failure' && p.result.retryable;
  const reason =
    p.result.kind === 'success'
      ? 'ok'
      : p.result.kind === 'not_issued'
        ? 'not_issued'
        : p.result.reason;
  const retryMs = p.result.kind === 'failure' ? (p.result.retryAfterMs ?? 0) : 0;
  // Shared by the operation UPDATE and the outcome INSERT, which runs first so it sees the claimed row.
  const claimedWhere = `op.id = proven.id AND op.id = ? AND op.instance_id = ? AND op.version = ? AND op.attempts = ?
      AND op.claim_hash = ? AND op.state IN ('claimed', 'uncertain')
      AND NOT EXISTS (SELECT 1 FROM wallet_provider_sync_targets target
        WHERE target.operation_id = op.id AND target.state IN ('inflight', 'uncertain'))
      AND EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE ${SCOPE})
      ${
        p.result.kind === 'not_issued'
          ? `AND op.kind = 'revoke' AND EXISTS (
        SELECT 1 FROM wallet_provider_instances ni WHERE ni.id = op.instance_id AND ni.provider = 'samsung'
          AND NOT EXISTS (SELECT 1 FROM wallet_samsung_fetch_refs ref WHERE ref.instance_id = ni.id
            AND (ref.retired_at IS NULL OR ref.promoted_at IS NOT NULL OR ref.served_at > ? OR ref.initial_expires_at > ?)))`
          : ''
      }`;
  const claimedParams = [
    p.operationId,
    p.instanceId,
    p.version,
    p.attempt,
    p.hash,
    ...scope(p),
    ...(p.result.kind === 'not_issued' ? [p.now - SAMSUNG_UNCONFIRMED_SERVE_MS, p.now] : []),
  ];
  const statements: D1PreparedStatement[] = [];
  if (p.raw)
    statements.push(
      stmt(
        db,
        `WITH ${CURRENT_OPERATION}
      INSERT INTO wallet_provider_instance_outcomes
      (id, operation_id, attempt, sequence, event_hash, payload_hash, reason_code, http_status,
       kek_version, iv, wrapped_dek, ciphertext, received_at)
    SELECT ?, op.id, op.attempts, COALESCE((SELECT MAX(sequence) + 1 FROM wallet_provider_instance_outcomes
      WHERE operation_id = op.id AND attempt = op.attempts), 1), ?, ?, ?, ?, ?, ?, ?, ?, ?
    FROM wallet_provider_instance_operations op JOIN current_operation proven ON proven.id = op.id
    WHERE proven.is_current = 1 AND ${claimedWhere}
    RETURNING id`,
        [
          p.instanceId,
          p.version,
          ...scope(p),
          p.now,
          p.raw.id,
          p.raw.eventHash,
          p.raw.payloadHash,
          reason,
          p.result.httpStatus ?? null,
          p.raw.envelope.kekVersion,
          p.raw.envelope.iv,
          p.raw.envelope.wrappedDek,
          p.raw.envelope.ciphertext,
          p.now,
          ...claimedParams,
        ],
      ),
    );
  statements.push(
    stmt(
      db,
      `WITH ${CURRENT_OPERATION}
      UPDATE wallet_provider_instance_operations AS op SET
      state = CASE WHEN NOT proven.is_current THEN 'superseded'
        WHEN ? = 1 THEN 'succeeded' WHEN ? = 1 AND op.attempts < 8 THEN 'retry' ELSE 'failed' END,
      next_attempt_at = CASE WHEN proven.is_current AND ? = 0 AND ? = 1 AND op.attempts < 8
        THEN ? + ${RETRY_DELAY} ELSE NULL END,
      reason_code = CASE WHEN proven.is_current THEN ? ELSE NULL END,
      http_status = CASE WHEN proven.is_current THEN ? ELSE NULL END,
      last_result_at = ?, completed_at = CASE WHEN NOT proven.is_current OR ? = 1 OR ? = 0 OR op.attempts >= 8
        THEN ? ELSE NULL END
    FROM current_operation proven
    WHERE ${claimedWhere}
    RETURNING id`,
      [
        p.instanceId,
        p.version,
        ...scope(p),
        p.now,
        success,
        retryable,
        success,
        retryable,
        p.now,
        retryMs,
        reason,
        p.result.httpStatus ?? null,
        p.now,
        success,
        retryable,
        p.now,
        ...claimedParams,
      ],
    ),
  );
  if (success)
    statements.push(
      stmt(
        db,
        `UPDATE wallet_provider_instances AS i SET lifecycle = 'revoked',
      revoked_at = ?, retirement_next_attempt_at = 0, updated_at = ? WHERE i.id = ? AND i.org_id = ? AND i.mode = ? AND i.provider = ?
    AND i.credential_keyset_commitment = ${pinnedKeysetSql}
    AND EXISTS (SELECT 1 FROM wallet_provider_instance_operations op WHERE op.id = ? AND op.kind = 'revoke'
      AND op.credential_keyset_commitment = ${pinnedKeysetSql} AND op.state = 'succeeded'
      AND op.claim_hash = ? AND op.attempts = ? AND op.last_result_at = ? AND ${CURRENT})`,
        [p.now, p.now, ...scope(p), p.operationId, p.hash, p.attempt, p.now, p.now],
      ),
    );
  const results = await batch(db, statements);
  if (results[p.raw ? 1 : 0]?.results.length !== 1) return null;
  const stored = await first<{ state: WalletOperationState }>(
    db,
    `SELECT op.state FROM wallet_provider_instance_operations op
    JOIN wallet_provider_instances i ON i.id = op.instance_id WHERE ${SCOPE}
      AND op.id = ? AND op.version = ? AND op.attempts = ? AND op.claim_hash = ?`,
    [...scope(p), p.operationId, p.version, p.attempt, p.hash],
  );
  return stored?.state ?? null;
}
