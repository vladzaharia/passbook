import { all, batch, chunk, first, run, stmt } from '../../platform/db.ts';
import { finishRun, startRun } from '../../platform/workflow-runs.ts';
import { listAssets } from './repo-history.ts';
import { mapPass, type Pass } from './repo-map.ts';
import { memberPhoto } from './repo-member-photo.ts';

export interface DeletedPass {
  objectKeys: string[];
  deviceIds: { deviceId: string; identityId: string }[];
}

/** Collects what must be cleaned outside D1, then removes the rows (children cascade). */
export async function deletePassRows(db: D1Database, pass: Pass): Promise<DeletedPass> {
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
  await batch(db, [
    stmt(db, 'DELETE FROM passes WHERE id = ?', [pass.id]),
    ...devices.map((d) =>
      stmt(
        db,
        `DELETE FROM devices WHERE device_id = ? AND identity_id = ?
         AND NOT EXISTS (SELECT 1 FROM registrations r WHERE r.device_id = devices.device_id AND r.identity_id = devices.identity_id)`,
        [d.device_id, d.identity_id],
      ),
    ),
  ]);
  return {
    objectKeys: [...keys],
    deviceIds: devices.map((d) => ({ deviceId: d.device_id, identityId: d.identity_id })),
  };
}

export async function deleteObjects(bucket: R2Bucket, keys: string[]): Promise<void> {
  for (const part of chunk(keys, 500)) await bucket.delete(part);
}

export interface IdempotencyRow {
  requestHash: string;
  resourceId: string | null;
}

export async function claimIdempotencyKey(
  db: D1Database,
  orgId: string,
  key: string,
  requestHash: string,
  resourceId: string,
  now: number,
): Promise<boolean> {
  return (
    (
      await run(
        db,
        `INSERT OR IGNORE INTO idempotency_keys (org_id, key, request_hash, resource_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [orgId, key, requestHash, resourceId, now],
      )
    ).changes === 1
  );
}

export async function getIdempotencyKey(
  db: D1Database,
  orgId: string,
  key: string,
): Promise<IdempotencyRow | null> {
  const row = await first<{ request_hash: string; resource_id: string | null }>(
    db,
    'SELECT request_hash, resource_id FROM idempotency_keys WHERE org_id = ? AND key = ?',
    [orgId, key],
  );
  return row ? { requestHash: row.request_hash, resourceId: row.resource_id } : null;
}

export async function finishIdempotencyKey(
  db: D1Database,
  orgId: string,
  key: string,
  resourceId: string | null,
): Promise<void> {
  if (resourceId === null)
    await run(db, 'DELETE FROM idempotency_keys WHERE org_id = ? AND key = ?', [orgId, key]);
  else
    await run(db, 'UPDATE idempotency_keys SET resource_id = ? WHERE org_id = ? AND key = ?', [
      resourceId,
      orgId,
      key,
    ]);
}

export async function passesForReissue(
  db: D1Database,
  q: {
    templateId: string | null;
    orgId: string | null;
    identityId?: string | null;
    afterId: string | null;
    limit: number;
    skipVersion: string | null;
    activeOnly?: boolean;
  },
): Promise<{ id: string }[]> {
  return all<{ id: string }>(
    db,
    `SELECT id FROM passes WHERE (? IS NULL OR template_id = ?) AND (? IS NULL OR org_id = ?)
       AND (? IS NULL OR identity_id = ?) AND id > ? AND deleted_at IS NULL AND test_data_quarantined = 0
       AND (? IS NULL OR template_version != ?)
       AND (? = 0 OR status = 'active') ORDER BY id LIMIT ?`,
    [
      q.templateId,
      q.templateId,
      q.orgId,
      q.orgId,
      q.identityId ?? null,
      q.identityId ?? null,
      q.afterId ?? '',
      q.skipVersion,
      q.skipVersion,
      q.activeOnly ? 1 : 0,
      q.limit,
    ],
  );
}

export async function insertWorkflowRun(
  db: D1Database,
  row: {
    instanceId: string;
    kind: 'bulk_reissue';
    orgId: string | null;
    targetId: string;
    now: number;
  },
): Promise<void> {
  await startRun(db, row);
}

export const setWorkflowStatus = (
  db: D1Database,
  instanceId: string,
  status: 'running' | 'complete' | 'errored',
  now: number,
  errorCode: string | null = null,
) => finishRun(db, instanceId, status, now, { errorCode });

/**
 * Hides the pass from every list and lookup but the device protocol, and unlinks it from its
 * owner and connection. The retention job removes it later.
 */
export async function softDeletePass(db: D1Database, id: string, now: number): Promise<void> {
  await run(
    db,
    `UPDATE passes SET deleted_at = ?, owner_user_id = NULL, connection_id = NULL, external_ref = NULL,
       next_sync_at = NULL WHERE id = ?`,
    [now, id],
  );
}

export async function expiredDeletedPasses(
  db: D1Database,
  before: number,
  limit: number,
): Promise<Pass[]> {
  const rows = await all<Parameters<typeof mapPass>[0]>(
    db,
    'SELECT * FROM passes WHERE deleted_at IS NOT NULL AND deleted_at < ? LIMIT ?',
    [before, limit],
  );
  return rows.map(mapPass);
}
