import { all, first, placeholders } from '../../platform/db.ts';
import type { TemplateStamps } from './repo-scope-releases.ts';

type Db = D1Database;

/** Check tenant ownership separately from release availability, so foreign IDs remain masked. */
export async function countScopedTemplates(
  db: Db,
  orgId: string,
  ids: readonly string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM templates
     WHERE (org_id=? OR org_id IS NULL) AND status!='deleted' AND id IN (${placeholders(ids.length)})`,
    [orgId, ...ids],
  );
  return row?.n ?? 0;
}

/** Read only the immutable versions captured by the scoped release/legacy authority snapshot. */
export async function templateManifests(
  db: Db,
  orgId: string,
  stamps: TemplateStamps,
): Promise<{ id: string; version: string; manifest: string }[]> {
  const versions = [
    ...stamps.releases.map(({ templateId, version }) => ({ templateId, version })),
    ...stamps.legacy.flatMap(({ templateId, versions }) =>
      versions.map((version) => ({ templateId, version })),
    ),
  ];
  if (versions.length === 0) return [];
  return all(
    db,
    `SELECT t.id, v.version, v.manifest FROM json_each(?) selected
     JOIN templates t ON t.id=json_extract(selected.value,'$.templateId')
       AND (t.org_id=? OR t.org_id IS NULL) AND t.status!='deleted'
     JOIN template_versions v ON v.template_id=t.id AND v.version=json_extract(selected.value,'$.version')`,
    [JSON.stringify(versions), orgId],
  );
}
