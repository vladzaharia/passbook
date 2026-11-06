import { first, run } from '../../platform/db.ts';
import type { AssetRow } from './repo.ts';

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

export const memberPhoto = (db: D1Database, orgId: string, passId: string) =>
  first<MemberPhotoRow>(db, 'SELECT * FROM member_photos WHERE org_id=? AND pass_id=?', [
    orgId,
    passId,
  ]);

/** A failed rebuild may restore only the version it wrote. */
export async function replaceMemberPhoto(
  db: D1Database,
  orgId: string,
  passId: string,
  next: MemberPhotoRow | null,
  previousVersion: string | null,
): Promise<boolean> {
  if (!next) {
    const result = await run(
      db,
      'DELETE FROM member_photos WHERE org_id=? AND pass_id=? AND version=?',
      [orgId, passId, previousVersion],
    );
    return result.changes === 1;
  }
  const result = await run(
    db,
    `
    INSERT INTO member_photos(pass_id,org_id,r2_key,sha1,size,crc32,include_in_pass,version,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(pass_id) DO UPDATE SET r2_key=excluded.r2_key,sha1=excluded.sha1,
      size=excluded.size,crc32=excluded.crc32,include_in_pass=excluded.include_in_pass,
      version=excluded.version,updated_at=excluded.updated_at
    WHERE member_photos.org_id=excluded.org_id AND member_photos.version=?`,
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
      previousVersion,
    ],
  );
  return result.changes === 1;
}

export const photoKeyInUse = async (db: D1Database, key: string) =>
  (await first(db, 'SELECT 1 FROM member_photos WHERE r2_key=? LIMIT 1', [key])) !== null;

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
