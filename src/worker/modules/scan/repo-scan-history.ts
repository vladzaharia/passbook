import { all, type SqlValue, stmt } from '../../platform/db.ts';
import type { ScanActor } from './actor.ts';
import { scanLedgerScopeSql } from './repo-feed-scope.ts';
import { projectionAuthority, summaryAuthority } from './repo-history-authority.ts';
import {
  type HistoryProofFence,
  historyProofSnapshotPredicates,
} from './repo-history-proof-cas.ts';
import {
  type HistoryEventSnapshot,
  minimalHistoryAuthorityPredicate,
  packedScanAuthorityPredicate,
} from './repo-session-authority.ts';

type Db = D1Database;
export type HistoryCsrfFence = { sql: string; params: readonly SqlValue[] };

export interface RecentRow {
  id: string;
  at: number;
  outcome: 'ok' | 'heads_up' | 'refused';
  reason: string | null;
  action_id: string | null;
  action_kind: string | null;
  template_id: string | null;
  pass_id: string | null;
  event_id: string | null;
  scanner_id: string | null;
  pass_version: number | null;
  projection_authorized: number;
  undone_by: string | null;
}

/** Actor-scoped ledger rows; canonical tombstone, quarantine and issuance rules apply before paging. */
export const HISTORICAL_SCOPE_SQL = scanLedgerScopeSql('s');

export interface HistoryPassScope {
  orgId: string;
  mode: ScanActor['mode'];
  passId: string;
  templateId: string;
  eventId: string | null;
}

/** The same pass-scoped ledger selection is used for discovery, counts and final checks. */
export function historyPassScopePredicate(
  scope: HistoryPassScope,
  until: number,
): { sql: string; params: SqlValue[] } {
  return {
    sql: `s.org_id=? AND s.mode=? AND s.pass_id=?/* scan-ephemeral-pass-id */
      AND s.template_id=?/* scan-ephemeral-template-id */ AND s.at<=?
      AND s.state='done' AND s.outcome='ok' AND s.undone_by IS NULL AND s.action_kind IS NOT 'undo'
      AND ${HISTORICAL_SCOPE_SQL}${scope.eventId !== null ? ' AND s.event_id=?/* scan-ephemeral-event-id */' : ''}`,
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

/** Capture referenced event revisions in bounded pages before the final history SELECT. */
export async function historyEventSnapshots(
  db: Db,
  actor: ScanActor,
  from?: number,
  to?: number,
): Promise<HistoryEventSnapshot[]> {
  const events: HistoryEventSnapshot[] = [];
  let after = '';
  for (;;) {
    const rows = await all<{
      id: string;
      org_id: string;
      mode: HistoryEventSnapshot['mode'];
      updated_at: number;
      archived_at: number | null;
    }>(
      db,
      `SELECT DISTINCT e.id,e.org_id,e.mode,e.updated_at,e.archived_at
      FROM scans s JOIN scan_events e ON e.id=s.event_id AND e.org_id=s.org_id AND e.mode=s.mode
      WHERE s.actor_key=?/* scan-ephemeral-actor-key */ AND s.org_id=? AND s.mode=? AND s.state='done'
        AND e.archived_at IS NULL AND e.id>?/* scan-ephemeral-event-id */
        ${from !== undefined ? 'AND s.at>=?' : ''} ${to !== undefined ? 'AND s.at<=?' : ''}
      ORDER BY e.id LIMIT 100`,
      [
        actor.actorKey,
        actor.orgId,
        actor.mode,
        after,
        ...(from !== undefined ? [from] : []),
        ...(to !== undefined ? [to] : []),
      ],
    );
    for (const row of rows)
      events.push({
        id: row.id,
        orgId: row.org_id,
        mode: row.mode,
        updatedAt: row.updated_at,
        archivedAt: row.archived_at,
      });
    if (rows.length < 100) return events;
    const last = rows[rows.length - 1];
    if (last === undefined) throw new TypeError('Missing last history event');
    after = last.id;
  }
}

/** The actor's latest scope-eligible scans; unavailable policies are projected minimally. */
export function recentScansStmt(
  db: Db,
  actor: ScanActor,
  limit: number,
  now: number,
  events: readonly HistoryEventSnapshot[],
  csrf: HistoryCsrfFence,
  before?: { at: number; id: string },
): D1PreparedStatement {
  const minimal = minimalHistoryAuthorityPredicate(actor, now, { scanAlias: 's', events });
  const authority = packedScanAuthorityPredicate(actor, minimal);
  const projection = projectionAuthority(actor, now);
  const cursor = before ? [before.at, before.at, before.id] : [];
  return stmt(
    db,
    `SELECT s.id, s.at, s.outcome, s.reason, s.action_id, s.action_kind, s.template_id,
       s.pass_id, s.undone_by, s.event_id, s.scanner_id, s.pass_version,
       CASE WHEN ${projection.sql} THEN 1 ELSE 0 END AS projection_authorized
     FROM scans s LEFT JOIN passes p ON p.id=s.pass_id
     WHERE s.actor_key = ?/* scan-ephemeral-actor-key */ AND s.org_id = ? AND s.mode = ? AND s.state = 'done'
       AND ${HISTORICAL_SCOPE_SQL}
       AND (${authority.sql})
      AND (${csrf.sql})
       ${before ? 'AND (s.at < ? OR (s.at = ? AND s.id < ?/* scan-ephemeral-scan-id */))' : ''}
     ORDER BY s.at DESC, s.id DESC LIMIT ?`,
    [
      ...projection.params,
      actor.actorKey,
      actor.orgId,
      actor.mode,
      ...authority.params,
      ...csrf.params,
      ...cursor,
      limit,
    ],
  );
}

export async function recentScans(
  db: Db,
  actor: ScanActor,
  limit: number,
  now: number,
  events: readonly HistoryEventSnapshot[],
  csrf: HistoryCsrfFence,
): Promise<RecentRow[]> {
  return (await recentScansStmt(db, actor, limit, now, events, csrf).all<RecentRow>()).results;
}

export interface SummaryCandidate {
  id: string;
  action_id: string | null;
  action_kind: string | null;
  amount: number | null;
  before_value: string | null;
  after_value: string | null;
  projection_authorized: number;
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

export interface SummaryActionCount {
  action_id: string | null;
  n: number;
  projection_authorized: number;
}

/** Read action contributors in bounded keyset pages; never aggregate a scan snapshot array. */
export function summaryCandidateReader(
  db: Db,
  actor: ScanActor,
  from: number,
  to: number,
  now: number,
  events: readonly HistoryEventSnapshot[],
  csrf: HistoryCsrfFence,
): (after: string) => Promise<SummaryCandidate[]> {
  const authority = summaryAuthority(actor, from, to, now, events, csrf, HISTORICAL_SCOPE_SQL);
  const projection = projectionAuthority(actor, now);
  const sql = `SELECT s.id,s.action_id,s.action_kind,s.amount,s.before_value,s.after_value,
      CASE WHEN ${projection.sql} THEN 1 ELSE 0 END AS projection_authorized
    FROM scans s LEFT JOIN passes p ON p.id=s.pass_id
    WHERE ${authority.sql} AND s.outcome='ok' AND s.undone_by IS NULL AND s.id>?/* scan-ephemeral-scan-id */
    ORDER BY s.id LIMIT 100`;
  const params = [...projection.params, ...authority.params];
  return async (after) => (await stmt(db, sql, [...params, after]).all<SummaryCandidate>()).results;
}

/** Current aggregate totals are computed atomically with the final contributor proof CAS. */
export function summaryTotalsStmt(
  db: Db,
  actor: ScanActor,
  from: number,
  to: number,
  now: number,
  events: readonly HistoryEventSnapshot[],
  csrf: HistoryCsrfFence,
): D1PreparedStatement {
  const authority = summaryAuthority(actor, from, to, now, events, csrf, HISTORICAL_SCOPE_SQL);
  return stmt(
    db,
    `SELECT COUNT(*) AS total,
      COALESCE(SUM(s.outcome='ok'),0) AS ok,
      COALESCE(SUM(s.outcome='heads_up'),0) AS heads_up,
      COALESCE(SUM(s.outcome IS NOT 'ok' AND s.outcome IS NOT 'heads_up'),0) AS refused,
      COALESCE(SUM(s.undone_by IS NOT NULL),0) AS undone,
      MIN(s.at) AS first_at,MAX(s.at) AS last_at
    FROM scans s LEFT JOIN passes p ON p.id=s.pass_id WHERE ${authority.sql}`,
    authority.params,
  );
}

/** Final group counts detect added/removed contributors before any action bucket is returned. */
export function summaryActionCountsStmt(
  db: Db,
  actor: ScanActor,
  from: number,
  to: number,
  now: number,
  events: readonly HistoryEventSnapshot[],
  csrf: HistoryCsrfFence,
): D1PreparedStatement {
  const authority = summaryAuthority(actor, from, to, now, events, csrf, HISTORICAL_SCOPE_SQL);
  const projection = projectionAuthority(actor, now);
  return stmt(
    db,
    `SELECT s.action_id,COUNT(*) AS n,
      MIN(CASE WHEN ${projection.sql} THEN 1 ELSE 0 END) AS projection_authorized
    FROM scans s LEFT JOIN passes p ON p.id=s.pass_id
    WHERE ${authority.sql} AND s.outcome='ok' AND s.undone_by IS NULL
    GROUP BY s.action_id ORDER BY s.action_id`,
    [...projection.params, ...authority.params],
  );
}

export interface HistoryProofFenceStmt {
  scanId: string;
  statement: D1PreparedStatement;
}

/** Every fragment shares the final actor/assignment read's D1 transaction. */
export function historyProofFenceStmts(
  db: Db,
  actor: ScanActor,
  now: number,
  events: readonly HistoryEventSnapshot[],
  proofPages: readonly (readonly HistoryProofFence[])[],
  csrf: HistoryCsrfFence,
  summaryWindow?: { from: number; to: number },
): HistoryProofFenceStmt[] {
  const statements: HistoryProofFenceStmt[] = [];
  const eventById = new Map(events.map((event) => [event.id, event]));
  const projection = projectionAuthority(actor, now);
  for (const page of proofPages) {
    for (const proof of page) {
      const event = proof.scan.eventId === null ? undefined : eventById.get(proof.scan.eventId);
      const minimal = minimalHistoryAuthorityPredicate(actor, now, {
        scanAlias: 's',
        events: event ? [event] : [],
      });
      const authority = packedScanAuthorityPredicate(actor, minimal);
      const fragments =
        actor.credentialKeysetCommitment === undefined ||
        proof.credentialKeysetCommitment === actor.credentialKeysetCommitment
          ? historyProofSnapshotPredicates(proof, 's', now)
          : [{ sql: '0', params: [] }];
      for (const fragment of fragments) {
        statements.push({
          scanId: proof.scan.id,
          statement: stmt(
            db,
            `SELECT s.id,s.action_id FROM scans s LEFT JOIN passes p ON p.id=s.pass_id
            WHERE s.id=?/* scan-ephemeral-scan-id */ AND s.state='done'
              ${summaryWindow ? "AND s.outcome='ok' AND s.undone_by IS NULL AND s.action_id IS NOT NULL AND s.action_kind IS NOT 'undo' AND s.at>=? AND s.at<=?" : ''}
              AND ${HISTORICAL_SCOPE_SQL} AND (${authority.sql}) AND (${projection.sql})
              AND (${fragment.sql}) AND (${csrf.sql})`,
            [
              proof.scan.id,
              ...(summaryWindow ? [summaryWindow.from, summaryWindow.to] : []),
              ...authority.params,
              ...projection.params,
              ...fragment.params,
              ...csrf.params,
            ],
          ),
        });
      }
    }
  }
  return statements;
}
