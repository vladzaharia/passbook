import { first } from '../../platform/db.ts';

export async function effectCounts(db: D1Database, scanId: string, passId: string) {
  return first(
    db,
    `SELECT
    (SELECT count(*) FROM scans WHERE id=?) AS scans, (SELECT count(*) FROM scan_gates WHERE pass_id=?) AS gates,
    (SELECT count(*) FROM scan_presence WHERE pass_id=?) AS presence, (SELECT count(*) FROM pass_events WHERE pass_id=?) AS events,
    (SELECT count(*) FROM scan_asset_grant_provenance) AS grants`,
    [scanId, passId, passId, passId],
  );
}
