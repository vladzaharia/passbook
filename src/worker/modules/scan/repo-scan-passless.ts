import type { Mode } from '../../../shared/contracts/common.ts';
import { all, chunk, type SqlValue } from '../../platform/db.ts';
import type { PasslessScan } from './scan-passless.ts';

/** Trusted SQL aliases only. Any pass or action evidence disqualifies a passless row. */
function scanPristinePasslessSql(s: string): string {
  // The ledger scope embeds this predicate in larger queries; group the checks to
  // bound SQLite expression depth without weakening the passless evidence fence.
  return `((${s}.state='done' AND ${s}.outcome='refused' AND ${s}.reason IN ('not_found','ambiguous')
    AND ${s}.pass_id IS NULL AND ${s}.template_id IS NULL AND ${s}.pass_version IS NULL)
    AND (${s}.action_id IS NULL AND ${s}.action_kind IS NULL AND ${s}.direction IS NULL
      AND ${s}.amount IS NULL AND ${s}.before_value IS NULL AND ${s}.after_value IS NULL)
    AND (${s}.override_of IS NULL AND ${s}.approved_by IS NULL AND ${s}.group_id IS NULL
      AND ${s}.offline=0 AND ${s}.notified=0 AND ${s}.undoes IS NULL)
    AND (${s}.undone_by IS NULL AND ${s}.undone_at IS NULL AND ${s}.presence_scope IS NULL
      AND NOT EXISTS (SELECT 1 FROM scan_retention_proofs passless_retention WHERE passless_retention.scan_id=${s}.id)
      AND NOT EXISTS (SELECT 1 FROM scan_retention_delete_intents passless_intent WHERE passless_intent.scan_id=${s}.id)
      AND NOT EXISTS (SELECT 1 FROM scan_retained_gates passless_retained WHERE passless_retained.scan_id=${s}.id)
      AND NOT EXISTS (SELECT 1 FROM scan_quarantine_exclusions passless_quarantine WHERE passless_quarantine.scan_id=${s}.id))
    AND (NOT EXISTS (SELECT 1 FROM pass_events passless_ledger
        WHERE CASE WHEN json_valid(passless_ledger.data) THEN json_extract(passless_ledger.data,'$.scanId') END=${s}.id)
      AND NOT EXISTS (SELECT 1 FROM scan_gates passless_gate
        WHERE passless_gate.last_scan_id=${s}.id OR passless_gate.prev_scan_id=${s}.id)
      AND NOT EXISTS (SELECT 1 FROM scan_presence passless_presence
        WHERE passless_presence.last_scan_id=${s}.id OR passless_presence.prev_scan_id=${s}.id)
      AND NOT EXISTS (SELECT 1 FROM scans passless_link WHERE passless_link.override_of=${s}.id
        OR passless_link.undoes=${s}.id OR passless_link.undone_by=${s}.id)))`;
}

/** Missing or archived original events may be retained, but a current foreign event never is. */
function nonforeignEventSql(s: string): string {
  return `NOT EXISTS (SELECT 1 FROM scan_events passless_event WHERE passless_event.id=${s}.event_id
    AND (passless_event.org_id IS NOT ${s}.org_id OR passless_event.mode IS NOT ${s}.mode))`;
}

/** The scan row alone names a consistent actor; no stored proof is needed. */
function actorFactsSql(s: string): string {
  return `(length(${s}.org_id)>0 AND ${s}.mode IN ('live','test') AND length(${s}.actor_id)>0
    AND (${s}.scanner_id IS NULL OR length(${s}.scanner_id)>0)
    AND ((${s}.actor_type='scanner' AND (${s}.scanner_id IS NULL OR ${s}.scanner_id=${s}.actor_id)
        AND ${s}.actor_key='s:'||${s}.actor_id)
      OR (${s}.actor_type='user' AND ${s}.actor_key='u:'||${s}.actor_id||
        CASE WHEN ${s}.scanner_id IS NULL THEN '' ELSE ':'||${s}.scanner_id END)))`;
}

/** A refused scan that selected no pass, decided from its own row and the absence of pass evidence. */
export function scanPasslessCandidateSql(s: string): string {
  return `(${scanPristinePasslessSql(s)} AND ${nonforeignEventSql(s)} AND ${actorFactsSql(s)})`;
}

/** Read passless scans in scope from the `scans` row; bounded batches. */
export async function readPasslessScans(
  db: D1Database,
  scope: { orgId?: string; mode: Mode },
  scanIds: readonly string[],
): Promise<Map<string, PasslessScan>> {
  const { orgId, mode } = scope;
  const out = new Map<string, PasslessScan>();
  for (const ids of chunk([...new Set(scanIds)], 88)) {
    const rows = await all<{ id: string; orgId: string; mode: Mode; at: number }>(
      db,
      `SELECT s.id,s.org_id AS orgId,s.mode,s.at FROM scans s
      WHERE s.id IN (${ids.map(() => '?/* scan-ephemeral-scan-id */').join(',')}) AND s.mode=?
        ${orgId === undefined ? '' : 'AND s.org_id=?'} AND ${scanPasslessCandidateSql('s')}`,
      [...ids, mode, ...(orgId === undefined ? [] : [orgId])],
    );
    for (const r of rows) out.set(r.id, { scanId: r.id, orgId: r.orgId, mode: r.mode, at: r.at });
  }
  return out;
}

/** Rebind a read passless scan inside the caller's final authority query. */
export function scanPasslessSnapshotPredicate(
  scanAlias: string,
  scan: PasslessScan,
): { sql: string; params: SqlValue[] } {
  return {
    sql: `(${scanPasslessCandidateSql(scanAlias)} AND ${scanAlias}.id=?/* scan-ephemeral-scan-id */
      AND ${scanAlias}.org_id=? AND ${scanAlias}.mode=? AND ${scanAlias}.at=?)`,
    params: [scan.scanId, scan.orgId, scan.mode, scan.at],
  };
}
