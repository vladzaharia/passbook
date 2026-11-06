import type { Mode } from '../../../shared/contracts/common.ts';
import { first, placeholders, run, stmt } from '../../platform/db.ts';

type Db = D1Database;

/** Today's ok scans by this actor (`scans_actor`). Undone scans and undo rows do not count. */
export const todayStmt = (db: Db, actorKey: string, since: number) =>
  stmt(
    db,
    `SELECT COUNT(*) AS n FROM scans
     WHERE actor_key = ? AND at >= ? AND outcome = 'ok' AND action_kind != 'undo' AND undone_by IS NULL`,
    [actorKey, since],
  );

/** Event arrivals: every check-in gate of the event that is in or out (`scan_gates_count`). */
export const eventTotalsStmt = (db: Db, orgId: string, mode: Mode, eventId: string) =>
  stmt(
    db,
    `SELECT COUNT(*) AS arrived, COALESCE(SUM(state = 'in'), 0) AS inside FROM scan_gates
     WHERE org_id = ? AND mode = ? AND scope = ? AND kind = 'check_in' AND state IN ('in', 'out')`,
    [orgId, mode, `event:${eventId}`],
  );

export const eventCacheStmt = (db: Db, orgId: string, eventId: string) =>
  stmt(db, 'SELECT expected, expected_at FROM scan_events WHERE id = ? AND org_id = ?', [
    eventId,
    orgId,
  ]);

export const managersStmt = (db: Db, orgId: string) =>
  stmt(
    db,
    `SELECT EXISTS (SELECT 1 FROM scan_staff
       WHERE org_id = ? AND role = 'manager' AND disabled_at IS NULL) AS has`,
    [orgId],
  );

const INPUT_NAME = /^[A-Za-z0-9_]{1,64}$/;

/** Passes that could arrive: active, not removed, of the event's templates and match rule. */
export async function expectedCount(
  db: Db,
  event: { orgId: string; mode: Mode; matchInput: string | null; matchValues: string | null },
  templateIds: readonly string[],
): Promise<number> {
  if (templateIds.length === 0) return 0;
  const values = event.matchValues ? (JSON.parse(event.matchValues) as unknown[]).map(String) : [];
  const match =
    event.matchInput && INPUT_NAME.test(event.matchInput) && values.length > 0
      ? ` AND CAST(json_extract(personalization, ?) AS TEXT) IN (${placeholders(values.length)})`
      : '';
  const row = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM passes
     WHERE org_id = ? AND mode = ? AND deleted_at IS NULL AND removed_at IS NULL AND status = 'active'
       AND template_id IN (${placeholders(templateIds.length)})${match}`,
    [
      event.orgId,
      event.mode,
      ...templateIds,
      ...(match ? [`$.${event.matchInput}`, ...values] : []),
    ],
  );
  return row?.n ?? 0;
}

export const setExpected = (db: Db, eventId: string, expected: number, at: number) =>
  run(db, 'UPDATE scan_events SET expected = ?, expected_at = ? WHERE id = ?', [
    expected,
    at,
    eventId,
  ]);
