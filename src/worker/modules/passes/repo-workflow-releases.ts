import type { Mode } from '../../../shared/contracts/common.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { all, batch, first, type SqlValue, stmt } from '../../platform/db.ts';
import { effectiveReleaseIdSql } from '../templates/repo-release-heads.ts';
import type { TenantPassWrite } from './http.ts';
import {
  platformAdminSessionParams,
  platformAdminSessionSql,
  tenantPassAuthorityParams,
  tenantPassAuthoritySql,
} from './repo-authority.ts';

export interface WorkflowReleaseReservation {
  instanceId: string;
  orgId: string | null;
  mode: Mode | null;
  templateId: string | null;
  targetId: string | null;
  identityId: string | null;
  /** An explicitly requested version must match every affected scope's effective head. */
  version: string | null;
  now: number;
  expectedRelease?: { id: string; generation: number; version: string };
  authority?: TenantPassWrite;
  platformSession?: Pick<SessionAuth, 'userId' | 'sessionId'>;
}

export type WorkflowReleaseReservationResult = 'inserted' | 'forbidden' | 'release_changed';

/**
 * Reserve the run and capture all affected scopes in the same transaction. A failed authority,
 * missing or mismatched head, or reviewed-release fence leaves neither run nor snapshot set.
 * The scopes stay in D1, so later pages cannot adopt a newly approved head.
 */
export async function reserveWorkflowReleases(
  db: D1Database,
  q: WorkflowReleaseReservation,
): Promise<WorkflowReleaseReservationResult> {
  if (q.authority && q.platformSession) return 'forbidden';
  if (
    q.authority &&
    (q.orgId === null ||
      q.orgId !== q.authority.orgId ||
      q.mode !== q.authority.mode ||
      (q.authority.kind === 'session' && q.authority.capability !== 'passes:operate') ||
      (q.authority.kind === 'api_key' && q.authority.scope !== 'passes:write'))
  )
    return 'forbidden';
  if (q.platformSession && (q.orgId !== null || q.mode === null)) return 'forbidden';
  if (q.expectedRelease && (q.orgId === null || q.mode === null || q.templateId === null))
    return 'release_changed';

  let authoritySql = '1';
  let authorityParams: SqlValue[] = [];
  if (q.authority) {
    authoritySql = `? = ? AND ${tenantPassAuthoritySql(q.authority)}`;
    authorityParams = [
      q.orgId,
      q.authority.orgId,
      ...tenantPassAuthorityParams(q.authority, q.now),
    ];
  } else if (q.platformSession) {
    authoritySql = platformAdminSessionSql;
    authorityParams = platformAdminSessionParams(q.platformSession, q.now);
  }

  const expectedSql = q.expectedRelease
    ? `EXISTS (
         SELECT 1
         FROM (SELECT ? AS template_id, ? AS org_id, ? AS mode) expected_scope
         JOIN orgs expected_org ON expected_org.id = expected_scope.org_id AND expected_org.status = 'active'
         JOIN template_releases expected_release
           ON expected_release.id = ? AND expected_release.generation = ? AND expected_release.version = ?
         WHERE (? IS NULL OR expected_release.version = ?)
           AND expected_release.id = (${effectiveReleaseIdSql({
             templateIdSql: 'expected_scope.template_id',
             orgIdSql: 'expected_scope.org_id',
             modeSql: 'expected_scope.mode',
             providerSql: "'apple'",
           })})
       )`
    : '';
  const expectedParams: SqlValue[] = q.expectedRelease
    ? [
        q.templateId,
        q.orgId,
        q.mode,
        q.expectedRelease.id,
        q.expectedRelease.generation,
        q.expectedRelease.version,
        q.version,
        q.version,
      ]
    : [];

  const scopesSql = `SELECT DISTINCT p.org_id, p.mode, p.template_id
    FROM passes p
    WHERE (? IS NULL OR p.template_id = ?) AND (? IS NULL OR p.org_id = ?)
      AND (? IS NULL OR p.identity_id = ?) AND (? IS NULL OR p.mode = ?)
      AND p.status = 'active' AND p.deleted_at IS NULL AND p.test_data_quarantined = 0`;
  const scopeParams: SqlValue[] = [
    q.templateId,
    q.templateId,
    q.orgId,
    q.orgId,
    q.identityId,
    q.identityId,
    q.mode,
    q.mode,
  ];
  const effectiveHeadSql = `r.id = (${effectiveReleaseIdSql({
    templateIdSql: 'pass_scope.template_id',
    orgIdSql: 'pass_scope.org_id',
    modeSql: 'pass_scope.mode',
    providerSql: "'apple'",
  })})`;

  // Each check is a separate statement to keep D1's expression tree bounded. The guards abort
  // the batch, so neither a provisional run nor a partial snapshot set can be committed.
  const forbiddenPath = '__bulk_reissue_forbidden__';
  const releaseChangedPath = '__bulk_reissue_release_changed__';
  try {
    await batch(db, [
      stmt(
        db,
        `SELECT CASE WHEN ${authoritySql} THEN NULL ELSE json_extract('[0]', '$[${forbiddenPath}]') END`,
        authorityParams,
      ),
      ...(q.expectedRelease
        ? [
            stmt(
              db,
              `SELECT CASE WHEN ${expectedSql} THEN NULL ELSE json_extract('[0]', '$[${releaseChangedPath}]') END`,
              expectedParams,
            ),
          ]
        : []),
      stmt(
        db,
        `INSERT INTO workflow_runs (instance_id, kind, org_id, target_id, status, started_at)
         VALUES (?, 'bulk_reissue', ?, ?, 'queued', ?)`,
        [q.instanceId, q.orgId, q.targetId, q.now],
      ),
      // The marker distinguishes a valid empty snapshot set from a legacy or missing set.
      stmt(db, 'INSERT INTO workflow_release_snapshot_sets (instance_id) VALUES (?)', [
        q.instanceId,
      ]),
      stmt(
        db,
        `INSERT INTO workflow_release_snapshots
           (instance_id, org_id, mode, template_id, release_id, generation, version)
         SELECT ?, pass_scope.org_id, pass_scope.mode, pass_scope.template_id, r.id, r.generation, r.version
         FROM (${scopesSql}) pass_scope
         JOIN orgs o ON o.id = pass_scope.org_id AND o.status = 'active'
         JOIN template_releases r
           ON r.template_id = pass_scope.template_id AND r.mode = pass_scope.mode AND r.provider = 'apple'
         WHERE (? IS NULL OR r.version = ?) AND ${effectiveHeadSql}`,
        [q.instanceId, ...scopeParams, q.version, q.version],
      ),
      stmt(
        db,
        `SELECT CASE WHEN NOT EXISTS (
           SELECT 1 FROM (${scopesSql}) pass_scope
           LEFT JOIN workflow_release_snapshots snapshot
             ON snapshot.instance_id = ? AND snapshot.org_id = pass_scope.org_id
            AND snapshot.mode = pass_scope.mode AND snapshot.template_id = pass_scope.template_id
           WHERE snapshot.instance_id IS NULL
         ) THEN NULL ELSE json_extract('[0]', '$[${releaseChangedPath}]') END`,
        [...scopeParams, q.instanceId],
      ),
    ]);
    return 'inserted';
  } catch (error) {
    if (error instanceof Error && error.message.includes(forbiddenPath)) return 'forbidden';
    if (error instanceof Error && error.message.includes(releaseChangedPath))
      return 'release_changed';
    throw error;
  }
}

/** An empty set is valid only when it was reserved with its workflow. */
export async function hasWorkflowReleaseSnapshots(
  db: D1Database,
  instanceId: string,
): Promise<boolean> {
  return (
    (await first<{ present: number }>(
      db,
      'SELECT 1 AS present FROM workflow_release_snapshot_sets WHERE instance_id = ?',
      [instanceId],
    )) !== null
  );
}

export interface WorkflowReissuePass {
  id: string;
  orgId: string;
  mode: Mode;
  templateId: string;
  releaseId: string;
  generation: number;
  version: string;
}

/** Select against the captured heads, never the current release tables, with a stable pass cursor. */
export function passesForWorkflowReissue(
  db: D1Database,
  q: { instanceId: string; afterId: string | null; limit: number; identityId: string | null },
): Promise<WorkflowReissuePass[]> {
  return all<WorkflowReissuePass>(
    db,
    `SELECT p.id, p.org_id AS orgId, p.mode, p.template_id AS templateId,
            s.release_id AS releaseId, s.generation, s.version
     FROM workflow_release_snapshots s
     JOIN passes p ON p.org_id = s.org_id AND p.mode = s.mode AND p.template_id = s.template_id
     WHERE s.instance_id = ? AND p.id > ? AND (? IS NULL OR p.identity_id = ?)
       AND p.status = 'active' AND p.deleted_at IS NULL AND p.test_data_quarantined = 0
       AND p.template_version != s.version AND NOT EXISTS (
         SELECT 1 FROM template_versions current_version
         JOIN template_versions target_version
           ON target_version.template_id = current_version.template_id
          AND target_version.version = s.version
          AND target_version.build_key = current_version.build_key
         WHERE current_version.template_id = p.template_id
           AND current_version.version = p.template_version
       )
     ORDER BY p.id LIMIT ?`,
    [q.instanceId, q.afterId ?? '', q.identityId, q.identityId, q.limit],
  );
}
