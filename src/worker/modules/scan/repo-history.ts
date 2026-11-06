import type { ScanDisplayNeeds } from '../../../passkit/template/scan-display/index.ts';
import { stmt } from '../../platform/db.ts';
import { localDay, localDayStart } from './counts.ts';
import type { HistoryReader } from './display.ts';

interface HistoryRow {
  at: number;
  where: string;
  label: string;
  action_kind: string;
  amount: number | null;
  after_value: string | null;
}

export function planHistory(
  db: D1Database,
  needs: ScanDisplayNeeds,
  scope: { passId: string; orgId: string; timeZone: string; now: number },
): HistoryReader {
  if (!needs.history.length && !needs.ledger.length) return { stmts: [], read: () => ({}) };
  const today = localDayStart(scope.now, scope.timeZone);
  const date = localDay(scope.now, scope.timeZone);
  const [year = 1970, month = 1, day = 1] = date.split('-').map(Number);
  const calendarStart = (m: number, d: number) => {
    const rough = Date.UTC(year, m - 1, d, 12);
    return localDayStart(rough, scope.timeZone);
  };
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const week = calendarStart(month, day - ((weekday + 6) % 7));
  const startMonth = calendarStart(month, 1);
  const startYear = calendarStart(1, 1);
  const base =
    "org_id = ? AND pass_id = ? AND state = 'done' AND outcome = 'ok' AND undone_by IS NULL AND action_kind <> 'undo'";
  const params = [scope.orgId, scope.passId];
  const aggregate = stmt(
    db,
    `SELECT count(*) AS total, coalesce(sum(at >= ?), 0) AS today,
    coalesce(sum(action_kind = 'check_in'), 0) AS visits,
    coalesce(sum(action_kind = 'check_in' AND at >= ?), 0) AS visits_today,
    coalesce(sum(action_kind = 'check_in' AND at >= ?), 0) AS visits_week,
    coalesce(sum(action_kind = 'check_in' AND at >= ?), 0) AS visits_month,
    coalesce(sum(action_kind = 'check_in' AND at >= ?), 0) AS visits_year
    FROM scans WHERE ${base}`,
    [today, today, week, startMonth, startYear, ...params],
  );
  const list = (visits: boolean) =>
    stmt(
      db,
      `SELECT s.at, coalesce(sc.name, 'Console') AS "where",
      s.action_id AS label, s.action_kind, s.amount, s.after_value
    FROM scans s LEFT JOIN scanners sc ON sc.id = s.scanner_id
    WHERE s.org_id = ? AND s.pass_id = ? AND s.state = 'done' AND s.outcome = 'ok'
      AND s.undone_by IS NULL AND s.action_kind ${visits ? "= 'check_in'" : "<> 'undo'"}
    ORDER BY s.at DESC, s.id DESC LIMIT 3`,
      params,
    );
  return {
    stmts: [aggregate, list(true), list(false)],
    read(results) {
      const counts = results[0]?.results[0] as Record<string, number> | undefined;
      const visits = (results[1]?.results ?? []) as unknown as HistoryRow[];
      const scans = (results[2]?.results ?? []) as unknown as HistoryRow[];
      const entry = (row: HistoryRow) => ({
        at: row.at,
        where: row.where,
        label: row.action_kind === 'check_in' ? 'Check in' : row.label,
      });
      return {
        visits: {
          today: counts?.visits_today ?? 0,
          week: counts?.visits_week ?? 0,
          month: counts?.visits_month ?? 0,
          year: counts?.visits_year ?? 0,
          total: counts?.visits ?? 0,
        },
        scans: { today: counts?.today ?? 0, total: counts?.total ?? 0 },
        lastVisit: visits[0] ? entry(visits[0]) : null,
        lastScan: scans[0] ? { ...entry(scans[0]), action: entry(scans[0]).label } : null,
        list: { visits: visits.map(entry), scans: scans.map(entry), value: {} },
        ledger: {},
      };
    },
  };
}
