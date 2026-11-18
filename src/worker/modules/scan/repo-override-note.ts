import { stmt } from '../../platform/db.ts';

/** Another scan holds this one: the same condition as `scans_override_once`, a pending claim included. */
export const overrideTakenStmt = (db: D1Database, overrideOf: string) =>
  stmt(
    db,
    `SELECT 1 AS taken FROM scans WHERE override_of = ? AND undone_at IS NULL AND state <> 'failed'
       AND (outcome IS NULL OR outcome = 'ok') LIMIT 1`,
    [overrideOf],
  );
