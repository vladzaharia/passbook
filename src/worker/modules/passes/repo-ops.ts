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
    (authority?.kind === 'session' &&
      authority.capability !== 'passes:operate' &&
      authority.capability !== 'messages:manage') ||
    (authority?.kind === 'api_key' &&
      authority.scope !== 'passes:write' &&
      authority.scope !== 'messages:write')
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
  const scope = [
    ['template_id', q.templateId],
    ['org_id', q.orgId],
    ['identity_id', q.identityId ?? null],
    ['mode', q.mode ?? null],
  ].filter((c): c is [string, string] => c[1] !== null);
  return all<{ id: string }>(
    db,
    `SELECT id FROM passes WHERE ${scope.map(([column]) => `${column} = ? AND `).join('')}id > ? AND deleted_at IS NULL AND test_data_quarantined = 0
       ${
         q.skipVersion === null
           ? ''
           : `AND template_version != ? AND NOT EXISTS (
         SELECT 1 FROM template_versions current_version
         JOIN template_versions target_version
           ON target_version.template_id = current_version.template_id
          AND target_version.version = ?
          AND target_version.build_key = current_version.build_key
         WHERE current_version.template_id = passes.template_id
           AND current_version.version = passes.template_version
       )`
       }
       AND (? = 0 OR status = 'active') ORDER BY id LIMIT ?`,
    [
      ...scope.map(([, value]) => value),
      q.afterId ?? '',
      ...(q.skipVersion === null ? [] : [q.skipVersion, q.skipVersion]),
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
  row: {
    instanceId: string;
    orgId: string;
    targetId: string | null;
    now: number;
    runGuard?: string;
  },
  authority: TenantPassWrite,
): Promise<boolean> {
  if (
    (authority.kind === 'session' && authority.capability !== 'passes:operate') ||
    (authority.kind === 'api_key' && authority.scope !== 'passes:write')
  )
    return false;
  const inserted = await first<{ instance_id: string }>(
    db,
    `INSERT INTO workflow_runs (instance_id, kind, org_id, target_id, status, started_at, run_guard)
     SELECT ?, 'bulk_reissue', ?, ?, 'queued', ?, ?
     WHERE ? = ? AND ${tenantPassAuthoritySql(authority)}
     RETURNING instance_id`,
    [
      row.instanceId,
      row.orgId,
      row.targetId,
      row.now,
      row.runGuard ?? null,
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

/** Frees the guard of a key-started run that never finished within the window, so a stuck run does not block its target. */
export async function releaseStaleRunGuard(
  db: D1Database,
  runGuard: string,
  since: number,
): Promise<void> {
  await run(
    db,
    'UPDATE workflow_runs SET run_guard = NULL WHERE run_guard = ? AND started_at <= ?',
    [runGuard, since],
  );
}

/** A failed run's own guard, named by its instance: a retry of that operation must not be refused by it. */
export async function releaseRunGuardOf(db: D1Database, instanceId: string): Promise<void> {
  await run(db, 'UPDATE workflow_runs SET run_guard = NULL WHERE instance_id = ?', [instanceId]);
}

export const setWorkflowStatus = (
  db: D1Database,
  instanceId: string,
  status: 'running' | 'complete' | 'errored',
  now: number,
  errorCode: string | null = null,
) => finishRun(db, instanceId, status, now, { errorCode });

/** Distinct template versions a template's live passes sit on, in one organization and mode. */
export async function liveVersions(
  db: D1Database,
  q: { templateId: string; orgId: string; mode: Mode },
): Promise<string[]> {
  const rows = await all<{ v: string }>(
    db,
    `SELECT DISTINCT template_version AS v FROM passes
     WHERE template_id = ? AND org_id = ? AND mode = ? AND status = 'active' AND deleted_at IS NULL`,
    [q.templateId, q.orgId, q.mode],
  );
  return rows.map((r) => r.v);
}

/** A bulk rebuild of the target that is still queued or running in this mode (a run with no snapshot has no recorded mode, so it counts). */
export async function activeBulkRun(
  db: D1Database,
  q: { orgId: string; targetId: string; mode: string; since: number },
): Promise<string | null> {
  const row = await first<{ instance_id: string }>(
    db,
    `SELECT r.instance_id FROM workflow_runs r
     WHERE r.kind = 'bulk_reissue' AND r.org_id = ? AND r.target_id = ?
       AND r.status IN ('queued', 'running') AND r.started_at > ?
       AND NOT EXISTS (SELECT 1 FROM workflow_release_snapshots s WHERE s.instance_id = r.instance_id AND s.mode <> ?)
     ORDER BY r.started_at DESC LIMIT 1`,
    [q.orgId, q.targetId, q.since, q.mode],
  );
  return row?.instance_id ?? null;
}
