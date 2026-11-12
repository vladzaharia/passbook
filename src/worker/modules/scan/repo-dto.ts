import { stmt } from '../../platform/db.ts';
import type { Found } from './resolve.ts';

/** Read image names and branding alongside the original card history and gates. */
export function cardAssetStmt(db: D1Database, found: Found): D1PreparedStatement {
  return stmt(
    db,
    `SELECT o.branding,
      (SELECT json_group_array(name) FROM
        (SELECT name FROM pass_assets WHERE pass_id=? ORDER BY name)) AS asset_names
    FROM passes p JOIN orgs o ON o.id=p.org_id
    WHERE p.id=? AND p.org_id=? AND p.mode=? AND p.image_generation IS ?
      AND o.access_revision IS ?`,
    [
      found.pass.id,
      found.pass.id,
      found.pass.orgId,
      found.pass.mode,
      found.pass.imageGeneration,
      found.orgRevision,
    ],
  );
}
