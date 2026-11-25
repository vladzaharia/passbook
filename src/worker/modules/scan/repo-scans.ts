import type { Mode } from '../../../shared/contracts/common.ts';
import { deleteInBatches } from '../../platform/batched.ts';
import { all, exactStmt, first, type SqlValue, stmt } from '../../platform/db.ts';
import type { SunSeen } from '../nfc/repo-sun.ts';
import { scanConjunction } from './scan-conjunction.ts';
import { type ScanPredicate, withCtes } from './scan-predicate.ts';

type Db = D1Database;

export type { ScanRow } from './repo-scan-map.ts';

export interface Claim {
  id: string;
  orgId: string;
  mode: Mode;
  scannerId: string | null;
  eventId: string | null;
  actorType: 'scanner' | 'user';
  actorId: string;
  actorKey: string;
  staffId: string | null;
  /** The API key a till scanned with, when it did. */
  apiKeyId?: string | null;
  /** The scanning session the device belongs to, kept for passless replays. */
  sessionId?: string | null;
  /** The scan this one lets in: set at claim, so two racing overrides meet at `scans_override_once`. */
  overrideOf?: string | null;
  idempotencyKey: string;
  requestHash: string;
  method: string;
  /** The tag the scan was read from. */
  tagId?: string | null;
  /** A SUN read of that tag: the claim consumes its counter in the same batch, or is refused. */
  sun?: SunSeen | null;
  clientTs: number;
  now: number;
}

export interface Finalize {
  id: string;
  claimAt: number;
  outcome: 'ok' | 'heads_up' | 'refused';
  reason: string | null;
  passId: string | null;
  templateId: string | null;
  actionId: string | null;
  actionKind: string | null;
  passVersion: number | null;
  overrideOf: string | null;
  approvedBy: string | null;
  direction?: 'in' | 'out';
  presenceScope?: string;
  eventId?: string;
}

import { type Raw, type ScanRow, toScan } from './repo-scan-map.ts';

const COLUMNS = `id, org_id, mode, pass_id, template_id, scanner_id, event_id, actor_key, staff_id, session_id, request_hash,
  state, outcome, reason, action_id, action_kind, override_of, approved_by, pass_version, method, at, undone_by, direction, presence_scope`;

export async function scanByKey(db: Db, actorKey: string, key: string): Promise<ScanRow | null> {
  const row = await first<Raw>(
    db,
    `SELECT ${COLUMNS} FROM scans WHERE actor_key = ? AND idempotency_key = ?`,
    [actorKey, key],
  );
  return row ? toScan(row) : null;
}

export async function scanById(db: Db, orgId: string, id: string): Promise<ScanRow | null> {
  const row = await first<Raw>(db, `SELECT ${COLUMNS} FROM scans WHERE id = ? AND org_id = ?`, [
    id,
    orgId,
  ]);
  return row ? toScan(row) : null;
}

/** Evidence that a claim is not pristine, evaluated inside the write transaction. `override_of` is part of the claim itself (set at claim), so it is no evidence. Grouped to bound D1's expression depth. */
const AMBIGUOUS_TERMS = [
  'pass_id IS NOT NULL',
  'template_id IS NOT NULL',
  'action_id IS NOT NULL',
  'action_kind IS NOT NULL',
  'pass_version IS NOT NULL',
  'outcome IS NOT NULL',
  'reason IS NOT NULL',
  'approved_by IS NOT NULL',
  'direction IS NOT NULL',
  'presence_scope IS NOT NULL',
  'amount IS NOT NULL',
  'before_value IS NOT NULL',
  'after_value IS NOT NULL',
  'group_id IS NOT NULL',
  'offline != 0',
  'notified != 0',
  'undoes IS NOT NULL',
  'undone_by IS NOT NULL',
  'undone_at IS NOT NULL',
  'EXISTS (SELECT 1 FROM scan_gates g WHERE g.last_scan_id = scans.id OR g.prev_scan_id = scans.id)',
  'EXISTS (SELECT 1 FROM scan_presence p WHERE p.last_scan_id = scans.id OR p.prev_scan_id = scans.id)',
];
const AMBIGUOUS_SCAN = Array.from(
  { length: Math.ceil(AMBIGUOUS_TERMS.length / 4) },
  (_, group) => `(${AMBIGUOUS_TERMS.slice(group * 4, group * 4 + 4).join(' OR ')})`,
).join(' OR ');

declare const pristineBrand: unique symbol;

/** A predicate that carries the pristine-claim evidence check: only `pristineClaimFence` and `invalidAttemptAuthority` make one. */
export type PristineClaimFence = ScanPredicate & { readonly [pristineBrand]: true };

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
): PristineClaimFence & { params: SqlValue[] } {
  return {
    sql: scanConjunction([
      `NOT (${AMBIGUOUS_SCAN})`,
      'scans.org_id=? AND scans.mode=?',
      'scans.scanner_id IS ? AND scans.event_id IS ?',
      'scans.actor_type=? AND scans.actor_id=? AND scans.actor_key=?',
      'scans.staff_id IS ? AND scans.method=?',
      'scans.idempotency_key=? AND scans.request_hash=?',
    ]),
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
  } as PristineClaimFence & { params: SqlValue[] };
}

/** Preserve presence evidence observed before recovery races a later write. */
export function presenceOfScansStmt(db: Db, ids: readonly string[]): D1PreparedStatement {
  const values = JSON.stringify(ids);
  return stmt(
    db,
    `SELECT last_scan_id,prev_scan_id FROM scan_presence
    WHERE last_scan_id IN (SELECT value FROM json_each(?)) OR prev_scan_id IN (SELECT value FROM json_each(?))`,
    [values, values],
  );
}

/** Reopen only a pristine failure and advance its epoch even if the clock has not moved. */
export async function reopenScan(db: Db, id: string, now: number): Promise<number | null> {
  const results = await db.batch([
    stmt(
      db,
      `UPDATE scans SET reason = 'stale' WHERE id = ? AND state = 'failed'
      AND reason IS NULL AND (${AMBIGUOUS_SCAN})`,
      [id],
    ),
    stmt(
      db,
      `UPDATE scans SET state = 'pending', at = MAX(at + 1, ?) WHERE id = ? AND state = 'failed'
      AND reason IS NULL RETURNING at`,
      [now, id],
    ),
  ]);
  return (results[1]?.results?.[0] as { at: number } | undefined)?.at ?? null;
}

/**
 * Discard only a pristine pending generation with no evidence of an effect. `extra` is the claim's
 * `pristineClaimFence`, alone or under an authority; it carries the evidence check itself.
 */
export function releaseClaimStmt(
  db: Db,
  id: string,
  claimAt: number,
  extra?: PristineClaimFence,
): D1PreparedStatement {
  const sql = `DELETE FROM scans WHERE id = ? AND state = 'pending' AND at = ?
       AND ${extra ? `(${extra.sql})` : `NOT (${AMBIGUOUS_SCAN})`}
     RETURNING id`;
  const params = [id, claimAt, ...(extra?.params ?? [])];
  const staged = extra ? withCtes(extra, sql, params) : { sql, params };
  return exactStmt(db, staged.sql, staged.params);
}

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
  WHERE id = ? AND state = 'pending' AND at = ?
    AND ${original ? `NOT (NOT (${AMBIGUOUS_SCAN}) AND (${original.sql}))` : `(${AMBIGUOUS_SCAN})`}`,
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
    `UPDATE scans SET reason = 'stale' WHERE id = ? AND state = 'pending'
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
     WHERE id = ? AND at = ? AND (state = 'pending' OR (? AND state = 'failed' AND reason IS NULL))
     RETURNING id, reason`,
    [recovery.observedAmbiguous, id, recovery.at, recovery.observedAmbiguous],
  );
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

/** Staff notes of one mode older than the cutoff: the test-mode window; live notes follow the retention plan. */
export const deleteNotesBefore = (db: Db, mode: Mode, before: number) =>
  deleteInBatches(db, 'pass_notes', 'mode = ? AND created_at < ?', [mode, before]);

/** Deletes finished scans of one mode older than the cutoff (`scans_mode_at`), in batches. */
export const deleteScansBefore = (db: Db, mode: Mode, before: number) =>
  deleteInBatches(db, 'scans', 'mode = ? AND at < ?', [mode, before]);
