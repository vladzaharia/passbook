import { artHashesOf } from './branding.ts';
import { blueprintAssetsFromResult, sourceBlueprintAssetsStmt } from './repo-blueprint-art.ts';
import { type AssetRow, assetsFromResult, listAssetsStmt } from './repo-history-assets.ts';
import { memberPhotoFromResult, memberPhotoStmt, photoAssetOf } from './repo-member-photo.ts';

export interface BuildInputs {
  overrides: AssetRow[];
  photo: AssetRow | null;
  artHashes: ReadonlySet<string>;
}

type BuildInputsReq = { passId: string; orgId: string; omitPassAssets?: boolean };

/** The statements behind `readBuildInputs`, for a caller that batches them with its own reads. */
export function buildInputStmts(db: D1Database, req: BuildInputsReq, templateId: string) {
  return [
    ...(req.omitPassAssets
      ? []
      : [listAssetsStmt(db, req.passId), memberPhotoStmt(db, req.orgId, req.passId)]),
    sourceBlueprintAssetsStmt(db, templateId),
  ];
}

export function buildInputsFromResults(
  req: Pick<BuildInputsReq, 'omitPassAssets'>,
  results: D1Result[],
): BuildInputs {
  const withAssets = !req.omitPassAssets;
  const art = results[withAssets ? 2 : 0];
  return {
    overrides: withAssets ? assetsFromResult(results[0]) : [],
    photo: withAssets ? photoAssetOf(memberPhotoFromResult(results[1])) : null,
    artHashes: artHashesOf(blueprintAssetsFromResult(art)),
  };
}

/**
 * What a build reads from D1 besides the template: the pass's own assets and member photo (unless
 * the build omits them) and the art of the blueprint the template came from, in one trip.
 */
export async function readBuildInputs(
  db: D1Database,
  req: BuildInputsReq,
  templateId: string,
): Promise<BuildInputs> {
  return buildInputsFromResults(req, await db.batch(buildInputStmts(db, req, templateId)));
}
