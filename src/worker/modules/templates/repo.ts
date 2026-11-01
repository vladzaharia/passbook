import type {
  AssetEntry,
  PassJson,
  PassStyle,
  TemplateManifest,
  ValidationReport,
} from '../../../passkit/types.ts';
import { all, first, run, stmt } from '../../platform/db.ts';

export interface TemplateRow {
  id: string;
  orgId: string | null;
  slug: string;
  name: string;
  description: string | null;
  origin: 'baked' | 'uploaded';
  activeVersion: string | null;
  status: 'active' | 'archived' | 'deleted';
  styles: PassStyle[];
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface VersionRow {
  templateId: string;
  version: string;
  manifest: TemplateManifest;
  passJson: PassJson;
  assets: AssetEntry[];
  report: ValidationReport;
  createdBy: string | null;
  createdAt: number;
}

interface TemplateSql {
  id: string;
  org_id: string | null;
  slug: string;
  name: string;
  description: string | null;
  origin: 'baked' | 'uploaded';
  active_version: string | null;
  status: 'active' | 'archived' | 'deleted';
  styles: string;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

interface VersionSql {
  template_id: string;
  version: string;
  manifest: string;
  pass_json: string;
  assets: string;
  report: string;
  created_by: string | null;
  created_at: number;
}

const TEMPLATE_COLUMNS =
  'id, org_id, slug, name, description, origin, active_version, status, styles, created_by, created_at, updated_at';

function templateRow(row: TemplateSql): TemplateRow {
  return {
    id: row.id,
    orgId: row.org_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    origin: row.origin,
    activeVersion: row.active_version,
    status: row.status,
    styles: JSON.parse(row.styles) as PassStyle[],
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function versionRow(row: VersionSql): VersionRow {
  const report = JSON.parse(row.report) as Partial<ValidationReport>;
  return {
    templateId: row.template_id,
    version: row.version,
    manifest: JSON.parse(row.manifest) as TemplateManifest,
    passJson: JSON.parse(row.pass_json) as PassJson,
    assets: JSON.parse(row.assets) as AssetEntry[],
    report: { ok: report.ok ?? true, issues: report.issues ?? [] },
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export async function getTemplate(db: D1Database, id: string): Promise<TemplateRow | null> {
  const row = await first<TemplateSql>(
    db,
    `SELECT ${TEMPLATE_COLUMNS} FROM templates WHERE id = ?`,
    [id],
  );
  return row ? templateRow(row) : null;
}

export async function findTemplateBySlug(
  db: D1Database,
  orgId: string | null,
  slug: string,
): Promise<TemplateRow | null> {
  const row = await first<TemplateSql>(
    db,
    `SELECT ${TEMPLATE_COLUMNS} FROM templates WHERE org_id IS ? AND slug = ?`,
    [orgId, slug],
  );
  return row ? templateRow(row) : null;
}

export interface ListFilter {
  /** String: that org plus platform templates. Null: platform only. Undefined: everything. */
  orgId?: string | null;
  origin?: 'baked' | 'uploaded';
  status?: TemplateRow['status'];
  includeArchived?: boolean;
  limit: number;
  cursor?: { createdAt: number; id: string } | null;
}

export interface ListedTemplate extends TemplateRow {
  passCount: number;
  orgName: string | null;
}

export async function listTemplates(db: D1Database, f: ListFilter): Promise<ListedTemplate[]> {
  const where: string[] = [];
  const params: (string | number | null)[] = [];
  if (f.status) {
    where.push('t.status = ?');
    params.push(f.status);
  } else where.push(f.includeArchived ? "t.status != 'deleted'" : "t.status = 'active'");
  if (f.orgId === null) where.push('t.org_id IS NULL');
  else if (f.orgId !== undefined) {
    where.push('(t.org_id = ? OR t.org_id IS NULL)');
    params.push(f.orgId);
  }
  if (f.origin) {
    where.push('t.origin = ?');
    params.push(f.origin);
  }
  if (f.cursor) {
    where.push('(t.created_at < ? OR (t.created_at = ? AND t.id < ?))');
    params.push(f.cursor.createdAt, f.cursor.createdAt, f.cursor.id);
  }
  const rows = await all<TemplateSql & { pass_count: number; org_name: string | null }>(
    db,
    `SELECT ${TEMPLATE_COLUMNS.split(', ')
      .map((c) => `t.${c}`)
      .join(', ')},
       (SELECT COUNT(*) FROM passes p WHERE p.template_id = t.id AND p.deleted_at IS NULL) AS pass_count,
       (SELECT o.name FROM orgs o WHERE o.id = t.org_id) AS org_name
     FROM templates t WHERE ${where.join(' AND ')}
     ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
    [...params, f.limit],
  );
  return rows.map((r) => ({ ...templateRow(r), passCount: r.pass_count, orgName: r.org_name }));
}

export async function countPasses(db: D1Database, templateId: string): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    'SELECT COUNT(*) AS n FROM passes WHERE template_id = ?',
    [templateId],
  );
  return row?.n ?? 0;
}

export async function setTemplateOrg(
  db: D1Database,
  id: string,
  orgId: string | null,
  now: number,
): Promise<void> {
  await run(db, 'UPDATE templates SET org_id = ?, updated_at = ? WHERE id = ?', [orgId, now, id]);
}

/** Live passes of orgs other than `orgId` that use any version of the template. */
export async function countPassesOutsideOrg(
  db: D1Database,
  templateId: string,
  orgId: string,
): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    'SELECT COUNT(*) AS n FROM passes WHERE template_id = ? AND org_id != ? AND deleted_at IS NULL',
    [templateId, orgId],
  );
  return row?.n ?? 0;
}

export async function listVersions(db: D1Database, templateId: string): Promise<VersionRow[]> {
  const rows = await all<VersionSql>(
    db,
    `SELECT template_id, version, manifest, pass_json, assets, report, created_by, created_at
     FROM template_versions WHERE template_id = ? ORDER BY created_at DESC, version DESC`,
    [templateId],
  );
  return rows.map(versionRow);
}

export async function getVersion(
  db: D1Database,
  templateId: string,
  version: string,
): Promise<VersionRow | null> {
  const row = await first<VersionSql>(
    db,
    `SELECT template_id, version, manifest, pass_json, assets, report, created_by, created_at
     FROM template_versions WHERE template_id = ? AND version = ?`,
    [templateId, version],
  );
  return row ? versionRow(row) : null;
}

export interface NewVersion {
  templateId: string;
  version: string;
  manifest: TemplateManifest;
  passJson: PassJson;
  assets: AssetEntry[];
  report: ValidationReport;
  createdBy: string | null;
  createdAt: number;
}

export function insertVersionStmt(db: D1Database, v: NewVersion): D1PreparedStatement {
  return stmt(
    db,
    `INSERT OR IGNORE INTO template_versions
       (template_id, version, manifest, pass_json, assets, report, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      v.templateId,
      v.version,
      JSON.stringify(v.manifest),
      JSON.stringify(v.passJson),
      JSON.stringify(v.assets),
      JSON.stringify(v.report),
      v.createdBy,
      v.createdAt,
    ],
  );
}

export interface NewTemplate {
  id: string;
  orgId: string | null;
  slug: string;
  name: string;
  description: string | null;
  activeVersion: string;
  styles: PassStyle[];
  createdBy: string | null;
  now: number;
}

export function insertUploadedTemplateStmt(db: D1Database, t: NewTemplate): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO templates (id, org_id, slug, name, description, origin, active_version, status, styles, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'uploaded', ?, 'active', ?, ?, ?, ?)`,
    [
      t.id,
      t.orgId,
      t.slug,
      t.name,
      t.description,
      t.activeVersion,
      JSON.stringify(t.styles),
      t.createdBy,
      t.now,
      t.now,
    ],
  );
}

export function activateStmt(
  db: D1Database,
  id: string,
  version: string,
  fields: { name: string; description: string | null; styles: PassStyle[]; now: number },
): D1PreparedStatement {
  return stmt(
    db,
    `UPDATE templates SET active_version = ?, name = ?, description = ?, styles = ?, status = 'active', updated_at = ?
     WHERE id = ?`,
    [version, fields.name, fields.description, JSON.stringify(fields.styles), fields.now, id],
  );
}

export async function setStatus(
  db: D1Database,
  id: string,
  status: TemplateRow['status'],
  now: number,
): Promise<void> {
  await run(db, 'UPDATE templates SET status = ?, updated_at = ? WHERE id = ?', [status, now, id]);
}

export async function deleteTemplate(db: D1Database, id: string): Promise<void> {
  await run(db, 'DELETE FROM templates WHERE id = ?', [id]);
}

export async function getOrgName(
  db: D1Database,
  orgId: string,
): Promise<{ id: string; name: string; slug: string } | null> {
  return first(db, "SELECT id, name, slug FROM orgs WHERE id = ? AND status != 'deleted'", [orgId]);
}

// Import progress

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
