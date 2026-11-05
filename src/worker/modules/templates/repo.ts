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

export interface TemplateSql {
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

export const TEMPLATE_COLUMNS =
  'id, org_id, slug, name, description, origin, active_version, status, styles, created_by, created_at, updated_at';

export function templateRow(row: TemplateSql): TemplateRow {
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

export { orgIdentity as getOrgName } from '../orgs/repo.ts';

// Import progress

export * from './repo-imports.ts';
export * from './repo-stale.ts';
export * from './repo-usage.ts';
