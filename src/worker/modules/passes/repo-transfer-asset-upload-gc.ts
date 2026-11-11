import { all, batch, stmt } from '../../platform/db.ts';
import { unreferencedPassAssetKeySql } from './repo-pass-asset-references.ts';

/** Abandoned pre-PUT reservations may be tombstoned, never silently discarded. */
export function listExpiredPassAssetUploads(db: D1Database, cutoff: number, limit: number) {
  return all<{ r2_key: string; pass_id: string; created_at: number }>(
    db,
    `SELECT u.r2_key, u.pass_id, u.created_at FROM pass_transfer_asset_uploads u
     WHERE u.created_at <= ? AND ${unreferencedPassAssetKeySql('u.r2_key', false)}
       AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = u.pass_id AND t.state = 'pending')
     ORDER BY u.created_at, u.r2_key LIMIT ?`,
    [cutoff, limit],
  );
}

export async function retireExpiredPassAssetUpload(
  db: D1Database,
  input: {
    key: string;
    passId: string;
    createdAt: number;
    cutoff: number;
    now: number;
  },
): Promise<void> {
  await batch(db, [
    stmt(
      db,
      `INSERT INTO pass_transfer_asset_gc
      (r2_key, transfer_id, source_pass_id, retired_at, next_attempt_at)
      SELECT u.r2_key, NULL, NULL, ?1, ?1 FROM pass_transfer_asset_uploads u
      WHERE u.r2_key = ?2 AND u.pass_id = ?3 AND u.created_at = ?4 AND u.created_at <= ?5
        AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = u.pass_id AND t.state = 'pending')
        AND NOT EXISTS (SELECT 1 FROM pass_transfer_asset_gc gc WHERE gc.r2_key = u.r2_key)
        AND ${unreferencedPassAssetKeySql('u.r2_key', false)}`,
      [input.now, input.key, input.passId, input.createdAt, input.cutoff],
    ),
    stmt(
      db,
      `DELETE FROM pass_transfer_asset_uploads WHERE r2_key = ? AND pass_id = ?
      AND created_at = ? AND created_at <= ?
      AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
        WHERE t.pass_id = pass_transfer_asset_uploads.pass_id AND t.state = 'pending')
      AND EXISTS (SELECT 1 FROM pass_transfer_asset_gc gc WHERE gc.r2_key = pass_transfer_asset_uploads.r2_key)`,
      [input.key, input.passId, input.createdAt, input.cutoff],
    ),
  ]);
}
