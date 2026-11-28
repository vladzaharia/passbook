import { all, first } from '../../platform/db.ts';

export function scanGateRows(db: D1Database, passId: string) {
  return all<{ pass_id: string }>(db, 'SELECT pass_id FROM scan_gates WHERE pass_id=?', [passId]);
}

export function scanEventIds(db: D1Database, passId: string) {
  return all<{ id: string }>(
    db,
    "SELECT id FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'",
    [passId],
  );
}

export function scanByIdempotencyKey(db: D1Database, idempotencyKey: string) {
  return first<{ state: string; outcome: string | null }>(
    db,
    'SELECT state,outcome FROM scans WHERE idempotency_key=?',
    [idempotencyKey],
  );
}

export function retiredCredentialTombstone(db: D1Database, passId: string, ref: string) {
  return first<{ pass_id: string }>(
    db,
    `SELECT pass_id FROM pass_credential_tombstones
    WHERE pass_id=? AND credential_hash=?`,
    [passId, ref],
  );
}

export function originalScanLedger(db: D1Database, passId: string) {
  return all<{ data: string }>(
    db,
    "SELECT data FROM pass_events WHERE pass_id = ? AND kind LIKE 'scan.%'",
    [passId],
  );
}
