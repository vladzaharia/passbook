import type { SqlValue } from '../../platform/db.ts';
import type { ScanActor } from './actor.ts';
import type { HistoryRaw, HistoryRow } from './history-row.ts';
import { toHistoryRow } from './history-row.ts';
import { HEADS_UP_SQL } from './outcome-bucket.ts';
import { scanLedgerScopeSql } from './repo-feed-scope.ts';
import { historyPageStmt } from './repo-history-rows.ts';
import { type ScanReadAuthority, scanAuthorizedStmt, scanRead } from './repo-read-authority.ts';

/**
 * What the actor's own history may read beyond a write's checks: a paused session compares its
 * epoch, and an invalid scope is redacted by the caller (`history.ts` projects nothing for either).
 */
export const HISTORY_READ = { pausedSession: true, invalidScope: true } as const;

/** Actor-scoped ledger rows; canonical tombstone, quarantine and issuance rules apply before paging. */
export const HISTORICAL_SCOPE_SQL = scanLedgerScopeSql('s');

export interface HistoryPassScope {
  orgId: string;
  mode: ScanActor['mode'];
  passId: string;
  templateId: string;
  eventId: string | null;
}

/**
 * The same pass-scoped ledger selection is used for discovery, counts and final checks. An Access
 * card's visits are its grants that started one (`visit = 1`); every other scan has no `visit`.
 */
export function historyPassScopePredicate(
  scope: HistoryPassScope,
  until: number,
): { sql: string; params: SqlValue[] } {
  return {
    sql: `s.org_id=? AND s.mode=? AND s.pass_id=?
      AND s.template_id=? AND s.at<=?
      AND s.state='done' AND s.outcome='ok' AND s.undone_by IS NULL AND s.action_kind IS NOT 'undo'
      AND (s.visit IS NULL OR s.visit = 1)
      AND ${HISTORICAL_SCOPE_SQL}${scope.eventId !== null ? ' AND s.event_id=?' : ''}`,
    params: [
      scope.orgId,
      scope.mode,
      scope.passId,
      scope.templateId,
      until,
      ...(scope.eventId !== null ? [scope.eventId] : []),
    ],
  };
}

/** Only a signed-in scanning device or a console actor reads history; a screen has none. */
export function historyReadable(actor: ScanActor): boolean {
  return actor.role !== null && (!actor.scanner || actor.scanner.deviceRole === 'scan');
}

/**
 * Pass-bearing fields are projected only under the actor's strict assignment: not through an
 * invalid scope or a paused session, which the read fence admits for receipts alone.
 */
export function historyProjectable(actor: ScanActor): boolean {
  return (
    actor.role !== null &&
    !actor.invalidScannerScope &&
    !(actor.scanningSession && actor.scanningSession.status !== 'active')
  );
}

/** The actor's own ledger scans, inside the scope its assignment grants now. */
export function ownScansWhere(actor: ScanActor): { sql: string; params: SqlValue[] } {
  const clauses = [
    HISTORICAL_SCOPE_SQL,
    // A scan of an archived or deleted event is no longer the actor's to list.
    `(s.event_id IS NULL OR EXISTS (SELECT 1 FROM scan_events own_event
      WHERE own_event.id = s.event_id AND own_event.org_id = s.org_id AND own_event.mode = s.mode
        AND own_event.archived_at IS NULL))`,
    's.actor_key = ?',
    's.actor_type = ?',
    's.actor_id = ?',
    's.scanner_id IS ?',
  ];
  const params: SqlValue[] = [
    actor.actorKey,
    actor.actor.type,
    actor.actor.id,
    actor.scanner?.id ?? null,
  ];
  const inTemplates = () => {
    clauses.push('(s.template_id IS NULL OR s.template_id IN (SELECT value FROM json_each(?)))');
    params.push(JSON.stringify([...actor.templateIds].sort()));
  };
  if (actor.event) {
    clauses.push('s.event_id IS ?');
    params.push(actor.event.id);
    if (actor.scanner || actor.templateIds.length) inTemplates();
  } else if (actor.templateIds.length) inTemplates();
  else if (actor.scanner && actor.settings.acceptAllTemplates !== true)
    clauses.push('s.template_id IS NULL', 's.event_id IS NULL');
  return { sql: clauses.join(' AND '), params };
}

export interface SummaryTotals {
  total: number;
  ok: number;
  heads_up: number;
  refused: number;
  undone: number;
  first_at: number | null;
  last_at: number | null;
}

/** The contributors one summary reads: past this many, no action bucket is listed. */
export const SUMMARY_CONTRIBUTORS = 500;

/**
 * The summary in one snapshot: whether the actor's fence holds, the totals of the window, and the
 * check-in contributors (one more than the cap, so an overflow is seen) with their history columns.
 */
export async function readSummary(
  db: D1Database,
  auth: ScanReadAuthority,
  actor: ScanActor,
  window: { from: number; to: number },
  now: number,
): Promise<{ authorized: boolean; totals: SummaryTotals | null; rows: HistoryRow[] }> {
  const own = ownScansWhere(actor);
  const inWindow = `${own.sql} AND s.at >= ? AND s.at <= ? AND s.action_kind IS NOT 'undo'`;
  const params = [...own.params, window.from, window.to];
  const [authorized, totals, page] = await db.batch([
    scanAuthorizedStmt(db, auth),
    scanRead(
      db,
      auth,
      `SELECT COUNT(*) AS total,
        COALESCE(SUM(s.outcome = 'ok'), 0) AS ok,
        COALESCE(SUM(${HEADS_UP_SQL}), 0) AS heads_up,
        COALESCE(SUM(s.outcome IS NOT 'ok' AND NOT ${HEADS_UP_SQL}), 0) AS refused,
        COALESCE(SUM(s.undone_by IS NOT NULL), 0) AS undone,
        MIN(s.at) AS first_at, MAX(s.at) AS last_at
      FROM ${auth.rows}scans s WHERE ${auth.present} AND ${auth.tenantOnce('+s', 'scans')} AND ${inWindow}`,
      params,
    ),
    historyPageStmt(
      db,
      auth,
      {
        where: `${inWindow} AND s.outcome = 'ok' AND s.undone_by IS NULL`,
        params,
        limit: SUMMARY_CONTRIBUTORS + 1,
        // The `+` keeps the planner on the actor's own index, not the org's.
        tenant: auth.tenantOnce('+s', 'scans'),
      },
      now,
    ),
  ]);
  const ok = (authorized?.results[0] as { authorized: number } | undefined)?.authorized === 1;
  return {
    authorized: ok,
    totals: ok ? ((totals?.results[0] as SummaryTotals | undefined) ?? null) : null,
    rows: ok ? (page?.results ?? []).map((r) => toHistoryRow(r as unknown as HistoryRaw)) : [],
  };
}
