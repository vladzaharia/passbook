import { all, batch, chunk, first, run, stmt } from '../../platform/db.ts';
import type { DayBounds, Period } from './periods.ts';

export interface PeriodRow {
  org_id: string;
  start_ms: number;
  end_ms: number;
  month: string;
  time_zone: string;
  utc_fallback: number;
  covered_to: number;
  recount_closed_at: number | null;
}

const COLS =
  'org_id, start_ms, end_ms, month, time_zone, utc_fallback, covered_to, recount_closed_at';

/** Orgs a minute run looks at at most. */
export const ORG_SLICE = 50;

/**
 * Orgs with work due: no period yet, no next period although this one ends within the horizon, day bounds that
 * stop short of the horizon, or a period whose recount window is due to close. Settled orgs match nothing.
 */
export async function orgsDue(
  db: D1Database,
  now: number,
  horizonMs: number,
  limit = ORG_SLICE,
): Promise<string[]> {
  const rows = await all<{ id: string }>(
    db,
    `SELECT o.id FROM orgs o
     WHERE o.purged_at IS NULL AND o.closed_at IS NULL AND (
       NOT EXISTS (SELECT 1 FROM usage_periods p WHERE p.org_id = o.id)
       OR EXISTS (SELECT 1 FROM usage_periods p WHERE p.org_id = o.id AND (
         (p.end_ms <= ?1 + ?2 AND NOT EXISTS (SELECT 1 FROM usage_periods n WHERE n.org_id = p.org_id AND n.start_ms = p.end_ms))
         OR (p.end_ms > ?1 AND p.start_ms <= ?1 + ?2 AND p.covered_to < MIN(p.end_ms, ?1 + ?2))
         OR (p.recount_closed_at IS NULL AND EXISTS (SELECT 1 FROM usage_periods n
             WHERE n.org_id = p.org_id AND n.start_ms = p.end_ms AND n.end_ms <= ?1)))))
     ORDER BY o.id LIMIT ?3`,
    [now, horizonMs, limit],
  );
  return rows.map((r) => r.id);
}

export const latestPeriod = (db: D1Database, orgId: string): Promise<PeriodRow | null> =>
  first<PeriodRow>(
    db,
    `SELECT ${COLS} FROM usage_periods WHERE org_id = ? ORDER BY start_ms DESC LIMIT 1`,
    [orgId],
  );

/** The period holding the instant, if one was created. */
export const periodRowAt = (db: D1Database, orgId: string, ms: number): Promise<PeriodRow | null> =>
  first<PeriodRow>(
    db,
    `SELECT ${COLS} FROM usage_periods WHERE org_id = ? AND start_ms <= ? AND end_ms > ?`,
    [orgId, ms, ms],
  );

/** Periods that end after `from` and start before `to`. */
export const periodRowsBetween = (
  db: D1Database,
  orgId: string,
  from: number,
  to: number,
): Promise<PeriodRow[]> =>
  all<PeriodRow>(
    db,
    `SELECT ${COLS} FROM usage_periods WHERE org_id = ? AND end_ms > ? AND start_ms < ? ORDER BY start_ms`,
    [orgId, from, to],
  );

/** Creates the period unless a concurrent run did. */
export async function insertPeriod(
  db: D1Database,
  orgId: string,
  p: Period,
  zone: string,
  utcFallback: boolean,
  now: number,
): Promise<void> {
  await run(
    db,
    `INSERT OR IGNORE INTO usage_periods (org_id, start_ms, end_ms, month, time_zone, utc_fallback, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [orgId, p.startMs, p.endMs, p.month, zone, utcFallback ? 1 : 0, now],
  );
}

/** Stores the days and moves the period's `covered_to` up to the last one's end, in one batch. */
export async function insertDays(
  db: D1Database,
  orgId: string,
  periodStart: number,
  days: readonly DayBounds[],
): Promise<void> {
  const last = days[days.length - 1];
  if (!last) return;
  const stmts = chunk(days, 30).map((part) =>
    stmt(
      db,
      `INSERT OR IGNORE INTO usage_day_bounds (org_id, local_day, start_ms, end_ms)
       SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]')
       FROM json_each(?)`,
      [orgId, JSON.stringify(part.map((d) => [d.localDay, d.startMs, d.endMs]))],
    ),
  );
  stmts.push(
    stmt(
      db,
      'UPDATE usage_periods SET covered_to = MAX(covered_to, ?) WHERE org_id = ? AND start_ms = ?',
      [last.endMs, orgId, periodStart],
    ),
  );
  await batch(db, stmts);
}

/** Closes the recount window of every period whose following period has ended. */
export async function closeRecounts(db: D1Database, orgId: string, now: number): Promise<number> {
  const { changes } = await run(
    db,
    `UPDATE usage_periods SET recount_closed_at = ?
     WHERE org_id = ? AND recount_closed_at IS NULL AND EXISTS (SELECT 1 FROM usage_periods n
       WHERE n.org_id = usage_periods.org_id AND n.start_ms = usage_periods.end_ms AND n.end_ms <= ?)`,
    [now, orgId, now],
  );
  return changes;
}

/** The meter's total over the local days of a period (`YYYY-MM`). */
export async function sumDaily(
  db: D1Database,
  orgId: string,
  meter: string,
  month: string,
): Promise<number> {
  const row = await first<{ total: number }>(
    db,
    `SELECT COALESCE(SUM(d.quantity), 0) AS total FROM usage_daily d
     WHERE d.org_id = ? AND d.meter = ? AND d.local_day >= ? AND d.local_day < ?`,
    [orgId, meter, `${month}-01`, `${month}-32`],
  );
  return row?.total ?? 0;
}
