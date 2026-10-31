import { first } from '../../platform/db.ts';

export async function getPassAsset(
  db: D1Database,
  passId: string,
  name: string,
): Promise<{ r2Key: string; sha1: string } | null> {
  const row = await first<{ r2_key: string; sha1: string }>(
    db,
    'SELECT r2_key, sha1 FROM pass_assets WHERE pass_id = ? AND name = ?',
    [passId, name],
  );
  return row ? { r2Key: row.r2_key, sha1: row.sha1 } : null;
}
