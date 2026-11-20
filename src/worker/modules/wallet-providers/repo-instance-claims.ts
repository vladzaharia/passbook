import { writePart } from '../../platform/authority-include.ts';
import { all, first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { WalletClaimResult, WalletOperationRef } from './instance-types.ts';
import { walletEnrolmentIssuesSql } from './repo-enrolment-gate.ts';
import {
  type Claim,
  CURRENT,
  PART_CURRENT,
  PART_CURRENT_OPERATION,
  PART_SCOPE,
  partScope,
  SCOPE,
  scope,
} from './repo-instance-claim-sql.ts';
import { instanceCheck, walletOpCurrentCheck } from './repo-instance-current.ts';
import { pinnedKeysetSql } from './repo-keyset-pin.ts';
import { commitWalletGrant, walletQueueGrant } from './repo-queue-grant.ts';

export { finishOperation } from './repo-instance-finish.ts';

/**
 * Claims one exact operation under the sync grant (a revoke under the revoke grant, which also runs for a suspended
 * org). The grant refuses a stale operation; a refusal is `not_claimable`, never an error.
 */
export async function claimOperation(ctx: ServiceContext, p: Claim): Promise<WalletClaimResult> {
  p = { ...p };
  const db = ctx.env.DB;
  const kind = await first<{ kind: 'upsert' | 'revoke' }>(
    db,
    'SELECT kind FROM wallet_provider_instance_operations WHERE instance_id = ? AND version = ?',
    [p.instanceId, p.version],
  );
  const g = walletQueueGrant(ctx, kind?.kind === 'revoke' ? 'revoke' : 'sync', p, [
    walletOpCurrentCheck(p.instanceId, p.version),
  ]);
  g.include(
    writePart(
      `UPDATE wallet_provider_instance_operations AS op
      SET state = 'claimed', attempts = attempts + 1, claim_hash = ?, claim_expires_at = ?,
        last_attempt_at = ?, next_attempt_at = NULL
      WHERE op.instance_id = ? AND op.version = ? AND op.state IN ('pending', 'retry') AND op.attempts < 8
        AND (op.next_attempt_at IS NULL OR op.next_attempt_at <= ?)
        AND NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations busy
          WHERE busy.instance_id = op.instance_id AND busy.state IN ('claimed', 'uncertain'))
        AND EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE ${PART_SCOPE} AND ${PART_CURRENT})
        AND {grant}
      RETURNING id`,
      [p.hash, p.now + 120_000, p.now, p.instanceId, p.version, p.now, ...partScope(p)],
    ),
  );
  const committed = await commitWalletGrant(g);
  if ('results' in committed && (committed.results[0]?.results.length ?? 0) === 1) return 'claimed';
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
      p.hash === undefined ? [...scope(p), p.version] : [...scope(p), p.version, p.hash, p.now],
    )) !== null
  );
}

/** A claim that may have reached a provider is held, whatever the org's state: lineage only. */
export async function markUncertain(ctx: ServiceContext, p: Claim): Promise<boolean> {
  const g = walletQueueGrant(ctx, 'record', p, [instanceCheck(p.instanceId)]);
  g.include(
    writePart(
      `UPDATE wallet_provider_instance_operations AS op SET state = 'uncertain'
      WHERE op.instance_id = ? AND op.version = ? AND op.state IN ('claimed', 'uncertain') AND op.claim_hash = ?
        AND EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE ${PART_SCOPE}) AND {grant}
      RETURNING id`,
      [p.instanceId, p.version, p.hash, ...partScope(p)],
    ),
  );
  const committed = await commitWalletGrant(g);
  return 'results' in committed && (committed.results[0]?.results.length ?? 0) === 1;
}

/** Expiry never releases the serial fence: uncertain work requires explicit transport settlement. */
export async function expireClaims(
  ctx: ServiceContext,
  now: number,
  limit: number,
): Promise<number> {
  const due = await all<{ id: string; instanceId: string; orgId: string; mode: 'live' | 'test' }>(
    ctx.env.DB,
    `SELECT op.id, i.id AS instanceId, i.org_id AS orgId, i.mode FROM wallet_provider_instance_operations op
    JOIN wallet_provider_instances i ON i.id = op.instance_id
      AND i.credential_keyset_commitment = op.credential_keyset_commitment
    WHERE op.state = 'claimed' AND op.credential_keyset_commitment = ${pinnedKeysetSql}
      AND op.claim_expires_at <= ? ORDER BY op.claim_expires_at, op.id LIMIT ?`,
    [now, limit],
  );
  let expired = 0;
  for (const op of due) {
    const g = walletQueueGrant(ctx, 'record', op, [instanceCheck(op.instanceId)]);
    g.include(
      writePart(
        `UPDATE wallet_provider_instance_operations AS op SET state = 'uncertain'
        WHERE op.id = ? AND op.state = 'claimed' AND op.claim_expires_at <= ?
          AND op.credential_keyset_commitment = ${pinnedKeysetSql}
          AND EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE i.id = op.instance_id
            AND i.org_id = {org} AND i.mode = {mode}
            AND i.credential_keyset_commitment = op.credential_keyset_commitment) AND {grant}
        RETURNING id`,
        [op.id, now],
      ),
    );
    const committed = await commitWalletGrant(g);
    if ('results' in committed) expired += committed.results[0]?.results.length ?? 0;
  }
  return expired;
}

/** Call only after the transport is known to have stopped; uncertain remote writes cannot overlap. */
export async function settleClaim(
  ctx: ServiceContext,
  p: WalletOperationRef & { now: number },
): Promise<boolean> {
  const g = walletQueueGrant(ctx, 'record', p, [instanceCheck(p.instanceId)]);
  const cte = [p.instanceId, p.version, ...partScope(p)];
  const rest = [p.instanceId, p.version, ...partScope(p)];
  g.include(
    // Runs before the operation moves: the target follows the operation's uncertain state.
    writePart(
      `WITH ${PART_CURRENT_OPERATION}
      UPDATE wallet_provider_sync_targets AS target SET
      state = CASE WHEN target.attempts < 3 AND proven.is_current AND op.attempts < 8
        THEN 'retry' ELSE 'failed' END,
      next_attempt_at = CASE WHEN target.attempts < 3 AND proven.is_current AND op.attempts < 8
        THEN ? + MIN(300000, 1000 * (1 << MIN(target.attempts - 1, 8))) ELSE NULL END,
      reason_code = 'timeout', updated_at = ?
      FROM current_operation proven JOIN wallet_provider_instance_operations op ON op.id = proven.id
      WHERE target.operation_id = op.id AND target.state IN ('inflight', 'uncertain')
        AND op.instance_id = ? AND op.version = ? AND op.state = 'uncertain'
        AND EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE ${PART_SCOPE}) AND {grant}`,
      [...cte, p.now, p.now, ...rest],
    ),
    writePart(
      `WITH ${PART_CURRENT_OPERATION}
      UPDATE wallet_provider_instance_operations AS op SET
      state = CASE WHEN NOT proven.is_current
        THEN 'superseded' WHEN op.attempts >= 8 THEN 'failed' ELSE 'retry' END,
      next_attempt_at = CASE WHEN op.attempts >= 8 THEN NULL ELSE ? + MIN(300000, 1000 * (1 << MIN(op.attempts - 1, 8))) END,
      reason_code = 'timeout', last_result_at = ?,
      completed_at = CASE WHEN op.attempts >= 8 OR NOT proven.is_current THEN ? ELSE NULL END
      FROM current_operation proven
      WHERE op.id = proven.id AND op.instance_id = ? AND op.version = ? AND op.state = 'uncertain'
        AND EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE ${PART_SCOPE}) AND {grant}
      RETURNING id`,
      [...cte, p.now, p.now, p.now, ...rest],
    ),
  );
  const committed = await commitWalletGrant(g);
  return 'results' in committed && committed.results[1]?.results.length === 1;
}
