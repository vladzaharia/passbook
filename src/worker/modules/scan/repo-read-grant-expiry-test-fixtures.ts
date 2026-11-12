import { first } from '../../platform/db.ts';

export function hasAssetGrantInsert(sql: readonly string[]) {
  return sql.some((text) => text.includes('INSERT OR IGNORE INTO scan_asset_grant_provenance'));
}

export async function countAssetGrants(db: D1Database, orgId: string) {
  return (
    await first<{ n: number }>(
      db,
      'SELECT COUNT(*) AS n FROM scan_asset_grant_provenance WHERE org_id=?',
      [orgId],
    )
  )?.n;
}
