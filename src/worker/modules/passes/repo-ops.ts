import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first, run } from '../../platform/db.ts';
import { finishRun, startRun } from '../../platform/workflow-runs.ts';
import type { TenantPassWrite } from './http.ts';
import {
  platformAdminSessionParams,
  platformAdminSessionSql,
  tenantPassAuthorityParams,
  tenantPassAuthoritySql,
} from './repo-authority.ts';

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
  authority?: TenantPassWrite,
  additionalAuthority?: TenantPassWrite,
): Promise<boolean> {
  if (
    (authority?.kind === 'session' && authority.capability !== 'passes:operate') ||
    (authority?.kind === 'api_key' && authority.scope !== 'passes:write')
  )
    return false;
  if (additionalAuthority && !authority) return false;
  return (
    (
      await run(
        db,
        authority
          ? `INSERT OR IGNORE INTO idempotency_keys (org_id, key, request_hash, resource_id, created_at)
             SELECT ?, ?, ?, ?, ? WHERE ? = ? AND ${tenantPassAuthoritySql(authority)}
             ${additionalAuthority ? `AND ? = ? AND ${tenantPassAuthoritySql(additionalAuthority)}` : ''}`
          : `INSERT OR IGNORE INTO idempotency_keys (org_id, key, request_hash, resource_id, created_at)
             VALUES (?, ?, ?, ?, ?)`,
        authority
          ? [
              orgId,
              key,
              requestHash,
              resourceId,
              now,
              orgId,
              authority.orgId,
              ...tenantPassAuthorityParams(authority, now),
              ...(additionalAuthority
                ? [
                    orgId,
                    additionalAuthority.orgId,
                    ...tenantPassAuthorityParams(additionalAuthority, now),
                  ]
                : []),
            ]
          : [orgId, key, requestHash, resourceId, now],
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

/** Release only this reservation, and never one whose pass exists (including hidden rows). */
export async function releaseIdempotencyKey(
  db: D1Database,
  orgId: string,
  key: string,
  resourceId: string,
  requestHash: string,
): Promise<void> {
  await run(
    db,
    `DELETE FROM idempotency_keys WHERE org_id = ? AND key = ? AND resource_id = ?
      AND request_hash = ?
      AND NOT EXISTS (SELECT 1 FROM passes WHERE passes.id = idempotency_keys.resource_id)`,
    [orgId, key, resourceId, requestHash],
  );
}

export async function passesForReissue(
  db: D1Database,
  q: {
    templateId: string | null;
    orgId: string | null;
    identityId?: string | null;
    mode?: Mode | null;
    afterId: string | null;
    limit: number;
    skipVersion: string | null;
    activeOnly?: boolean;
  },
): Promise<{ id: string }[]> {
  return all<{ id: string }>(
    db,
    `SELECT id FROM passes WHERE (? IS NULL OR template_id = ?) AND (? IS NULL OR org_id = ?)
       AND (? IS NULL OR identity_id = ?) AND (? IS NULL OR mode = ?)
       AND id > ? AND deleted_at IS NULL AND test_data_quarantined = 0
       AND (? IS NULL OR (template_version != ? AND NOT EXISTS (
         SELECT 1 FROM template_versions current_version
         JOIN template_versions target_version
           ON target_version.template_id = current_version.template_id
          AND target_version.version = ?
          AND target_version.build_key = current_version.build_key
         WHERE current_version.template_id = passes.template_id
           AND current_version.version = passes.template_version
       )))
       AND (? = 0 OR status = 'active') ORDER BY id LIMIT ?`,
    [
      q.templateId,
      q.templateId,
      q.orgId,
      q.orgId,
      q.identityId ?? null,
      q.identityId ?? null,
      q.mode ?? null,
      q.mode ?? null,
      q.afterId ?? '',
      q.skipVersion,
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

/** Reserve a tenant bulk workflow only while the initiating authority is still valid. */
export async function insertTenantBulkWorkflowRun(
  db: D1Database,
  row: { instanceId: string; orgId: string; targetId: string | null; now: number },
  authority: TenantPassWrite,
): Promise<boolean> {
  if (
    (authority.kind === 'session' && authority.capability !== 'passes:operate') ||
    (authority.kind === 'api_key' && authority.scope !== 'passes:write')
  )
    return false;
  const inserted = await first<{ instance_id: string }>(
    db,
    `INSERT INTO workflow_runs (instance_id, kind, org_id, target_id, status, started_at)
     SELECT ?, 'bulk_reissue', ?, ?, 'queued', ?
     WHERE ? = ? AND ${tenantPassAuthoritySql(authority)}
     RETURNING instance_id`,
    [
      row.instanceId,
      row.orgId,
      row.targetId,
      row.now,
      row.orgId,
      authority.orgId,
      ...tenantPassAuthorityParams(authority, row.now),
    ],
  );
  return inserted !== null;
}

/** Reserve an unscoped bulk workflow only while the initiating platform admin remains valid. */
export async function insertPlatformAdminBulkWorkflowRun(
  db: D1Database,
  row: { instanceId: string; orgId: null; targetId: string | null; now: number },
  platformSession: { userId: string; sessionId: string },
): Promise<boolean> {
  if (row.orgId !== null) return false;
  const inserted = await first<{ instance_id: string }>(
    db,
    `INSERT INTO workflow_runs (instance_id, kind, org_id, target_id, status, started_at)
     SELECT ?, 'bulk_reissue', NULL, ?, 'queued', ?
     WHERE ${platformAdminSessionSql}
     RETURNING instance_id`,
    [
      row.instanceId,
      row.targetId,
      row.now,
      ...platformAdminSessionParams(platformSession, row.now),
    ],
  );
  return inserted !== null;
}

export const setWorkflowStatus = (
  db: D1Database,
  instanceId: string,
  status: 'running' | 'complete' | 'errored',
  now: number,
  errorCode: string | null = null,
) => finishRun(db, instanceId, status, now, { errorCode });
