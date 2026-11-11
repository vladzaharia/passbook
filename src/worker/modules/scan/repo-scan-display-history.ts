import { stmt } from '../../platform/db.ts';
import {
  type HistoryProofFence,
  historyProofSnapshotPredicates,
} from './repo-history-proof-cas.ts';
import { type OutputPredicate, outputPredicateStmt } from './repo-output-predicates.ts';

export function displayHistoryAuthorityStmt(
  db: D1Database,
  current: boolean,
  authority: OutputPredicate,
): D1PreparedStatement {
  return outputPredicateStmt(db, current ? authority : { sql: '0', params: [] });
}

export function displayHistoryCountsStmt(
  db: D1Database,
  scope: OutputPredicate,
  today: number,
): D1PreparedStatement {
  return stmt(
    db,
    `SELECT count(*) AS n,COALESCE(SUM(s.at>=?),0) AS today
          FROM scans s LEFT JOIN passes p ON p.id=s.pass_id WHERE ${scope.sql}`,
    [today, ...scope.params],
  );
}

export function displayHistoryTopStmt(db: D1Database, scope: OutputPredicate): D1PreparedStatement {
  return stmt(
    db,
    `SELECT s.id FROM scans s LEFT JOIN passes p ON p.id=s.pass_id
          WHERE ${scope.sql} ORDER BY s.at DESC,s.id DESC LIMIT 3`,
    scope.params,
  );
}

export function displayHistoryProofPredicates(
  proof: HistoryProofFence,
  commitment: string,
  now: number,
): OutputPredicate[] {
  return proof.credentialKeysetCommitment === commitment
    ? historyProofSnapshotPredicates(proof, 's', now)
    : [{ sql: '0', params: [] }];
}

export function displayHistoryProofStmt(
  db: D1Database,
  scope: OutputPredicate,
  scanId: string,
  fence: OutputPredicate,
): D1PreparedStatement {
  return stmt(
    db,
    `SELECT s.id FROM scans s LEFT JOIN passes p ON p.id=s.pass_id
              WHERE ${scope.sql} AND s.id=?/* scan-ephemeral-scan-id */ AND (${fence.sql})`,
    [...scope.params, scanId, ...fence.params],
  );
}
