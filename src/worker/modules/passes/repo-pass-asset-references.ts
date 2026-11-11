import { first } from '../../platform/db.ts';

/** Every persistent R2 reference which can legitimately point into an asset namespace. */
export const unreferencedPassAssetKeySql = (key: string, includeUploads = true) => `
  NOT EXISTS (SELECT 1 FROM pass_assets a WHERE a.r2_key = ${key})
  AND NOT EXISTS (SELECT 1 FROM member_photos m WHERE m.r2_key = ${key})
  AND NOT EXISTS (SELECT 1 FROM pass_transfer_asset_candidates c WHERE c.r2_key = ${key})
  ${includeUploads ? `AND NOT EXISTS (SELECT 1 FROM pass_transfer_asset_uploads u WHERE u.r2_key = ${key})` : ''}
  AND NOT EXISTS (SELECT 1 FROM passes p WHERE p.object_key = ${key})
  AND NOT EXISTS (SELECT 1 FROM pass_versions v WHERE v.object_key = ${key})
  AND NOT EXISTS (SELECT 1 FROM template_imports i WHERE i.object_key = ${key})
  AND NOT EXISTS (SELECT 1 FROM template_version_extras e WHERE e.r2_key = ${key})
  AND NOT EXISTS (SELECT 1 FROM template_versions tv, json_tree(tv.assets) j
    WHERE j.key = 'key' AND j.type = 'text' AND j.value = ${key})
  AND NOT EXISTS (SELECT 1 FROM pass_issuance_deliveries i
    WHERE i.source_object_key = ${key} OR i.target_object_key = ${key})`;

/** Preflight only: the INSERT/UPDATE triggers remain the actual commit-time write fence. */
export async function isPassAssetKeyAvailable(db: D1Database, key: string): Promise<boolean> {
  return (
    (await first(
      db,
      `SELECT 1 WHERE NOT EXISTS
    (SELECT 1 FROM pass_transfer_asset_gc gc WHERE gc.r2_key = ?1) AND ${unreferencedPassAssetKeySql('?1')}`,
      [key],
    )) !== null
  );
}
