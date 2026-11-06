import type { SqlValue } from '../../platform/db.ts';
import type { AdmissionPlan } from './admission-types.ts';

/** This predicate runs inside the winning gate statement, alongside capacity and repeat checks. */
export function admissionPredicate(orgId: string, passId: string, p?: AdmissionPlan) {
  const conditions = ['1'];
  const params: SqlValue[] = [];
  if (p?.tracked) {
    conditions.push(
      "COALESCE((SELECT last_scan_id FROM scan_presence WHERE org_id=? AND pass_id=? AND scope=?),'')=?",
    );
    params.push(orgId, passId, p.scope, p.previousScanId ?? '');
  }
  if (p?.limited && p.state.direction === 'in') {
    conditions.push(
      'NOT EXISTS (SELECT 1 FROM scan_presence WHERE org_id=? AND pass_id=? AND scope=? AND last_entry_at>=?)',
    );
    params.push(orgId, passId, p.scope, p.limitSince ?? 0);
    conditions.push(`NOT EXISTS (SELECT 1 FROM scans WHERE org_id=? AND pass_id=?
      AND (? IS NULL OR event_id=?) AND outcome='ok' AND action_kind='check_in'
      AND (direction IS NULL OR direction='in') AND undone_by IS NULL AND at>=?)`);
    params.push(orgId, passId, p.event?.id ?? null, p.event?.id ?? null, p.limitSince ?? 0);
  }
  return { sql: conditions.join(' AND '), params };
}
