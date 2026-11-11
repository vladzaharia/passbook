import type { Envelope } from '../../platform/crypto.ts';
import { batch, first, run, stmt } from '../../platform/db.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import type {
  WalletClaimResult,
  WalletCredentialKeysetProof,
  WalletOperationRef,
  WalletOperationState,
  WalletProviderResult,
} from './instance-types.ts';
import { isCredentialKeysetCommitment } from './instance-types.ts';
import { walletInstanceOperationCurrentSql } from './repo-instance-proof.ts';

interface Claim extends WalletOperationRef, WalletCredentialKeysetProof {
  hash: string;
  now: number;
}
const SCOPE = `i.id = op.instance_id AND i.id = ? AND i.org_id = ? AND i.mode = ? AND i.provider = ?
  AND i.credential_keyset_commitment = op.credential_keyset_commitment
  AND op.credential_keyset_commitment = ? AND ${credentialRefKeysetSql}`;
const scope = (p: WalletOperationRef & WalletCredentialKeysetProof) =>
  [
    p.instanceId,
    p.orgId,
    p.mode,
    p.provider,
    p.credentialKeysetCommitment,
    p.credentialKeysetCommitment,
  ] as const;
const CURRENT = walletInstanceOperationCurrentSql('i', 'op', '?');
// Keep the scoped candidate and its authority proof in separate SELECTs. Joining
// the materialized result once prevents SQLite expanding the proof in every CASE.
// The unique (instance_id, version) key and primary-key joins yield at most one row.
const CURRENT_OPERATION = `scoped_operation AS MATERIALIZED (
    SELECT op.id FROM wallet_provider_instance_operations op
    JOIN wallet_provider_instances i ON i.id = op.instance_id
    WHERE op.instance_id = ? AND op.version = ? AND ${SCOPE}
  ), current_operation AS MATERIALIZED (
    SELECT op.id, CASE WHEN ${CURRENT} THEN 1 ELSE 0 END AS is_current
    FROM scoped_operation scoped
    JOIN wallet_provider_instance_operations op ON op.id = scoped.id
    JOIN wallet_provider_instances i ON i.id = op.instance_id
  )`;
const RETRY_DELAY = `MIN(300000, MAX(1000 * (1 << MIN(op.attempts - 1, 8)), ?))`;

export async function claimOperation(db: D1Database, p: Claim): Promise<WalletClaimResult> {
  p = { ...p };
  if (!isCredentialKeysetCommitment(p.credentialKeysetCommitment)) return 'not_claimable';
  const result = await run(
    db,
    `UPDATE wallet_provider_instance_operations AS op
    SET state = 'claimed', attempts = attempts + 1, claim_hash = ?, claim_expires_at = ?,
      last_attempt_at = ?, next_attempt_at = NULL
    WHERE op.instance_id = ? AND op.version = ? AND op.state IN ('pending', 'retry') AND op.attempts < 8
      AND (op.next_attempt_at IS NULL OR op.next_attempt_at <= ?)
      AND NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations busy
        WHERE busy.instance_id = op.instance_id AND busy.state IN ('claimed', 'uncertain'))
      AND EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE ${SCOPE} AND ${CURRENT})`,
    [p.hash, p.now + 120_000, p.now, p.instanceId, p.version, p.now, ...scope(p), p.now],
  );
  if (result.changes === 1) return 'claimed';
  const existing = await first<{ state: string; claim_hash: string | null }>(
    db,
    `SELECT op.state, op.claim_hash FROM wallet_provider_instance_operations op
     JOIN wallet_provider_instances i ON i.id = op.instance_id
     WHERE ${SCOPE} AND op.version = ?`,
    [...scope(p), p.version],
  );
  return existing?.state === 'claimed' && existing.claim_hash === p.hash
    ? 'already_claimed'
    : 'not_claimable';
}

/** Without a handle this is a current offer proof; with one it is a pre-dispatch claim proof. */
export async function operationFresh(
  db: D1Database,
  p: WalletOperationRef & WalletCredentialKeysetProof & { now: number; hash?: string },
): Promise<boolean> {
  if (!isCredentialKeysetCommitment(p.credentialKeysetCommitment)) return false;
  return (
    (await first(
      db,
      `SELECT 1 FROM wallet_provider_instance_operations op
    JOIN wallet_provider_instances i ON i.id = op.instance_id
    WHERE ${SCOPE} AND op.version = ? AND ${CURRENT}
      AND ${
        p.hash === undefined
          ? "op.kind = 'upsert' AND op.state IN ('pending', 'retry', 'claimed', 'succeeded')"
          : "op.state = 'claimed' AND op.claim_hash = ? AND op.claim_expires_at > ?"
      }`,
      p.hash === undefined
        ? [...scope(p), p.version, p.now]
        : [...scope(p), p.version, p.now, p.hash, p.now],
    )) !== null
  );
}

export async function markUncertain(db: D1Database, p: Claim): Promise<boolean> {
  if (!isCredentialKeysetCommitment(p.credentialKeysetCommitment)) return false;
  const result = await run(
    db,
    `UPDATE wallet_provider_instance_operations AS op SET state = 'uncertain'
    WHERE op.instance_id = ? AND op.version = ? AND op.state IN ('claimed', 'uncertain') AND op.claim_hash = ?
      AND EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE ${SCOPE})`,
    [p.instanceId, p.version, p.hash, ...scope(p)],
  );
  return result.changes === 1;
}

/** Expiry never releases the serial fence: uncertain work requires explicit transport settlement. */
export async function expireClaims(
  db: D1Database,
  now: number,
  limit: number,
  credentialKeysetCommitment: string,
): Promise<number> {
  if (!isCredentialKeysetCommitment(credentialKeysetCommitment)) return 0;
  const result = await run(
    db,
    `UPDATE wallet_provider_instance_operations AS op SET state = 'uncertain'
    WHERE op.credential_keyset_commitment = ? AND ${credentialRefKeysetSql}
      AND EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE i.id = op.instance_id
        AND i.credential_keyset_commitment = op.credential_keyset_commitment)
      AND op.id IN (SELECT id FROM wallet_provider_instance_operations WHERE state = 'claimed'
        AND credential_keyset_commitment = ? AND claim_expires_at <= ? ORDER BY claim_expires_at, id LIMIT ?)`,
    [
      credentialKeysetCommitment,
      credentialKeysetCommitment,
      credentialKeysetCommitment,
      now,
      limit,
    ],
  );
  return result.changes;
}

/** Call only after the transport is known to have stopped; uncertain remote writes cannot overlap. */
export async function settleClaim(
  db: D1Database,
  p: WalletOperationRef & WalletCredentialKeysetProof & { now: number },
): Promise<boolean> {
  if (!isCredentialKeysetCommitment(p.credentialKeysetCommitment)) return false;
  const results = await batch(db, [
    stmt(
      db,
      `WITH ${CURRENT_OPERATION}
      UPDATE wallet_provider_instance_operations AS op SET
      state = CASE WHEN NOT proven.is_current
        THEN 'superseded' WHEN op.attempts >= 8 THEN 'failed' ELSE 'retry' END,
      next_attempt_at = CASE WHEN op.attempts >= 8 THEN NULL ELSE ? + MIN(300000, 1000 * (1 << MIN(op.attempts - 1, 8))) END,
      reason_code = 'timeout', last_result_at = ?,
      completed_at = CASE WHEN op.attempts >= 8 OR NOT proven.is_current THEN ? ELSE NULL END
      FROM current_operation proven
      WHERE op.id = proven.id AND op.instance_id = ? AND op.version = ? AND op.state = 'uncertain'
        AND EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE ${SCOPE})`,
      [
        p.instanceId,
        p.version,
        ...scope(p),
        p.now,
        p.now,
        p.now,
        p.now,
        p.instanceId,
        p.version,
        ...scope(p),
      ],
    ),
    stmt(
      db,
      `UPDATE wallet_provider_sync_targets AS target SET
      state = CASE WHEN target.attempts < 3 AND EXISTS (SELECT 1 FROM wallet_provider_instance_operations op
        WHERE op.id = target.operation_id AND op.state = 'retry') THEN 'retry' ELSE 'failed' END,
      next_attempt_at = CASE WHEN target.attempts < 3 AND EXISTS (SELECT 1 FROM wallet_provider_instance_operations op
        WHERE op.id = target.operation_id AND op.state = 'retry') THEN ? + MIN(300000, 1000 * (1 << MIN(target.attempts - 1, 8))) ELSE NULL END,
      reason_code = 'timeout', updated_at = ?
      WHERE target.state IN ('inflight', 'uncertain') AND changes() = 1
        AND EXISTS (SELECT 1 FROM wallet_provider_instance_operations op
          JOIN wallet_provider_instances i ON i.id = op.instance_id
          WHERE op.id = target.operation_id AND ${SCOPE} AND op.version = ? AND op.last_result_at = ?
            AND op.state IN ('retry', 'failed', 'superseded'))`,
      [p.now, p.now, ...scope(p), p.version, p.now],
    ),
  ]);
  return (results[0]?.meta.changes ?? 0) === 1;
}

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
  if (!isCredentialKeysetCommitment(p.credentialKeysetCommitment)) return null;
  const success = p.result.kind !== 'failure';
  const retryable = p.result.kind === 'failure' && p.result.retryable;
  const reason =
    p.result.kind === 'success'
      ? 'ok'
      : p.result.kind === 'not_issued'
        ? 'not_issued'
        : p.result.reason;
  const retryMs = p.result.kind === 'failure' ? (p.result.retryAfterMs ?? 0) : 0;
  const statements = [
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
    WHERE op.id = proven.id AND op.id = ? AND op.instance_id = ? AND op.version = ? AND op.attempts = ?
      AND op.claim_hash = ? AND op.state IN ('claimed', 'uncertain')
      AND NOT EXISTS (SELECT 1 FROM wallet_provider_sync_targets target
        WHERE target.operation_id = op.id AND target.state IN ('inflight', 'uncertain'))
      AND EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE ${SCOPE})
      ${
        p.result.kind === 'not_issued'
          ? `AND op.kind = 'revoke' AND EXISTS (
        SELECT 1 FROM wallet_provider_instances ni WHERE ni.id = op.instance_id AND ni.provider = 'samsung'
          AND NOT EXISTS (SELECT 1 FROM wallet_samsung_fetch_refs ref WHERE ref.instance_id = ni.id
            AND (ref.retired_at IS NULL OR ref.promoted_at IS NOT NULL OR ref.initial_expires_at > ?)))`
          : ''
      }`,
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
        p.operationId,
        p.instanceId,
        p.version,
        p.attempt,
        p.hash,
        ...scope(p),
        ...(p.result.kind === 'not_issued' ? [p.now] : []),
      ],
    ),
  ];
  if (p.raw)
    statements.push(
      stmt(
        db,
        `INSERT INTO wallet_provider_instance_outcomes
      (id, operation_id, attempt, sequence, event_hash, payload_hash, reason_code, http_status,
       kek_version, iv, wrapped_dek, ciphertext, received_at)
    SELECT ?, op.id, op.attempts, COALESCE((SELECT MAX(sequence) + 1 FROM wallet_provider_instance_outcomes
      WHERE operation_id = op.id AND attempt = op.attempts), 1), ?, ?, ?, ?, ?, ?, ?, ?, ?
    FROM wallet_provider_instance_operations op
    WHERE changes() = 1 AND op.id = ? AND op.attempts = ? AND op.claim_hash = ?
      AND op.state IN ('succeeded', 'retry', 'failed') AND op.credential_keyset_commitment = ?
      AND ${credentialRefKeysetSql}`,
        [
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
          p.operationId,
          p.attempt,
          p.hash,
          p.credentialKeysetCommitment,
          p.credentialKeysetCommitment,
        ],
      ),
    );
  if (success)
    statements.push(
      stmt(
        db,
        `UPDATE wallet_provider_instances AS i SET lifecycle = 'revoked',
      revoked_at = ?, retirement_next_attempt_at = 0, updated_at = ? WHERE i.id = ? AND i.org_id = ? AND i.mode = ? AND i.provider = ?
    AND i.credential_keyset_commitment = ? AND ${credentialRefKeysetSql}
    AND EXISTS (SELECT 1 FROM wallet_provider_instance_operations op WHERE op.id = ? AND op.kind = 'revoke'
      AND op.credential_keyset_commitment = ? AND op.state = 'succeeded'
      AND op.claim_hash = ? AND op.attempts = ? AND op.last_result_at = ? AND ${CURRENT})`,
        [
          p.now,
          p.now,
          ...scope(p),
          p.operationId,
          p.credentialKeysetCommitment,
          p.hash,
          p.attempt,
          p.now,
          p.now,
        ],
      ),
    );
  const results = await batch(db, statements);
  if ((results[0]?.meta.changes ?? 0) !== 1) return null;
  const stored = await first<{ state: WalletOperationState }>(
    db,
    `SELECT op.state FROM wallet_provider_instance_operations op
    JOIN wallet_provider_instances i ON i.id = op.instance_id WHERE ${SCOPE}
      AND op.id = ? AND op.version = ? AND op.attempts = ? AND op.claim_hash = ?`,
    [...scope(p), p.operationId, p.version, p.attempt, p.hash],
  );
  return stored?.state ?? null;
}
