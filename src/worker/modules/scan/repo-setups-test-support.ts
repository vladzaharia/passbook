import { stmt } from '../../platform/db.ts';

/** Test fixture: a raw watch list write for a scanner whose org is known. Production writes go through `addSetupWatch`. */
export const setSetupWatchStmt = (
  db: D1Database,
  orgId: string,
  scannerId: string,
  watch: unknown,
) =>
  stmt(
    db,
    `INSERT INTO scanner_setups(scanner_id,org_id,mode,watch)
    SELECT id,org_id,mode,? FROM scanners WHERE org_id=? AND id=?
    ON CONFLICT(scanner_id) DO UPDATE SET watch=excluded.watch`,
    [watch ? JSON.stringify(watch) : null, orgId, scannerId],
  );
