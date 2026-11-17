import type { Mode } from '../../../shared/contracts/common.ts';
import { type PassLineage, passLineagePredicate } from './repo-history-lineage.ts';
import { scopedHistoryPageStmt } from './repo-history-scoped-page.ts';
import { HISTORICAL_SCOPE_SQL } from './repo-scan-history.ts';
import type { ScanPredicate } from './scan-predicate.ts';

/** A last scan whose signed event holds and whose pass was current when it was read. */
export interface LookupHistoryProof {
  readonly scan: { id: string; passId: string; templateId: string | null; at: number };
  readonly lineage: PassLineage;
}

/** The named scans of one tenant that the ledger scope admits, with their events and pass state. */
export function lookupHistoryPageStmt(
  db: D1Database,
  scope: { orgId: string; mode: Mode },
  ids: readonly string[],
  now: number,
): D1PreparedStatement {
  return scopedHistoryPageStmt(
    db,
    {
      sql: `s.org_id = ? AND s.mode = ? AND s.id IN (${ids.map(() => '?/* scan-ephemeral-scan-id */').join(',')})
        AND ${HISTORICAL_SCOPE_SQL}`,
      params: [scope.orgId, scope.mode, ...ids],
      limit: ids.length,
    },
    now,
  );
}

/** The scan is still the pass's, and the pass is still the one the scan was read for. */
export function lookupHistoryPredicate(history: LookupHistoryProof): ScanPredicate {
  const lineage = passLineagePredicate(history.lineage);
  return {
    sql: `(${lineage.sql}) AND EXISTS (SELECT 1 FROM scans s WHERE s.id = ?/* scan-ephemeral-scan-id */
      AND s.pass_id = ?/* scan-ephemeral-pass-id */ AND s.org_id = ? AND s.mode = ? AND s.state = 'done')`,
    params: [
      ...lineage.params,
      history.scan.id,
      history.lineage.passId,
      history.lineage.orgId,
      history.lineage.mode,
    ],
  };
}
