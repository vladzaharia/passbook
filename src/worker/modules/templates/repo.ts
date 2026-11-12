import type {
  AssetEntry,
  PassJson,
  PassStyle,
  TemplateManifest,
  ValidationReport,
} from '../../../passkit/types.ts';
import { all, first, stmt } from '../../platform/db.ts';
import { canonicalJson } from './package/hash.ts';
import type { SqlText } from './repo-version-hashes.ts';

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
  buildKey: string | null;
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
  build_key: string | null;
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
    buildKey: row.build_key,
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
    `SELECT template_id, version, build_key, manifest, pass_json, assets, report, created_by, created_at
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
    `SELECT template_id, version, build_key, manifest, pass_json, assets, report, created_by, created_at
     FROM template_versions WHERE template_id = ? AND version = ?`,
    [templateId, version],
  );
  return row ? versionRow(row) : null;
}

export interface NewVersion {
  templateId: string;
  version: string;
  buildKey: string;
  manifest: TemplateManifest;
  passJson: PassJson;
  assets: AssetEntry[];
  report: ValidationReport;
  createdBy: string | null;
  createdAt: number;
}

export interface StoredVersionContent {
  build_key: string | null;
  manifest: string;
  pass_json: string;
  assets: string;
  report: string;
}

/** Compare the complete stored content; creation metadata belongs to the first writer. */
export function versionContentMatches(
  stored: StoredVersionContent,
  incoming: Pick<NewVersion, 'buildKey' | 'manifest' | 'passJson' | 'assets' | 'report'>,
): boolean {
  return (
    (stored.build_key === null || stored.build_key === incoming.buildKey) &&
    canonicalJson(JSON.parse(stored.manifest)) === canonicalJson(incoming.manifest) &&
    canonicalJson(JSON.parse(stored.pass_json)) === canonicalJson(incoming.passJson) &&
    canonicalJson(JSON.parse(stored.assets)) === canonicalJson(incoming.assets) &&
    canonicalJson(JSON.parse(stored.report)) === canonicalJson(incoming.report)
  );
}

/** The insert (once) and the read-back that proves the stored content equals the incoming one. */
export function versionStatementSql(v: NewVersion): [SqlText, SqlText] {
  const content = [
    JSON.stringify(v.manifest),
    JSON.stringify(v.passJson),
    JSON.stringify(v.assets),
    JSON.stringify(v.report),
  ];
  return [
    {
      sql: `INSERT INTO template_versions
         (template_id, version, build_key, manifest, pass_json, assets, report, created_by, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM template_versions WHERE template_id = ? AND version = ?)
         AND NOT EXISTS (SELECT 1 FROM template_version_tombstones WHERE template_id = ? AND version = ?)`,
      params: [
        v.templateId,
        v.version,
        v.buildKey,
        ...content,
        v.createdBy,
        v.createdAt,
        v.templateId,
        v.version,
        v.templateId,
        v.version,
      ],
    },
    {
      sql: `SELECT CASE WHEN EXISTS (
         SELECT 1 FROM template_versions
         WHERE template_id = ? AND version = ? AND (build_key IS NULL OR build_key = ?)
           AND manifest = ? AND pass_json = ? AND assets = ? AND report = ?
       ) THEN 1 ELSE json('!') END`,
      params: [v.templateId, v.version, v.buildKey, ...content],
    },
  ];
}

/** Both statements belong in the same batch, before any dependent release writes. */
export function insertVersionStmts(db: D1Database, v: NewVersion): D1PreparedStatement[] {
  return versionStatementSql(v).map(({ sql, params }) => stmt(db, sql, params));
}

export { orgIdentity as getOrgName } from '../orgs/repo.ts';

// Import progress

export * from './repo-imports.ts';
export * from './repo-stale.ts';
export * from './repo-usage.ts';
