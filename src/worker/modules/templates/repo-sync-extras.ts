import { all } from '../../platform/db.ts';
import { type TemplateVersionExtra, versionExtrasHash } from './repo-preview-extras.ts';

export async function bakedExtrasComplete(
  db: D1Database,
  templates: readonly { id: string; version: string }[],
): Promise<boolean> {
  const extraRows = await all<{
    templateId: string;
    version: string;
    seal: string;
    name: string | null;
    size: number | null;
    sha1: string | null;
    sha256: string | null;
    r2Key: string | null;
  }>(
    db,
    `SELECT json_extract(entry.value, '$.id') AS templateId,
       json_extract(entry.value, '$.version') AS version, s.extras_hash AS seal,
       e.name, e.size, e.sha1, e.sha256, e.r2_key AS r2Key
     FROM json_each(?) entry
     JOIN template_version_extra_sets s ON s.template_id = json_extract(entry.value, '$.id')
       AND s.version = json_extract(entry.value, '$.version')
     LEFT JOIN template_version_extras e ON e.template_id = s.template_id AND e.version = s.version`,
    [JSON.stringify(templates.map(({ id, version }) => ({ id, version })))],
  );
  const sets = new Map<string, { seal: string; extras: TemplateVersionExtra[] }>();
  for (const extra of extraRows) {
    const key = JSON.stringify([extra.templateId, extra.version]);
    const set = sets.get(key) ?? { seal: extra.seal, extras: [] };
    if (set.seal !== extra.seal) return false;
    if (extra.name !== null) {
      if (
        extra.size === null ||
        extra.sha1 === null ||
        extra.sha256 === null ||
        extra.r2Key === null
      )
        return false;
      set.extras.push({
        name: extra.name,
        size: extra.size,
        sha1: extra.sha1,
        sha256: extra.sha256,
        r2Key: extra.r2Key,
      });
    }
    sets.set(key, set);
  }
  for (const template of templates) {
    const set = sets.get(JSON.stringify([template.id, template.version]));
    if (!set || set.seal !== (await versionExtrasHash(set.extras))) return false;
  }
  return true;
}
