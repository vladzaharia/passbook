import { batch, stmt } from '../../platform/db.ts';
import type { TemplateAuthority } from './access.ts';
import { templateAuthorityPredicate } from './repo-authority.ts';

interface TemplateUpload {
  uploadId: string;
  orgId: string | null;
  objectKey: string;
  createdBy: string;
}

/** Atomically queue an authorized import and its workflow run. */
export async function queueTemplateUpload(
  db: D1Database,
  upload: TemplateUpload,
  name: string | null,
  authority: TemplateAuthority,
  now: number,
): Promise<D1Result[]> {
  const importGuard = templateAuthorityPredicate(authority, '?', now);
  const workflowGuard = templateAuthorityPredicate(authority, 'i.org_id', now);
  return batch(db, [
    stmt(
      db,
      `INSERT INTO template_imports (upload_id, org_id, name, object_key, step, created_by, created_at, updated_at)
       SELECT ?, ?, ?, ?, 'queued', ?, ?, ? WHERE (${importGuard.sql})
       RETURNING upload_id`,
      [
        upload.uploadId,
        upload.orgId,
        name,
        upload.objectKey,
        upload.createdBy,
        now,
        now,
        upload.orgId,
        ...importGuard.params,
      ],
    ),
    stmt(
      db,
      `INSERT INTO workflow_runs (instance_id, kind, org_id, target_id, status, started_at)
       SELECT i.upload_id, 'template_import', i.org_id, i.upload_id, 'queued', ?
       FROM template_imports i
       WHERE i.upload_id = ? AND changes() = 1 AND (${workflowGuard.sql})
       RETURNING instance_id`,
      [now, upload.uploadId, ...workflowGuard.params],
    ),
  ]);
}

/** Trusted compensation for this request's committed but still-unstarted upload. */
export async function recordUploadStartFailure(
  db: D1Database,
  upload: Pick<TemplateUpload, 'uploadId' | 'orgId' | 'objectKey'>,
  startedAt: number,
  now: number,
): Promise<void> {
  await batch(db, [
    stmt(
      db,
      `UPDATE workflow_runs SET status = 'errored', finished_at = ?, error_code = 'WORKFLOW_START'
       WHERE instance_id = ? AND kind = 'template_import' AND org_id IS ?
         AND target_id = ? AND started_at = ? AND status = 'queued'
         AND (
           EXISTS (
             SELECT 1 FROM template_imports i
             WHERE i.upload_id = workflow_runs.instance_id AND i.org_id IS workflow_runs.org_id
               AND i.object_key = ? AND i.created_at = ? AND i.step = 'queued'
           ) OR NOT EXISTS (
             SELECT 1 FROM template_imports i WHERE i.upload_id = workflow_runs.instance_id
           )
         )`,
      [now, upload.uploadId, upload.orgId, upload.uploadId, startedAt, upload.objectKey, startedAt],
    ),
    stmt(
      db,
      `UPDATE template_imports SET step = 'failed', error = 'WORKFLOW_START', updated_at = MAX(updated_at, ?)
       WHERE upload_id = ? AND org_id IS ? AND object_key = ? AND created_at = ? AND step = 'queued'
         AND (
           EXISTS (
             SELECT 1 FROM workflow_runs w
             WHERE w.instance_id = template_imports.upload_id AND w.kind = 'template_import'
               AND w.org_id IS template_imports.org_id AND w.target_id = w.instance_id
               AND w.started_at = ? AND w.status = 'errored' AND w.error_code = 'WORKFLOW_START'
           ) OR NOT EXISTS (
             SELECT 1 FROM workflow_runs w WHERE w.instance_id = template_imports.upload_id
           )
         )`,
      [now, upload.uploadId, upload.orgId, upload.objectKey, startedAt, startedAt],
    ),
  ]);
}
