import { all, batch, first, stmt } from '../../platform/db.ts';
import type { WalletClaimResult, WalletOperationRef } from './instance-types.ts';
import { walletEnrolmentIssuesSql } from './repo-enrolment-gate.ts';
import { type Claim, CURRENT, CURRENT_OPERATION, SCOPE, scope } from './repo-instance-claim-sql.ts';
import { pinnedKeysetSql } from './repo-keyset-pin.ts';

export { finishOperation } from './repo-instance-finish.ts';

export async function claimOperation(db: D1Database, p: Claim): Promise<WalletClaimResult> {
  p = { ...p };
  const claimed = await first(
    db,
    `UPDATE wallet_provider_instance_operations AS op
    SET state = 'claimed', attempts = attempts + 1, claim_hash = ?, claim_expires_at = ?,
      last_attempt_at = ?, next_attempt_at = NULL
    WHERE op.instance_id = ? AND op.version = ? AND op.state IN ('pending', 'retry') AND op.attempts < 8
      AND (op.next_attempt_at IS NULL OR op.next_attempt_at <= ?)
      AND NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations busy
        WHERE busy.instance_id = op.instance_id AND busy.state IN ('claimed', 'uncertain'))
      AND EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE ${SCOPE} AND ${CURRENT})
    RETURNING id`,
    [p.hash, p.now + 120_000, p.now, p.instanceId, p.version, p.now, ...scope(p), p.now],
  );
  if (claimed !== null) return 'claimed';
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
  p: WalletOperationRef & { now: number; hash?: string },
): Promise<boolean> {
  return (
    (await first(
      db,
      `SELECT 1 FROM wallet_provider_instance_operations op
    JOIN wallet_provider_instances i ON i.id = op.instance_id
    WHERE ${SCOPE} AND op.version = ? AND ${CURRENT}
      AND (op.kind != 'upsert' OR ${walletEnrolmentIssuesSql('i.org_id', 'i.mode', 'i.provider')})
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
  const row = await first(
    db,
    `UPDATE wallet_provider_instance_operations AS op SET state = 'uncertain'
    WHERE op.instance_id = ? AND op.version = ? AND op.state IN ('claimed', 'uncertain') AND op.claim_hash = ?
      AND EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE ${SCOPE})
    RETURNING id`,
    [p.instanceId, p.version, p.hash, ...scope(p)],
  );
  return row !== null;
}

/** Expiry never releases the serial fence: uncertain work requires explicit transport settlement. */
export async function expireClaims(db: D1Database, now: number, limit: number): Promise<number> {
  const rows = await all(
    db,
    `UPDATE wallet_provider_instance_operations AS op SET state = 'uncertain'
    WHERE op.credential_keyset_commitment = ${pinnedKeysetSql}
      AND EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE i.id = op.instance_id
        AND i.credential_keyset_commitment = op.credential_keyset_commitment)
      AND op.id IN (SELECT id FROM wallet_provider_instance_operations WHERE state = 'claimed'
        AND credential_keyset_commitment = ${pinnedKeysetSql} AND claim_expires_at <= ? ORDER BY claim_expires_at, id LIMIT ?)
    RETURNING id`,
    [now, limit],
  );
  return rows.length;
}

/** Call only after the transport is known to have stopped; uncertain remote writes cannot overlap. */
export async function settleClaim(
  db: D1Database,
  p: WalletOperationRef & { now: number },
): Promise<boolean> {
  const results = await batch(db, [
    // Runs before the operation moves: the target follows the operation's uncertain state.
    stmt(
      db,
      `WITH ${CURRENT_OPERATION}
      UPDATE wallet_provider_sync_targets AS target SET
      state = CASE WHEN target.attempts < 3 AND proven.is_current AND op.attempts < 8
        THEN 'retry' ELSE 'failed' END,
      next_attempt_at = CASE WHEN target.attempts < 3 AND proven.is_current AND op.attempts < 8
        THEN ? + MIN(300000, 1000 * (1 << MIN(target.attempts - 1, 8))) ELSE NULL END,
      reason_code = 'timeout', updated_at = ?
      FROM current_operation proven JOIN wallet_provider_instance_operations op ON op.id = proven.id
      WHERE target.operation_id = op.id AND target.state IN ('inflight', 'uncertain')
        AND op.instance_id = ? AND op.version = ? AND op.state = 'uncertain'
        AND EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE ${SCOPE})`,
      [
        p.instanceId,
        p.version,
        ...scope(p),
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
      `WITH ${CURRENT_OPERATION}
      UPDATE wallet_provider_instance_operations AS op SET
      state = CASE WHEN NOT proven.is_current
        THEN 'superseded' WHEN op.attempts >= 8 THEN 'failed' ELSE 'retry' END,
      next_attempt_at = CASE WHEN op.attempts >= 8 THEN NULL ELSE ? + MIN(300000, 1000 * (1 << MIN(op.attempts - 1, 8))) END,
      reason_code = 'timeout', last_result_at = ?,
      completed_at = CASE WHEN op.attempts >= 8 OR NOT proven.is_current THEN ? ELSE NULL END
      FROM current_operation proven
      WHERE op.id = proven.id AND op.instance_id = ? AND op.version = ? AND op.state = 'uncertain'
        AND EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE ${SCOPE})
      RETURNING id`,
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
  ]);
  return results[1]?.results.length === 1;
}
