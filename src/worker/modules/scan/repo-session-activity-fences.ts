import { type SqlValue, stmt } from '../../platform/db.ts';
import {
  type HistoryProofFence,
  historyProofSnapshotPredicates,
} from './repo-history-proof-cas.ts';
import type { OutputPredicate } from './repo-output-predicates.ts';
import type { ScanningSessionRow } from './repo-scanning-sessions.ts';

export function activityScopedGuardPredicate(
  guard: OutputPredicate,
  scope: OutputPredicate,
): { sql: string; params: SqlValue[] } {
  return { sql: `(${guard.sql}) AND (${scope.sql})`, params: [...guard.params, ...scope.params] };
}

export function activityProofPredicates(proof: HistoryProofFence, now: number): OutputPredicate[] {
  return historyProofSnapshotPredicates(proof, 's', now);
}

export function activityProofFenceStmt(
  db: D1Database,
  row: ScanningSessionRow,
  scanId: string,
  predicate: OutputPredicate,
): D1PreparedStatement {
  return stmt(
    db,
    `SELECT s.id FROM scans s
        WHERE s.id=?/* scan-ephemeral-scan-id */ AND s.org_id=? AND s.mode=? AND (${predicate.sql})`,
    [scanId, row.org_id, row.mode, ...predicate.params],
  );
}

export function activityStandaloneStatusStmt(
  db: D1Database,
  guard: OutputPredicate,
): D1PreparedStatement {
  return stmt(db, `SELECT (${guard.sql}) AS authorized`, guard.params);
}
