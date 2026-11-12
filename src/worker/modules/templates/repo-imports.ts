import type { ValidationReport } from '../../../passkit/types.ts';
import { first, run, stmt } from '../../platform/db.ts';
import { startRunStmt } from '../../platform/workflow-runs.ts';
import type { TemplateAuthority } from './access.ts';
import { templateAuthorityPredicate } from './repo-authority.ts';

export interface ImportRow {
  uploadId: string;
  orgId: string | null;
  name: string | null;
  objectKey: string;
  step: string | null;
  templateId: string | null;
  version: string | null;
  report: ValidationReport | null;
  error: string | null;
  createdBy: string | null;
  workflowStatus: 'queued' | 'running' | 'complete' | 'errored' | 'terminated' | null;
}

export async function insertImport(
  db: D1Database,
  row: {
    uploadId: string;
    orgId: string | null;
    name: string | null;
    objectKey: string;
    createdBy: string | null;
    now: number;
  },
): Promise<void> {
  await db.batch([
    stmt(
      db,
      `INSERT INTO template_imports (upload_id, org_id, name, object_key, step, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
      [row.uploadId, row.orgId, row.name, row.objectKey, row.createdBy, row.now, row.now],
    ),
    startRunStmt(db, {
      instanceId: row.uploadId,
      kind: 'template_import',
      orgId: row.orgId,
      targetId: row.uploadId,
      now: row.now,
    }),
  ]);
}

export async function getImport(db: D1Database, uploadId: string): Promise<ImportRow | null> {
  const row = await first<{
    upload_id: string;
    org_id: string | null;
    name: string | null;
    object_key: string;
    step: string | null;
    template_id: string | null;
    version: string | null;
    report: string | null;
    error: string | null;
    created_by: string | null;
    wf_status: ImportRow['workflowStatus'];
  }>(
    db,
    `SELECT i.upload_id, i.org_id, i.name, i.object_key, i.step, i.template_id, i.version, i.report,
            i.error, i.created_by, w.status AS wf_status
     FROM template_imports i LEFT JOIN workflow_runs w ON w.instance_id = i.upload_id
     WHERE i.upload_id = ?`,
    [uploadId],
  );
  if (!row) return null;
  return {
    uploadId: row.upload_id,
    orgId: row.org_id,
    name: row.name,
    objectKey: row.object_key,
    step: row.step,
    templateId: row.template_id,
    version: row.version,
    report: row.report ? (JSON.parse(row.report) as ValidationReport) : null,
    error: row.error,
    createdBy: row.created_by,
    workflowStatus: row.wf_status,
  };
}

export interface ImportIdentity {
  uploadId: string;
  orgId: string | null;
  objectKey: string;
  createdBy: string | null;
}

const identitySql = 'i.upload_id = ? AND i.org_id IS ? AND i.object_key = ? AND i.created_by IS ?';
const identityParams = (i: ImportIdentity) => [i.uploadId, i.orgId, i.objectKey, i.createdBy];

/** A workflow can clean up only the upload and workflow record it originally owned. */
export async function matchesImport(db: D1Database, identity: ImportIdentity): Promise<boolean> {
  const row = await first<{ ok: number }>(
    db,
    `SELECT 1 AS ok FROM template_imports i
     JOIN workflow_runs w ON w.instance_id = i.upload_id
     WHERE ${identitySql} AND w.kind = 'template_import' AND w.org_id IS i.org_id
       AND (w.target_id = i.upload_id OR (w.status = 'complete' AND w.target_id = i.template_id))`,
    identityParams(identity),
  );
  return !!row;
}

/** Starts only the matching queued import; retries cannot restart a terminal run. */
export async function startImportRun(
  db: D1Database,
  identity: ImportIdentity,
  authority: TemplateAuthority,
  now: number,
): Promise<boolean> {
  const auth = templateAuthorityPredicate(authority, 'i.org_id', now, true);
  const results = await db.batch([
    stmt(
      db,
      `UPDATE workflow_runs SET status = 'running', finished_at = NULL, error_code = NULL
       WHERE instance_id = ? AND kind = 'template_import' AND org_id IS ? AND target_id = ?
         AND status IN ('queued', 'running')
         AND EXISTS (SELECT 1 FROM template_imports i WHERE ${identitySql}
           AND i.step IN ('queued', 'extract') AND (${auth.sql}))
       RETURNING instance_id`,
      [
        identity.uploadId,
        identity.orgId,
        identity.uploadId,
        ...identityParams(identity),
        ...auth.params,
      ],
    ),
    stmt(
      db,
      `UPDATE template_imports AS i SET step = 'extract', updated_at = MAX(updated_at, ?)
       WHERE ${identitySql} AND i.step IN ('queued', 'extract') AND changes() = 1
         AND EXISTS (SELECT 1 FROM workflow_runs w WHERE w.instance_id = i.upload_id
           AND w.kind = 'template_import' AND w.org_id IS i.org_id
           AND w.target_id = i.upload_id AND w.status = 'running')
         AND (${auth.sql})
       RETURNING upload_id`,
      [now, ...identityParams(identity), ...auth.params],
    ),
  ]);
  return !!results[0]?.results.length && !!results[1]?.results.length;
}

/** Advances a still-authorized import without changing a terminal or foreign run. */
export async function advanceImport(
  db: D1Database,
  identity: ImportIdentity,
  authority: TemplateAuthority,
  from: string,
  to: string,
  now: number,
): Promise<boolean> {
  const auth = templateAuthorityPredicate(authority, 'i.org_id', now, true);
  const result = await run(
    db,
    `UPDATE template_imports AS i SET step = ?, updated_at = MAX(updated_at, ?)
     WHERE ${identitySql} AND i.step IN (?, ?)
       AND EXISTS (SELECT 1 FROM workflow_runs w WHERE w.instance_id = i.upload_id
         AND w.kind = 'template_import' AND w.org_id IS i.org_id
         AND w.target_id = i.upload_id AND w.status = 'running')
       AND (${auth.sql})`,
    [to, now, ...identityParams(identity), from, to, ...auth.params],
  );
  return result.changes === 1;
}

/** Failure is compensation, so a revoked principal can still fail its own import. */
export async function recordImportFailure(
  db: D1Database,
  identity: ImportIdentity,
  report: ValidationReport,
  code: string,
  now: number,
): Promise<boolean> {
  const results = await db.batch([
    stmt(
      db,
      `UPDATE template_imports AS i SET step = 'failed', report = ?, error = ?, updated_at = MAX(updated_at, ?)
       WHERE ${identitySql}
         AND (COALESCE(i.step, '') NOT IN ('done', 'failed') OR (i.step = 'failed' AND i.error = ?))
         AND EXISTS (SELECT 1 FROM workflow_runs w WHERE w.instance_id = i.upload_id
           AND w.kind = 'template_import' AND w.org_id IS i.org_id AND w.target_id = i.upload_id
           AND (w.status IN ('queued', 'running') OR (w.status = 'errored' AND w.error_code = ?)))
       RETURNING upload_id`,
      [JSON.stringify(report), code, now, ...identityParams(identity), code, code],
    ),
    stmt(
      db,
      `UPDATE workflow_runs AS w SET status = 'errored', finished_at = ?, error_code = ?
       WHERE w.instance_id = ? AND w.kind = 'template_import' AND w.org_id IS ? AND w.target_id = ?
         AND (w.status IN ('queued', 'running') OR (w.status = 'errored' AND w.error_code = ?))
         AND changes() = 1
         AND EXISTS (SELECT 1 FROM template_imports i WHERE ${identitySql}
           AND i.step = 'failed' AND i.error = ?)
       RETURNING instance_id`,
      [
        now,
        code,
        identity.uploadId,
        identity.orgId,
        identity.uploadId,
        code,
        ...identityParams(identity),
        code,
      ],
    ),
  ]);
  return !!results[0]?.results.length && !!results[1]?.results.length;
}

/** Atomically completes only the matching live import, with the same authority fence as its write. */
export async function completeImport(
  db: D1Database,
  identity: ImportIdentity,
  authority: TemplateAuthority,
  templateId: string,
  version: string,
  report: ValidationReport,
  now: number,
): Promise<boolean> {
  const importAuth = templateAuthorityPredicate(authority, 'i.org_id', now, true);
  const runAuth = templateAuthorityPredicate(authority, 'w.org_id', now, true);
  const results = await db.batch([
    stmt(
      db,
      `UPDATE template_imports AS i SET step = 'done', template_id = ?, version = ?, report = ?,
         error = NULL, updated_at = MAX(updated_at, ?)
       WHERE ${identitySql}
         AND (i.step = 'persist' OR (i.step = 'done' AND i.template_id = ? AND i.version = ?))
         AND EXISTS (SELECT 1 FROM workflow_runs w WHERE w.instance_id = i.upload_id
           AND w.kind = 'template_import' AND w.org_id IS i.org_id
           AND ((w.status = 'running' AND w.target_id = i.upload_id)
             OR (w.status = 'complete' AND w.target_id = ?)))
         AND (${importAuth.sql})
       RETURNING upload_id`,
      [
        templateId,
        version,
        JSON.stringify(report),
        now,
        ...identityParams(identity),
        templateId,
        version,
        templateId,
        ...importAuth.params,
      ],
    ),
    stmt(
      db,
      `UPDATE workflow_runs AS w SET status = 'complete', finished_at = ?, error_code = NULL, target_id = ?
       WHERE w.instance_id = ? AND w.kind = 'template_import' AND w.org_id IS ?
         AND ((w.status = 'running' AND w.target_id = ?) OR (w.status = 'complete' AND w.target_id = ?))
         AND changes() = 1
         AND EXISTS (SELECT 1 FROM template_imports i WHERE ${identitySql}
           AND i.step = 'done' AND i.template_id = ? AND i.version = ?)
         AND (${runAuth.sql})
       RETURNING instance_id`,
      [
        now,
        templateId,
        identity.uploadId,
        identity.orgId,
        identity.uploadId,
        templateId,
        ...identityParams(identity),
        templateId,
        version,
        ...runAuth.params,
      ],
    ),
  ]);
  return !!results[0]?.results.length && !!results[1]?.results.length;
}
