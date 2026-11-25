import { all } from '../../platform/db.ts';

/** The tracked places (zones, events) a pass is in now. */
export async function insidePlaces(
  db: D1Database,
  orgId: string,
  passId: string,
): Promise<string[]> {
  const rows = await all<{ scope: string }>(
    db,
    `SELECT scope FROM scan_presence
     WHERE pass_id = ? AND org_id = ? AND state = 'in' AND (scope LIKE 'zone:%' OR scope LIKE 'event:%')`,
    [passId, orgId],
  );
  return rows.map((r) => r.scope);
}
