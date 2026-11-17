import { artHashesOf } from './branding.ts';
import { blueprintAssetsFromResult, sourceBlueprintAssetsStmt } from './repo-blueprint-art.ts';
import { type AssetRow, assetsFromResult, listAssetsStmt } from './repo-history-assets.ts';
import { memberPhotoFromResult, memberPhotoStmt, photoAssetOf } from './repo-member-photo.ts';

/**
 * What a build reads from D1 besides the template: the pass's own assets and member photo (unless
 * the build omits them) and the art of the blueprint the template came from, in one trip.
 */
export async function readBuildInputs(
  db: D1Database,
  req: { passId: string; orgId: string; omitPassAssets?: boolean },
  templateId: string,
): Promise<{ overrides: AssetRow[]; photo: AssetRow | null; artHashes: ReadonlySet<string> }> {
  const withAssets = !req.omitPassAssets;
  const results = await db.batch([
    ...(withAssets
      ? [listAssetsStmt(db, req.passId), memberPhotoStmt(db, req.orgId, req.passId)]
      : []),
    sourceBlueprintAssetsStmt(db, templateId),
  ]);
  const art = results[withAssets ? 2 : 0];
  return {
    overrides: withAssets ? assetsFromResult(results[0]) : [],
    photo: withAssets ? photoAssetOf(memberPhotoFromResult(results[1])) : null,
    artHashes: artHashesOf(blueprintAssetsFromResult(art)),
  };
}
