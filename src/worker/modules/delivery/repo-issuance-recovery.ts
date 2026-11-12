import { all, first, run } from '../../platform/db.ts';
import type { IssuanceRow } from './issuance-context.ts';

export async function getIntent(db: D1Database, passId: string): Promise<IssuanceRow | null> {
  return first<IssuanceRow>(
    db,
    `SELECT pass_id,org_id,mode,recipient,template_id,context,transfer_id,
    state,outbox_id,outcome,error_code FROM pass_issuance_deliveries WHERE pass_id = ?`,
    [passId],
  );
}

export async function hasPendingIssuanceTransfer(db: D1Database, passId: string): Promise<boolean> {
  return Boolean(
    await first(
      db,
      `SELECT 1 FROM pass_credential_transfers WHERE pass_id = ? AND state = 'pending'`,
      [passId],
    ),
  );
}

/** Defer only the same issuance lineage observed by the scheduler. */
export async function deferIssuanceForRateLimit(
  db: D1Database,
  passId: string,
  transferId: string | null,
  nextAttemptAt: number,
): Promise<void> {
  await run(
    db,
    `UPDATE pass_issuance_deliveries SET next_attempt_at = ?
        WHERE pass_id = ? AND state = 'pending' AND transfer_id IS ?`,
    [nextAttemptAt, passId, transferId],
  );
}

/** Do not cancel a new lineage or an in-flight transfer that won after the read. */
export async function cancelStaleIssuance(
  db: D1Database,
  passId: string,
  transferId: string | null,
  errorCode: 'ORG_INACTIVE' | 'ACTOR_REVOKED' | 'DELIVERY_STALE',
): Promise<void> {
  await run(
    db,
    `UPDATE pass_issuance_deliveries SET state = 'cancelled', error_code = ?
      WHERE pass_id = ? AND state = 'pending' AND transfer_id IS ?
        AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = ? AND t.state = 'pending')`,
    [errorCode, passId, transferId, passId],
  );
}

export async function dueIssuanceDeliveries(
  db: D1Database,
  now: number,
  passId?: string,
): Promise<{ pass_id: string }[]> {
  return all<{ pass_id: string }>(
    db,
    `SELECT i.pass_id FROM pass_issuance_deliveries i
    WHERE i.state = 'pending' AND i.next_attempt_at <= ? AND (? IS NULL OR i.pass_id = ?)
      AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = i.pass_id AND t.state = 'pending')
    ORDER BY i.next_attempt_at,i.created_at,i.pass_id LIMIT 100`,
    [now, passId ?? null, passId ?? null],
  );
}

/** A transient sweep failure defers the pending intent without changing its lineage. */
export async function deferFailedIssuance(
  db: D1Database,
  passId: string,
  nextAttemptAt: number,
): Promise<void> {
  await run(
    db,
    `UPDATE pass_issuance_deliveries SET next_attempt_at = ?
        WHERE pass_id = ? AND state = 'pending'`,
    [nextAttemptAt, passId],
  );
}
