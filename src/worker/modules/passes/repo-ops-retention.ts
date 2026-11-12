import { all, batch, chunk, stmt } from '../../platform/db.ts';
import {
  clearScanRetentionDeleteStmt,
  stageScanRetentionDeleteStmt,
} from '../scan/repo-scan-retention.ts';
import type { PreparedScanRetentionDelete } from '../scan/scan-retention-proof.ts';
import { providerRetirementCompleteSql } from '../wallet-providers/repo-sync-retention.ts';
import { credentialRefKeysetSql } from './repo-credential-keyset.ts';
import { listAssets } from './repo-history-assets.ts';
import { mapPass, type Pass } from './repo-map.ts';
import { memberPhoto } from './repo-member-photo.ts';

export interface DeletedPass {
  deleted: boolean;
  objectKeys: string[];
  deviceIds: { deviceId: string; identityId: string }[];
}

/**
 * A deleted pass whose rows must stay for now: a pending credential transfer or an in-flight sandbox forward.
 * Selection excludes these (so they cannot fill every batch) and the delete re-checks them.
 */
const purgeBlockedSql = `(
  EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = passes.id AND t.state = 'pending')
  OR EXISTS (SELECT 1 FROM sandbox_forward_passes fp JOIN sandbox_forwards f ON f.id = fp.forward_id
    WHERE fp.pass_id = passes.id AND f.state IN ('sending', 'unknown'))
  OR EXISTS (SELECT 1 FROM captured_emails c JOIN sandbox_forwards f ON f.capture_id = c.id
    WHERE c.pass_id = passes.id AND f.state IN ('sending', 'unknown'))
  OR EXISTS (SELECT 1 FROM bundle_passes bp JOIN sandbox_forwards f ON f.bundle_id = bp.bundle_id
    WHERE bp.pass_id = passes.id AND f.state IN ('sending', 'unknown'))
)`;

/** Return external cleanup targets only when the pass is deleted against its selection keyset. */
export async function deletePassRows(
  db: D1Database,
  pass: Pass,
  retention: PreparedScanRetentionDelete,
  credentialKeysetCommitment: string,
  guard?: { testBefore: number; lifecycleGeneration: number },
): Promise<DeletedPass> {
  if (
    typeof credentialKeysetCommitment !== 'string' ||
    !/^[0-9a-f]{64}$/.test(credentialKeysetCommitment) ||
    retention.orgId !== pass.orgId ||
    retention.mode !== pass.mode
  )
    return { deleted: false, objectKeys: [], deviceIds: [] };
  const [versions, assets, devices, photo] = await Promise.all([
    all<{ object_key: string | null }>(
      db,
      'SELECT object_key FROM pass_versions WHERE pass_id = ? AND object_key IS NOT NULL',
      [pass.id],
    ),
    listAssets(db, pass.id),
    all<{ device_id: string; identity_id: string }>(
      db,
      'SELECT device_id, identity_id FROM registrations WHERE pass_id = ?',
      [pass.id],
    ),
    memberPhoto(db, pass.orgId, pass.id),
  ]);
  const keys = new Set<string>([pass.objectKey]);
  if (photo) keys.add(photo.r2_key);
  for (const v of versions) if (v.object_key) keys.add(v.object_key);
  for (const a of assets) keys.add(a.r2Key);
  const results = await batch(db, [
    stageScanRetentionDeleteStmt(db, pass.id, retention),
    stmt(
      db,
      `DELETE FROM passes WHERE id = ? AND org_id = ? AND mode = ?
      AND row_version = ? AND link_generation = ?
      AND credential_generation = ? AND lifecycle_generation = ?
      AND removed_at IS ? AND deleted_at IS ? AND test_data_quarantined = ?
      AND ${credentialRefKeysetSql} AND NOT ${purgeBlockedSql}
      AND ${providerRetirementCompleteSql('passes.id')}
      ${guard ? "AND mode = 'test' AND created_at < ? AND lifecycle_generation = ?" : ''} RETURNING id`,
      [
        pass.id,
        pass.orgId,
        pass.mode,
        pass.rowVersion,
        pass.linkGeneration,
        pass.credentialGeneration,
        pass.lifecycleGeneration,
        pass.removedAt,
        pass.deletedAt,
        pass.testDataQuarantined ? 1 : 0,
        credentialKeysetCommitment,
        ...(guard ? [guard.testBefore, guard.lifecycleGeneration] : []),
      ],
    ),
    clearScanRetentionDeleteStmt(db, retention),
    ...devices.map((d) =>
      stmt(
        db,
        `DELETE FROM devices WHERE device_id = ? AND identity_id = ?
         AND NOT EXISTS (SELECT 1 FROM passes WHERE id = ?)
         AND NOT EXISTS (SELECT 1 FROM registrations r WHERE r.device_id = devices.device_id AND r.identity_id = devices.identity_id)`,
        [d.device_id, d.identity_id, pass.id],
      ),
    ),
  ]);
  if (!results[1]?.results?.length) return { deleted: false, objectKeys: [], deviceIds: [] };
  return {
    deleted: true,
    objectKeys: [...keys],
    deviceIds: devices.map((d) => ({ deviceId: d.device_id, identityId: d.identity_id })),
  };
}

export async function deleteObjects(bucket: R2Bucket, keys: string[]): Promise<void> {
  for (const part of chunk(keys, 500)) await bucket.delete(part);
}

/** Soft-deleted passes past the grace period that can be removed now, after the cursor, oldest id first. */
export async function expiredDeletedPasses(
  db: D1Database,
  before: number,
  afterId: string,
  limit: number,
): Promise<Pass[]> {
  const rows = await all<Parameters<typeof mapPass>[0]>(
    db,
    `SELECT * FROM passes WHERE deleted_at IS NOT NULL AND deleted_at < ? AND id > ?
      AND NOT ${purgeBlockedSql} AND ${providerRetirementCompleteSql('passes.id')}
     ORDER BY id LIMIT ?`,
    [before, afterId, limit],
  );
  return rows.map(mapPass);
}

/** Expired deleted passes the purge is skipping, for the log. */
export function blockedDeletedPasses(
  db: D1Database,
  before: number,
  limit: number,
): Promise<{ id: string; org_id: string }[]> {
  return all<{ id: string; org_id: string }>(
    db,
    `SELECT id, org_id FROM passes WHERE deleted_at IS NOT NULL AND deleted_at < ?
      AND (${purgeBlockedSql} OR NOT ${providerRetirementCompleteSql('passes.id')})
     ORDER BY id LIMIT ?`,
    [before, limit],
  );
}
