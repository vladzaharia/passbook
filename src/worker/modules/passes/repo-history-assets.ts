import { all, run, stmt } from '../../platform/db.ts';
import {
  commitImageMutation,
  type ImageMutationResult,
  imageCandidateParams,
  imageCandidateWhere,
  imagePassParams,
  imagePassWhere,
  imageUploadParams,
  imageUploadWhere,
} from './repo-history-image.ts';
import type { Pass } from './repo-map.ts';

export interface AssetRow {
  name: string;
  r2Key: string;
  sha1: string;
  size: number;
  width: number | null;
  height: number | null;
  crc32: number | null;
  createdAt: number;
}

export async function listAssets(db: D1Database, passId: string): Promise<AssetRow[]> {
  const rows = await all<{
    name: string;
    r2_key: string;
    sha1: string;
    size: number;
    width: number | null;
    height: number | null;
    crc32: number | null;
    created_at: number;
  }>(db, 'SELECT * FROM pass_assets WHERE pass_id = ? ORDER BY name', [passId]);
  return rows.map((r) => ({
    name: r.name,
    r2Key: r.r2_key,
    sha1: r.sha1,
    size: r.size,
    width: r.width,
    height: r.height,
    crc32: r.crc32,
    createdAt: r.created_at,
  }));
}

export async function upsertAsset(
  db: D1Database,
  passId: string,
  asset: AssetRow,
): Promise<AssetRow | null> {
  const previous = (await listAssets(db, passId)).find((a) => a.name === asset.name) ?? null;
  await run(
    db,
    `INSERT INTO pass_assets (pass_id, name, r2_key, sha1, size, width, height, crc32, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (pass_id, name) DO UPDATE SET r2_key = excluded.r2_key, sha1 = excluded.sha1,
       size = excluded.size, width = excluded.width, height = excluded.height,
       crc32 = excluded.crc32, created_at = excluded.created_at`,
    [
      passId,
      asset.name,
      asset.r2Key,
      asset.sha1,
      asset.size,
      asset.width,
      asset.height,
      asset.crc32,
      asset.createdAt,
    ],
  );
  return previous;
}

/**
 * Changes one slot only while both the pass and the previous slot are still the snapshots read by
 * the caller. Exact-state compensation and trusted callers only; tenant writes use replaceAssetGranted.
 */
export async function replaceAssetIfCurrent(
  db: D1Database,
  passId: string,
  name: string,
  next: AssetRow | null,
  previous: AssetRow | null,
  guard: {
    pass: Pass;
    imageGeneration: number;
    now: number;
    uploadKey?: string;
    candidateId?: number;
  },
): Promise<ImageMutationResult> {
  if ((next && next.name !== name) || (previous && previous.name !== name))
    throw new Error('Asset slot mismatch.');
  if (
    guard.pass.id !== passId ||
    (guard.uploadKey !== undefined && next?.r2Key !== guard.uploadKey) ||
    (guard.candidateId !== undefined && !next) ||
    (guard.uploadKey !== undefined && guard.candidateId !== undefined)
  )
    return { saved: false, candidateId: null, imageGeneration: null };
  const passWhere = imagePassWhere(undefined, guard.imageGeneration);
  const passParams = imagePassParams(guard.pass, guard.now, undefined, guard.imageGeneration);
  const uploadWhere = imageUploadWhere(guard.uploadKey);
  const uploadParams = imageUploadParams(guard.pass, guard.uploadKey);
  const candidateWhere = imageCandidateWhere(guard.candidateId);
  const candidateParams = imageCandidateParams(
    guard.candidateId,
    passId,
    next?.r2Key,
    'asset',
    name,
  );
  const sameKey = next && guard.uploadKey === undefined && guard.candidateId === undefined;
  const sameKeyWhere = sameKey
    ? ' AND EXISTS (SELECT 1 FROM pass_assets k WHERE k.pass_id = ? AND k.name = ? AND k.r2_key = ?)'
    : '';
  const sameKeyParams = sameKey && next ? [passId, name, next.r2Key] : [];
  const oldWhere = previous
    ? `EXISTS (SELECT 1 FROM pass_assets a WHERE a.pass_id = ? AND a.name = ?
        AND a.r2_key IS ? AND a.sha1 IS ? AND a.size IS ? AND a.width IS ? AND a.height IS ?
        AND a.crc32 IS ? AND a.created_at IS ?)`
    : 'NOT EXISTS (SELECT 1 FROM pass_assets a WHERE a.pass_id = ? AND a.name = ?)';
  const oldParams = previous
    ? [
        passId,
        name,
        previous.r2Key,
        previous.sha1,
        previous.size,
        previous.width,
        previous.height,
        previous.crc32,
        previous.createdAt,
      ]
    : [passId, name];
  const mutation =
    next && previous
      ? stmt(
          db,
          `UPDATE pass_assets SET r2_key=?, sha1=?, size=?, width=?, height=?, crc32=?, created_at=?
         WHERE pass_id=? AND name=? AND ${oldWhere}
           AND EXISTS (SELECT 1 FROM passes p WHERE ${passWhere})${uploadWhere}${candidateWhere}${sameKeyWhere} RETURNING pass_id`,
          [
            next.r2Key,
            next.sha1,
            next.size,
            next.width,
            next.height,
            next.crc32,
            next.createdAt,
            passId,
            name,
            ...oldParams,
            ...passParams,
            ...uploadParams,
            ...candidateParams,
            ...sameKeyParams,
          ],
        )
      : next
        ? stmt(
            db,
            `INSERT INTO pass_assets (pass_id, name, r2_key, sha1, size, width, height, crc32, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? FROM passes p WHERE ${passWhere} AND ${oldWhere}${uploadWhere}${candidateWhere}${sameKeyWhere}
           RETURNING pass_id`,
            [
              passId,
              name,
              next.r2Key,
              next.sha1,
              next.size,
              next.width,
              next.height,
              next.crc32,
              next.createdAt,
              ...passParams,
              ...oldParams,
              ...uploadParams,
              ...candidateParams,
              ...sameKeyParams,
            ],
          )
        : stmt(
            db,
            `DELETE FROM pass_assets WHERE pass_id = ? AND name = ? AND ${oldWhere}
           AND EXISTS (SELECT 1 FROM passes p WHERE ${passWhere}) RETURNING pass_id`,
            [passId, name, ...oldParams, ...passParams],
          );
  return commitImageMutation(
    db,
    mutation,
    guard.pass,
    guard.imageGeneration,
    previous !== null,
    'asset',
    name,
  );
}
