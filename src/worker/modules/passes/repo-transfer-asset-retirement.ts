import { stmt } from '../../platform/db.ts';
import { assetsSql, photoSql, type TransferPass } from './repo-credential-transfer-read.ts';

/**
 * These statements belong immediately after both successful FINISH CAS guards, in the same D1
 * batch. Recheck the complete source asset snapshots before making *any* retirement durable.
 * A mismatched snapshot raises the same CAS-loss sentinel as the enclosing transfer batch.
 */
export function transferAssetRetirementStatements(
  db: D1Database,
  input: {
    transferId: string;
    source: TransferPass;
    now: number;
  },
): D1PreparedStatement[] {
  const { source, transferId, now } = input;
  const p = source.pass;
  return [
    stmt(
      db,
      `SELECT CASE WHEN EXISTS (
      SELECT 1 FROM pass_credential_transfers t JOIN passes p ON p.id = t.pass_id
      WHERE t.id = ? AND t.state = 'completed' AND t.completed_at = ?
        AND t.pass_id = ? AND t.org_id = ? AND t.mode = ?
        AND t.source_version = ? AND t.source_revision = ? AND t.target_generation = ?
        AND t.source_lifecycle_generation = ? AND t.source_link_generation = ?
        AND p.org_id = t.org_id AND p.mode = t.mode AND p.credential_generation = t.target_generation
        AND p.version = t.source_version + 1 AND p.revision > t.source_revision
        AND p.lifecycle_generation = t.source_lifecycle_generation AND p.link_generation = t.source_link_generation
        AND p.holder_email IS t.target_holder_email AND p.owner_user_id IS t.target_owner_user_id
        AND p.object_key IS NOT ? AND p.image_generation = ? AND ${assetsSql} = ? AND ${photoSql} = ?
    ) THEN NULL ELSE json_extract('[0]', '$[__credential_transfer_cas_lost__]') END`,
      [
        transferId,
        now,
        p.id,
        p.orgId,
        p.mode,
        p.version,
        p.revision,
        source.credentialGeneration,
        source.lifecycleGeneration,
        p.linkGeneration,
        p.objectKey,
        source.imageGeneration,
        source.assetsSnapshot,
        source.photoSnapshot,
      ],
    ),
    stmt(
      db,
      `INSERT INTO pass_transfer_asset_gc
      (r2_key, transfer_id, source_pass_id, retired_at, next_attempt_at)
      SELECT keys.r2_key, ?, ?, ?, ? FROM (
        SELECT r2_key FROM pass_assets WHERE pass_id = ?
        UNION SELECT r2_key FROM member_photos WHERE pass_id = ?
        UNION SELECT r2_key FROM pass_transfer_asset_candidates WHERE pass_id = ?
        UNION SELECT r2_key FROM pass_transfer_asset_uploads
          WHERE pass_id = ? AND credential_generation < ?
      ) keys WHERE NOT EXISTS (SELECT 1 FROM pass_transfer_asset_gc gc WHERE gc.r2_key = keys.r2_key)`,
      [transferId, p.id, now, now, p.id, p.id, p.id, p.id, source.credentialGeneration],
    ),
    // Another pass may still hold one of these keys. Wake it when the last reference is released.
    stmt(
      db,
      `UPDATE pass_transfer_asset_gc SET next_attempt_at = min(next_attempt_at, ?)
      WHERE r2_key IN (SELECT r2_key FROM pass_assets WHERE pass_id = ?
        UNION SELECT r2_key FROM member_photos WHERE pass_id = ?
        UNION SELECT r2_key FROM pass_transfer_asset_candidates WHERE pass_id = ?
        UNION SELECT r2_key FROM pass_transfer_asset_uploads WHERE pass_id = ? AND credential_generation < ?)`,
      [now, p.id, p.id, p.id, p.id, source.credentialGeneration],
    ),
    stmt(db, 'DELETE FROM pass_assets WHERE pass_id = ?', [p.id]),
    stmt(db, 'DELETE FROM member_photos WHERE pass_id = ?', [p.id]),
    stmt(db, 'DELETE FROM pass_transfer_asset_candidates WHERE pass_id = ?', [p.id]),
    stmt(
      db,
      'DELETE FROM pass_transfer_asset_uploads WHERE pass_id = ? AND credential_generation < ?',
      [p.id, source.credentialGeneration],
    ),
  ];
}
