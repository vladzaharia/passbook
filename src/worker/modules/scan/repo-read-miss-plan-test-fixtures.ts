import { first } from '../../platform/db.ts';

export function readMissCandidates(orgId: string, mode: 'live' | 'test', query: string) {
  return {
    sql: `EXISTS (SELECT 1 FROM passes p WHERE p.org_id=? AND p.mode=?
      AND p.external_id=?/* scan-ephemeral-external-id */)`,
    params: [orgId, mode, query],
  };
}

export function readMissCounter(db: D1Database, key: string, window: number) {
  return first<{ count: number }>(db, 'SELECT count FROM counters WHERE key=? AND window_start=?', [
    key,
    window,
  ]);
}

export function readMissAuditCount(db: D1Database, scannerId: string) {
  return first<{ count: number }>(
    db,
    "SELECT COUNT(*) AS count FROM audit_log WHERE action='scan.misses_capped' AND actor_id=?",
    [scannerId],
  );
}
