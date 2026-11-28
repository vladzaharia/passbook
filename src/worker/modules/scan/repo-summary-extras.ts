import type { SqlValue } from '../../platform/db.ts';
import { HEADS_UP_SQL, REFUSED_SQL } from './outcome-bucket.ts';
import { type ScanReadAuthority, scanAuthorizedStmt, scanRead } from './repo-read-authority.ts';

/** Time reaches the hour bucketing in 15-minute steps: every zone offset is a multiple of that. */
export const QUARTER = 900_000;

export interface SummaryExtras {
  authorized: boolean;
  totals: {
    total: number;
    ok: number;
    heads_up: number;
    refused: number;
    undone: number;
    first_at: number | null;
    last_at: number | null;
  };
  quarters: { q: number; n: number; refused: number }[];
  value: { kind: 'add' | 'take' | 'set' | 'use_up'; n: number; amount: number }[];
  reasons: { reason: string; n: number }[];
  types: { id: string | null; name: string | null; n: number }[];
  staff: {
    staff_id: string | null;
    name: string | null;
    n: number;
    overrides: number;
    refused: number;
  }[];
  overrideCount: number;
  overrides: {
    id: string;
    at: number;
    staff_name: string | null;
    approver: string | null;
    reason: string | null;
  }[];
}

const STAFF_LIMIT = 50;
export const OVERRIDE_LIMIT = 20;

/**
 * The extra tallies of one window in a single snapshot, over the ledger rows `where` selects (the
 * actor's own scans, or a session's devices). Undo rows are never counted.
 */
export async function readSummaryExtras(
  db: D1Database,
  auth: ScanReadAuthority,
  scope: { where: string; params: readonly SqlValue[] },
  window: { from: number; to: number },
): Promise<SummaryExtras> {
  const fromOf = (joins = '') => `FROM ${auth.rows}scans s
    LEFT JOIN scan_staff st ON st.id = s.staff_id AND st.org_id = s.org_id${joins}
    WHERE ${auth.present} AND ${auth.tenantOnce('+s', 'scans')} AND (${scope.where})
      AND (s.at >= ? AND s.at <= ? AND s.action_kind IS NOT 'undo' AND s.outcome IS NOT NULL)`;
  const from = fromOf();
  const params = [...scope.params, window.from, window.to];
  const refused = `COALESCE(SUM(${REFUSED_SQL}), 0)`;
  const [authorized, totals, quarters, value, reasons, types, staff, count, overrides] =
    await db.batch([
      scanAuthorizedStmt(db, auth),
      scanRead(
        db,
        auth,
        `SELECT COUNT(*) AS total, COALESCE(SUM(s.outcome = 'ok'), 0) AS ok,
        COALESCE(SUM(${HEADS_UP_SQL}), 0) AS heads_up, ${refused} AS refused,
        COALESCE(SUM(s.undone_by IS NOT NULL), 0) AS undone,
        MIN(s.at) AS first_at, MAX(s.at) AS last_at ${from}`,
        params,
      ),
      scanRead(
        db,
        auth,
        `SELECT s.at / ${QUARTER} AS q, COUNT(*) AS n, ${refused} AS refused ${from} GROUP BY q ORDER BY q`,
        params,
      ),
      scanRead(
        db,
        auth,
        `SELECT s.action_kind AS kind, COUNT(*) AS n, COALESCE(SUM(s.amount), 0) AS amount ${from}
        AND (s.outcome = 'ok' AND s.undone_by IS NULL
        AND s.action_kind IS NOT NULL AND s.action_kind <> 'check_in') GROUP BY s.action_kind`,
        params,
      ),
      scanRead(
        db,
        auth,
        `SELECT s.reason AS reason, COUNT(*) AS n ${from}
        AND s.outcome IS NOT 'ok' AND s.reason IS NOT NULL GROUP BY s.reason ORDER BY n DESC, s.reason LIMIT 20`,
        params,
      ),
      scanRead(
        db,
        auth,
        `SELECT s.template_id AS id, tt.name AS name, COUNT(*) AS n ${fromOf(`
    LEFT JOIN templates tt ON tt.id = s.template_id AND (tt.org_id IS NULL OR tt.org_id = s.org_id)`)}
        AND s.outcome = 'ok' GROUP BY s.template_id ORDER BY n DESC, tt.name`,
        params,
      ),
      scanRead(
        db,
        auth,
        `SELECT s.staff_id AS staff_id, st.name AS name, COUNT(*) AS n,
        COALESCE(SUM(s.override_of IS NOT NULL), 0) AS overrides, ${refused} AS refused ${from}
        GROUP BY s.staff_id ORDER BY n DESC, s.staff_id LIMIT ${STAFF_LIMIT}`,
        params,
      ),
      scanRead(db, auth, `SELECT COUNT(*) AS n ${from} AND s.override_of IS NOT NULL`, params),
      scanRead(
        db,
        auth,
        `SELECT s.id AS id, s.at AS at, st.name AS staff_name, ap.name AS approver, ov.reason AS reason
        ${fromOf(`
    LEFT JOIN scan_staff ap ON ap.id = s.approved_by AND ap.org_id = s.org_id
    LEFT JOIN scans ov ON ov.id = s.override_of AND ov.org_id = s.org_id`)}
        AND s.override_of IS NOT NULL ORDER BY s.at DESC, s.id DESC LIMIT ${OVERRIDE_LIMIT}`,
        params,
      ),
    ]);
  const ok = (authorized?.results[0] as { authorized: number } | undefined)?.authorized === 1;
  const rows = <T>(r: D1Result | undefined): T[] => (ok ? ((r?.results ?? []) as T[]) : []);
  return {
    authorized: ok,
    totals: (ok ? (totals?.results[0] as SummaryExtras['totals'] | undefined) : undefined) ?? {
      total: 0,
      ok: 0,
      heads_up: 0,
      refused: 0,
      undone: 0,
      first_at: null,
      last_at: null,
    },
    quarters: rows(quarters),
    value: rows(value),
    reasons: rows(reasons),
    types: rows(types),
    staff: rows(staff),
    overrideCount: ok ? ((count?.results[0] as { n: number } | undefined)?.n ?? 0) : 0,
    overrides: rows(overrides),
  };
}
