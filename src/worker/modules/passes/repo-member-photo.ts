import { stmt } from '../../platform/db.ts';
import type { AssetRow } from './repo-history-assets.ts';
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

export interface MemberPhotoRow {
  pass_id: string;
  org_id: string;
  r2_key: string;
  sha1: string;
  size: number;
  crc32: number;
  include_in_pass: number;
  version: string;
  updated_at: number;
}

/** The batchable statement lets scanner authorization capture the photo in its first D1 trip. */
export const memberPhotoStmt = (db: D1Database, orgId: string, passId: string) =>
  stmt(db, 'SELECT * FROM member_photos WHERE org_id=? AND pass_id=?', [orgId, passId]);

export const memberPhotoFromResult = (result: D1Result | undefined): MemberPhotoRow | null =>
  (result?.results[0] as MemberPhotoRow | undefined) ?? null;

export const memberPhoto = (db: D1Database, orgId: string, passId: string) =>
  memberPhotoStmt(db, orgId, passId).first<MemberPhotoRow>();

/**
 * Exact-state compensation of this request's own photo write and trusted callers only; tenant writes
 * use replaceMemberPhotoGranted.
 */
export async function replaceMemberPhoto(
  db: D1Database,
  orgId: string,
  passId: string,
  next: MemberPhotoRow | null,
  previousVersion: string | null,
  guard: {
    pass: Pass;
    imageGeneration: number;
    now: number;
    uploadKey?: string;
    candidateId?: number;
  },
): Promise<ImageMutationResult> {
  if (
    guard.pass.id !== passId ||
    guard.pass.orgId !== orgId ||
    (next && (next.pass_id !== passId || next.org_id !== orgId)) ||
    (guard.uploadKey !== undefined && next?.r2_key !== guard.uploadKey) ||
    (guard.candidateId !== undefined && !next) ||
    (guard.uploadKey !== undefined && guard.candidateId !== undefined) ||
    (!next && previousVersion === null)
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
    next?.r2_key,
    'photo',
    '',
  );
  const sameKey = next && guard.uploadKey === undefined && guard.candidateId === undefined;
  const sameKeyWhere = sameKey
    ? ' AND EXISTS (SELECT 1 FROM member_photos m WHERE m.org_id = ? AND m.pass_id = ? AND m.r2_key = ?)'
    : '';
  const sameKeyParams = sameKey && next ? [orgId, passId, next.r2_key] : [];
  const mutation = !next
    ? stmt(
        db,
        `DELETE FROM member_photos WHERE org_id = ? AND pass_id = ? AND version = ?
         AND EXISTS (SELECT 1 FROM passes p WHERE ${passWhere}) RETURNING pass_id`,
        [orgId, passId, previousVersion, ...passParams],
      )
    : stmt(
        db,
        `INSERT INTO member_photos(pass_id,org_id,r2_key,sha1,size,crc32,include_in_pass,version,updated_at)
         SELECT ?,?,?,?,?,?,?,?,? FROM passes p WHERE ${passWhere} AND ${
           previousVersion === null
             ? 'NOT EXISTS (SELECT 1 FROM member_photos m WHERE m.org_id = ? AND m.pass_id = ?)'
             : 'EXISTS (SELECT 1 FROM member_photos m WHERE m.org_id = ? AND m.pass_id = ? AND m.version = ?)'
         }${uploadWhere}${candidateWhere}${sameKeyWhere}
         ON CONFLICT(pass_id) DO UPDATE SET r2_key=excluded.r2_key,sha1=excluded.sha1,
           size=excluded.size,crc32=excluded.crc32,include_in_pass=excluded.include_in_pass,
           version=excluded.version,updated_at=excluded.updated_at
         WHERE member_photos.org_id=excluded.org_id AND member_photos.version=?
         RETURNING pass_id`,
        [
          passId,
          orgId,
          next.r2_key,
          next.sha1,
          next.size,
          next.crc32,
          next.include_in_pass,
          next.version,
          next.updated_at,
          ...passParams,
          orgId,
          passId,
          ...(previousVersion === null ? [] : [previousVersion]),
          ...uploadParams,
          ...candidateParams,
          ...sameKeyParams,
          previousVersion,
        ],
      );
  return commitImageMutation(
    db,
    mutation,
    guard.pass,
    guard.imageGeneration,
    previousVersion !== null,
    'photo',
    '',
  );
}

/** Synthetic overrides leave a pass's original thumbnail intact when the photo is disabled. */
export async function memberPhotoAsset(
  db: D1Database,
  orgId: string,
  passId: string,
): Promise<AssetRow | null> {
  const photo = await memberPhoto(db, orgId, passId);
  return photo?.include_in_pass
    ? {
        name: 'thumbnail@3x.png',
        r2Key: photo.r2_key,
        sha1: photo.sha1,
        size: photo.size,
        width: 270,
        height: 270,
        crc32: photo.crc32,
        createdAt: photo.updated_at,
      }
    : null;
}
