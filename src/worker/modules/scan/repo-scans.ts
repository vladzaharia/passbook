import type { Mode } from '../../../shared/contracts/common.ts';
import { deleteInBatches } from '../../platform/batched.ts';
import { all, first, type SqlValue, stmt } from '../../platform/db.ts';
import type { Claim } from './repo-scans-write.ts';

type Db = D1Database;

export type { ScanRow } from './repo-scan-map.ts';
export type { Claim, Finalize } from './repo-scans-write.ts';
export {
  claimScan,
  claimScanStmt,
  finalizeStmt,
  ledgerIfFinalizedStmt,
} from './repo-scans-write.ts';

import { type Raw, type ScanRow, toScan } from './repo-scan-map.ts';

const COLUMNS = `id, org_id, mode, pass_id, template_id, scanner_id, event_id, actor_key, staff_id, request_hash,
  state, outcome, reason, action_id, action_kind, override_of, approved_by, pass_version, method, at, undone_by, direction, presence_scope`;

export async function scanByKey(db: Db, actorKey: string, key: string): Promise<ScanRow | null> {
  const row = await first<Raw>(
    db,
    `SELECT ${COLUMNS} FROM scans WHERE actor_key = ?/* scan-ephemeral-actor-key */ AND idempotency_key = ?/* scan-ephemeral-idempotency-key */`,
    [actorKey, key],
  );
  return row ? toScan(row) : null;
}

export async function scanById(db: Db, orgId: string, id: string): Promise<ScanRow | null> {
  const row = await first<Raw>(
    db,
    `SELECT ${COLUMNS} FROM scans WHERE id = ?/* scan-ephemeral-scan-id */ AND org_id = ?`,
    [id, orgId],
  );
  return row ? toScan(row) : null;
}

/** Evidence that a claim is not pristine, evaluated inside the write transaction. */
const AMBIGUOUS_SCAN = `pass_id IS NOT NULL OR template_id IS NOT NULL OR action_id IS NOT NULL OR action_kind IS NOT NULL OR
  pass_version IS NOT NULL OR outcome IS NOT NULL OR reason IS NOT NULL OR
  override_of IS NOT NULL OR approved_by IS NOT NULL OR direction IS NOT NULL OR presence_scope IS NOT NULL OR
  amount IS NOT NULL OR before_value IS NOT NULL OR after_value IS NOT NULL OR group_id IS NOT NULL OR
  offline != 0 OR notified != 0 OR undoes IS NOT NULL OR undone_by IS NOT NULL OR undone_at IS NOT NULL OR
  EXISTS (SELECT 1 FROM scan_gates g WHERE g.last_scan_id = scans.id OR g.prev_scan_id = scans.id) OR
  EXISTS (SELECT 1 FROM scan_presence p WHERE p.last_scan_id = scans.id OR p.prev_scan_id = scans.id)`;

/** Match the original claim, not a mutable row that merely retained the same key. */
export function pristineClaimFence(
  c: Pick<
    Claim,
    | 'orgId'
    | 'mode'
    | 'scannerId'
    | 'eventId'
    | 'actorType'
    | 'actorId'
    | 'actorKey'
    | 'staffId'
    | 'method'
    | 'idempotencyKey'
    | 'requestHash'
  >,
): { sql: string; params: SqlValue[] } {
  return {
    sql: `NOT (${AMBIGUOUS_SCAN}) AND scans.org_id=? AND scans.mode=?
      AND scans.scanner_id IS ?/* scan-ephemeral-scanner-id */ AND scans.event_id IS ?/* scan-ephemeral-event-id */
      AND scans.actor_type=? AND scans.actor_id=?/* scan-ephemeral-actor-id */ AND scans.actor_key=?/* scan-ephemeral-actor-key */
      AND scans.staff_id IS ?/* scan-ephemeral-staff-id */ AND scans.method=?
      AND scans.idempotency_key=?/* scan-ephemeral-idempotency-key */ AND scans.request_hash=?/* scan-ephemeral-request-hash */`,
    params: [
      c.orgId,
      c.mode,
      c.scannerId,
      c.eventId,
      c.actorType,
      c.actorId,
      c.actorKey,
      c.staffId,
      c.method,
      c.idempotencyKey,
      c.requestHash,
    ],
  };
}

/** Preserve presence evidence observed before recovery races a later write. */
export function presenceOfScansStmt(db: Db, ids: readonly string[]): D1PreparedStatement {
  const values = JSON.stringify(ids);
  return stmt(
    db,
    `SELECT last_scan_id,prev_scan_id FROM scan_presence
    WHERE last_scan_id IN (SELECT value FROM json_each(?/* scan-ephemeral-scan-id-list */)) OR prev_scan_id IN (SELECT value FROM json_each(?/* scan-ephemeral-scan-id-list */))`,
    [values, values],
  );
}

/** Reopen only a pristine failure and advance its epoch even if the clock has not moved. */
export async function reopenScan(db: Db, id: string, now: number): Promise<number | null> {
  const results = await db.batch([
    stmt(
      db,
      `UPDATE scans SET reason = 'stale' WHERE id = ?/* scan-ephemeral-scan-id */ AND state = 'failed'
      AND reason IS NULL AND (${AMBIGUOUS_SCAN})`,
      [id],
    ),
    stmt(
      db,
      `UPDATE scans SET state = 'pending', at = MAX(at + 1, ?) WHERE id = ?/* scan-ephemeral-scan-id */ AND state = 'failed'
      AND reason IS NULL RETURNING at`,
      [now, id],
    ),
  ]);
  return (results[1]?.results?.[0] as { at: number } | undefined)?.at ?? null;
}

/** Discard only a pristine pending generation with no evidence of an effect. */
export const releaseClaimStmt = (
  db: Db,
  id: string,
  claimAt: number,
  extra?: { sql: string; params: readonly SqlValue[] },
) =>
  stmt(
    db,
    `DELETE FROM scans WHERE id = ?/* scan-ephemeral-scan-id */ AND state = 'pending' AND at = ?
       AND NOT (${AMBIGUOUS_SCAN})${extra ? ` AND (${extra.sql})` : ''}
     RETURNING id`,
    [id, claimAt, ...(extra?.params ?? [])],
  );

/** Preserve a no-retry marker for an ambiguous or replaced claim generation. */
export const quarantineGateClaimStmt = (
  db: Db,
  id: string,
  at: number,
  original?: { sql: string; params: readonly SqlValue[] },
) =>
  stmt(
    db,
    `UPDATE scans SET state = 'failed', reason = 'stale'
  WHERE id = ?/* scan-ephemeral-scan-id */ AND state = 'pending' AND at = ?
    AND ((${AMBIGUOUS_SCAN})${original ? ` OR NOT (${original.sql})` : ''})`,
    [id, at, ...(original?.params ?? [])],
  );

/** Mark the exact pending generation before any batch can attempt a gate effect. */
export const markScanEffectIntentStmt = (
  db: Db,
  id: string,
  at: number,
  guard?: { sql: string; params: readonly SqlValue[] },
) =>
  stmt(
    db,
    `UPDATE scans SET reason = 'stale' WHERE id = ?/* scan-ephemeral-scan-id */ AND state = 'pending'
      AND at = ? AND NOT (${AMBIGUOUS_SCAN})${guard ? ` AND (${guard.sql})` : ''} RETURNING id`,
    [id, at, ...(guard?.params ?? [])],
  );

/**
 * Fail a pending claim atomically. Any evidence of an effect makes the failure non-retryable;
 * recovery also carries forward evidence observed before this transaction.
 */
export function failScanStmt(
  db: Db,
  id: string,
  recovery: { at: number; observedAmbiguous: boolean },
): D1PreparedStatement {
  return stmt(
    db,
    `UPDATE scans SET state = 'failed', reason = CASE WHEN ? OR (${AMBIGUOUS_SCAN})
       THEN 'stale' ELSE NULL END
     WHERE id = ?/* scan-ephemeral-scan-id */ AND at = ? AND (state = 'pending' OR (? AND state = 'failed' AND reason IS NULL))
     RETURNING id, reason`,
    [recovery.observedAmbiguous, id, recovery.at, recovery.observedAmbiguous],
  );
}

/** An override target: an earlier heads-up the same actor wrote (SA 2.6). */
export async function overrideTarget(
  db: Db,
  orgId: string,
  mode: Mode,
  actorKey: string,
  id: string,
  since: number,
): Promise<{ scan: ScanRow; taken: boolean } | null> {
  const row = await first<Raw & { taken: number }>(
    db,
    `SELECT ${COLUMNS}, EXISTS (SELECT 1 FROM scans o WHERE o.actor_key = ? AND o.at >= ?
         AND o.override_of = ? AND o.outcome = 'ok') AS taken
     FROM scans WHERE id = ? AND org_id = ? AND mode = ? AND actor_key = ? AND state = 'done'
       AND outcome = 'heads_up' AND at >= ?`,
    [actorKey, since, id, id, orgId, mode, actorKey, since],
  );
  return row ? { scan: toScan(row), taken: row.taken === 1 } : null;
}

/** Pending rows past the threshold, oldest first. */
export async function pendingScans(db: Db, olderThan: number, limit: number): Promise<ScanRow[]> {
  const rows = await all<Raw>(
    db,
    `SELECT ${COLUMNS} FROM scans WHERE state = 'pending' AND at < ? ORDER BY at LIMIT ?`,
    [olderThan, limit],
  );
  return rows.map(toScan);
}

/** Deletes finished scans of one mode older than the cutoff (`scans_mode_at`), in batches. */
export const deleteScansBefore = (db: Db, mode: Mode, before: number) =>
  deleteInBatches(db, 'scans', 'mode = ? AND at < ?', [mode, before]);
