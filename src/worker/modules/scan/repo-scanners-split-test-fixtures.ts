import { all, run } from '../../platform/db.ts';

export async function clearScannerFixtureState(db: D1Database) {
  await run(db, 'DELETE FROM audit_log');
  await run(db, 'DELETE FROM counters');
}

export async function scannerAuditActions(db: D1Database) {
  return (await all<{ action: string }>(db, 'SELECT action FROM audit_log ORDER BY id')).map(
    (r) => r.action,
  );
}
