import type { Mode } from '../../../shared/contracts/common.ts';
import { stmt } from '../../platform/db.ts';
import {
  scanLedgerCommonScopeSql,
  scanLedgerScopeSql,
  scanLedgerSuccessfulCandidateSql,
} from './repo-feed-scope.ts';
import { retainedEventCountSql } from './repo-scan-retention.ts';

/** A mutated signed attendance witness cannot regain authority after an ABA. */
const scanCountProofInvalidatedSql = (scan: string) =>
  `EXISTS (SELECT 1 FROM scan_retention_proofs invalidated
    WHERE invalidated.scan_id=${scan}.id AND invalidated.invalidated=1)`;

/** Capacity and arrivals count live passes only: not deleted, removed or voided. */
const livePassSql = (pass: string) =>
  `${pass}.deleted_at IS NULL AND ${pass}.removed_at IS NULL AND ${pass}.status='active'`;

/** SQL expressions and aliases supplied here are trusted application-generated SQL. */
export function liveEventPresenceSql(
  orgSql: string,
  modeSql: string,
  eventSql: string,
  ledgerScopeSql = scanLedgerScopeSql('witness'),
  witnessId = false,
): string {
  return `SELECT presence.pass_id, presence.state${witnessId ? ', witness.id AS witness_id' : ''} FROM scan_presence presence
    JOIN passes member ON member.id=presence.pass_id AND member.org_id=presence.org_id
      AND member.mode=${modeSql} AND ${livePassSql('member')}
    JOIN scans witness ON witness.id=presence.last_scan_id AND witness.org_id=member.org_id
      AND witness.mode=member.mode AND witness.pass_id=member.id AND witness.event_id=${eventSql}
      AND witness.state='done' AND witness.outcome='ok' AND witness.action_kind='check_in'
      AND witness.undone_by IS NULL
      AND ${ledgerScopeSql} AND NOT ${scanCountProofInvalidatedSql('witness')}
      AND ((witness.direction IS NULL AND presence.state='in') OR witness.direction=presence.state)
      AND (witness.presence_scope=presence.scope OR (witness.presence_scope IS NULL AND EXISTS (
        SELECT 1 FROM scan_gates legacy_gate WHERE legacy_gate.pass_id=member.id
          AND legacy_gate.org_id=member.org_id AND legacy_gate.mode=member.mode
          AND legacy_gate.scope=presence.scope AND legacy_gate.kind='check_in'
          AND legacy_gate.last_scan_id=witness.id AND legacy_gate.state IN ('in','out')
      )))
    WHERE presence.org_id=${orgSql} AND presence.scope='event:' || ${eventSql}
    UNION ALL
    SELECT gate.pass_id, gate.state${witnessId ? ', witness.id AS witness_id' : ''} FROM scan_gates gate
    JOIN passes member ON member.id=gate.pass_id AND member.org_id=gate.org_id AND member.mode=gate.mode
      AND member.template_id=gate.template_id AND ${livePassSql('member')}
    JOIN scans witness ON witness.id=gate.last_scan_id AND witness.org_id=member.org_id
      AND witness.mode=member.mode AND witness.pass_id=member.id AND witness.event_id=${eventSql}
      AND witness.state='done' AND witness.outcome='ok' AND witness.action_kind='check_in'
      AND witness.undone_by IS NULL
      AND ${ledgerScopeSql} AND NOT ${scanCountProofInvalidatedSql('witness')}
    WHERE gate.org_id=${orgSql} AND gate.mode=${modeSql} AND gate.scope='event:' || ${eventSql}
      AND gate.kind='check_in' AND gate.state IN ('in','out')
      AND NOT EXISTS (SELECT 1 FROM scan_presence present WHERE present.pass_id=gate.pass_id
        AND present.org_id=gate.org_id AND present.scope=gate.scope)`;
}

/** Correlated scalar occupancy. Inputs must be trusted SQL expressions, not untrusted data. */
export function eventOccupancySql(
  orgSql: string,
  modeSql: string,
  eventSql: string,
  inside: boolean,
): string {
  const filter = inside ? " WHERE occupancy.state='in'" : '';
  return `((SELECT COUNT(DISTINCT occupancy.pass_id) FROM (${liveEventPresenceSql(orgSql, modeSql, eventSql)}) occupancy${filter})
    + ${retainedEventCountSql(orgSql, modeSql, eventSql, inside)})`;
}
/** Whether a live pass is already in the same event population used by occupancy. */
export function eventHasPassSql(
  orgSql: string,
  modeSql: string,
  eventSql: string,
  passIdSql: string,
  inside: boolean,
): string {
  return `EXISTS (SELECT 1 FROM (${liveEventPresenceSql(orgSql, modeSql, eventSql)}) occupancy
    WHERE occupancy.pass_id=${passIdSql}${inside ? " AND occupancy.state='in'" : ''})`;
}

/** Historical arrivals and current inside include live presence plus proven retained deletions. */
export const eventTotalsStmt = (db: D1Database, orgId: string, mode: Mode, eventId: string) => {
  const org = '(SELECT org_id FROM scope)';
  const modeScope = '(SELECT mode FROM scope)';
  const event = '(SELECT event_id FROM scope)';
  const witness = `SELECT witness.id AS witness_id FROM scans witness JOIN scope
    ON witness.org_id=scope.org_id AND witness.mode=scope.mode AND witness.event_id=scope.event_id
    WHERE (witness.state='done' AND witness.outcome='ok' AND witness.action_kind='check_in'
      AND witness.undone_by IS NULL AND witness.pass_id IS NOT NULL)`;
  // Stage the same successful-ledger scope separately from presence so SQLite does not
  // expand the full ledger predicate inside both witness arms of the union.
  return stmt(
    db,
    `WITH scope AS MATERIALIZED (SELECT ? AS org_id, ? AS mode, ? AS event_id),
    common AS MATERIALIZED (
      ${witness} AND ${scanLedgerCommonScopeSql('witness')}
    ), candidate AS MATERIALIZED (
      ${witness} AND ${scanLedgerSuccessfulCandidateSql('witness')}
    ), live AS MATERIALIZED (
      ${liveEventPresenceSql(org, modeScope, event, '1', true)}
    ), verified AS MATERIALIZED (
      SELECT live.pass_id, live.state FROM live
      JOIN common USING (witness_id) JOIN candidate USING (witness_id)
    ), totals AS MATERIALIZED (
      SELECT COUNT(DISTINCT verified.pass_id) AS arrived,
        COUNT(DISTINCT CASE WHEN verified.state='in' THEN verified.pass_id END) AS inside
      FROM verified
    )
    SELECT totals.arrived + ${retainedEventCountSql('scope.org_id', 'scope.mode', 'scope.event_id', false)} AS arrived,
      totals.inside + ${retainedEventCountSql('scope.org_id', 'scope.mode', 'scope.event_id', true)} AS inside
    FROM totals CROSS JOIN scope`,
    [orgId, mode, eventId],
  );
};

/** Correlated arrival total for an authorized event list/detail SELECT. */
export function eventArrivedCountSql(eventAlias: string): string {
  return eventOccupancySql(`${eventAlias}.org_id`, `${eventAlias}.mode`, `${eventAlias}.id`, false);
}
