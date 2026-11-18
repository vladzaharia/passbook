import { all } from '../../platform/db.ts';

/** The keys of the org's live zones: what an add-on zone on a pass may name. */
export async function activeZoneKeys(db: D1Database, orgId: string): Promise<string[]> {
  const rows = await all<{ key: string }>(
    db,
    'SELECT key FROM scan_zones WHERE org_id = ? AND archived_at IS NULL ORDER BY key LIMIT 1000',
    [orgId],
  );
  return rows.map((r) => r.key);
}
