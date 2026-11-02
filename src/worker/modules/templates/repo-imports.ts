import type { ValidationReport } from '../../../passkit/types.ts';
import { first, run, stmt } from '../../platform/db.ts';

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
    stmt(
      db,
      `INSERT INTO workflow_runs (instance_id, kind, org_id, target_id, status, started_at)
       VALUES (?, 'template_import', ?, ?, 'queued', ?)`,
      [row.uploadId, row.orgId, row.uploadId, row.now],
    ),
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

export async function updateImport(
  db: D1Database,
  uploadId: string,
  patch: {
    step?: string;
    templateId?: string;
    version?: string;
    report?: ValidationReport;
    error?: string | null;
  },
  now: number,
): Promise<void> {
  await run(
    db,
    `UPDATE template_imports SET step = COALESCE(?, step), template_id = COALESCE(?, template_id),
       version = COALESCE(?, version), report = COALESCE(?, report), error = COALESCE(?, error), updated_at = ?
     WHERE upload_id = ?`,
    [
      patch.step ?? null,
      patch.templateId ?? null,
      patch.version ?? null,
      patch.report ? JSON.stringify(patch.report) : null,
      patch.error ?? null,
      now,
      uploadId,
    ],
  );
}

export async function setWorkflowRun(
  db: D1Database,
  instanceId: string,
  status: 'queued' | 'running' | 'complete' | 'errored' | 'terminated',
  now: number,
  extra: { errorCode?: string | null; targetId?: string | null } = {},
): Promise<void> {
  const done = status === 'complete' || status === 'errored' || status === 'terminated';
  await run(
    db,
    `UPDATE workflow_runs SET status = ?, finished_at = ?, error_code = ?, target_id = COALESCE(?, target_id)
     WHERE instance_id = ?`,
    [status, done ? now : null, extra.errorCode ?? null, extra.targetId ?? null, instanceId],
  );
}

export async function insertWorkflowRun(
  db: D1Database,
  row: {
    instanceId: string;
    kind: 'template_import' | 'bulk_reissue' | 'connection_sync';
    orgId: string | null;
    targetId: string | null;
    now: number;
  },
): Promise<void> {
  await run(
    db,
    `INSERT INTO workflow_runs (instance_id, kind, org_id, target_id, status, started_at)
     VALUES (?, ?, ?, ?, 'queued', ?)`,
    [row.instanceId, row.kind, row.orgId, row.targetId, row.now],
  );
}
