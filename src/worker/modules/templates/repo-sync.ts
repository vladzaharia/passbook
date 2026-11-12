import { all, first } from '../../platform/db.ts';
import { bakedExtrasComplete } from './repo-sync-extras.ts';

export const ADOPTION_KEY = 'templates.baked_adoption';
export const HASH_KEY = 'templates.baked_hash';

export interface BakedTemplateSnapshot {
  org_id: string | null;
  origin: 'baked' | 'uploaded';
  name: string;
  description: string | null;
  active_version: string | null;
  status: 'active' | 'archived' | 'deleted';
  styles: string;
}

export interface BakedVersionSnapshot {
  manifest: string;
  pass_json: string;
  assets: string;
  report: string;
  build_key: string | null;
  created_by: string | null;
  created_at: number;
}

export interface BakedAdoptionSnapshot {
  value: string | null;
  legacy: string | null;
  legacyUpdatedAt: number | null;
}

export function bakedAdoptionSnapshot(db: D1Database): Promise<BakedAdoptionSnapshot> {
  return first<BakedAdoptionSnapshot>(
    db,
    `SELECT
       (SELECT value FROM settings WHERE scope = 'system' AND key = ?) AS value,
       (SELECT value FROM settings WHERE scope = 'system' AND key = ?) AS legacy,
       (SELECT updated_at FROM settings WHERE scope = 'system' AND key = ?) AS legacyUpdatedAt`,
    [ADOPTION_KEY, HASH_KEY, HASH_KEY],
  ).then((row) => {
    if (!row) throw new Error('Could not read baked template adoption state');
    return row;
  });
}

/** A settled isolate must notice a new build or an administrator's org reassignment. */
export async function bakedSyncComplete(
  db: D1Database,
  adoption: string,
  hash: string,
  templates: readonly { id: string; version: string }[],
  policy: {
    adapterRevision: number;
    adapterCapabilities: readonly string[];
    audiencePolicyRevision: number;
  },
): Promise<boolean> {
  const row = await first<{ complete: number }>(
    db,
    `SELECT CASE WHEN
       (SELECT value FROM settings WHERE scope = 'system' AND key = ?) = ? AND
       (SELECT value FROM settings WHERE scope = 'system' AND key = ?) = ? AND
       NOT EXISTS (
         SELECT 1 FROM json_each(?) entry
         LEFT JOIN templates t ON t.id = json_extract(entry.value, '$.id')
         WHERE t.id IS NULL OR t.origin != 'baked' OR t.status != 'active'
           OR t.active_version IS NOT json_extract(entry.value, '$.version')
           OR NOT EXISTS (
             SELECT 1 FROM template_version_extra_sets s
             WHERE s.template_id = t.id AND s.version = t.active_version
           )
           OR NOT EXISTS (
             SELECT 1 FROM template_version_hashes vh
             WHERE vh.template_id = t.id AND vh.version = t.active_version
           )
           OR EXISTS (
             SELECT 1 FROM json_each('["live","test"]') m WHERE NOT EXISTS (
               SELECT 1 FROM template_release_heads h JOIN template_releases r ON r.id = h.release_id
               WHERE h.template_id = t.id AND h.org_scope = COALESCE(t.org_id, '')
                 AND h.mode = m.value AND h.provider = 'apple'
               AND r.source = 'system' AND r.action = 'system' AND r.version = t.active_version
               AND r.content_hash = (SELECT vh.content_hash FROM template_version_hashes vh
                 WHERE vh.template_id = t.id AND vh.version = t.active_version)
               AND r.adapter_revision = ? AND json(r.adapter_capabilities) = json(?)
               AND r.audience_policy_revision = ?
             )
           )
       ) THEN 1 ELSE 0 END AS complete`,
    [
      ADOPTION_KEY,
      adoption,
      HASH_KEY,
      JSON.stringify(hash),
      JSON.stringify(templates.map(({ id, version }) => ({ id, version }))),
      policy.adapterRevision,
      JSON.stringify(policy.adapterCapabilities),
      policy.audiencePolicyRevision,
    ],
  );
  if (row?.complete !== 1) return false;
  return bakedExtrasComplete(db, templates);
}

export function bakedTemplateSnapshot(
  db: D1Database,
  id: string,
): Promise<BakedTemplateSnapshot | null> {
  return first(
    db,
    'SELECT org_id, origin, name, description, active_version, status, styles FROM templates WHERE id = ?',
    [id],
  );
}

export function bakedVersionSnapshot(
  db: D1Database,
  id: string,
  version: string,
): Promise<BakedVersionSnapshot | null> {
  return first(
    db,
    `SELECT manifest, pass_json, assets, report, build_key, created_by, created_at FROM template_versions
     WHERE template_id = ? AND version = ?`,
    [id, version],
  );
}

export function bakedOrgId(db: D1Database, slug: string): Promise<{ id: string } | null> {
  return first(db, 'SELECT id FROM orgs WHERE slug = ?', [slug]);
}

/** Active baked templates the build no longer ships. */
export async function staleBakedIds(db: D1Database, keepIds: readonly string[]): Promise<string[]> {
  const rows = await all<{ id: string }>(
    db,
    "SELECT id FROM templates WHERE origin = 'baked' AND status = 'active'",
  );
  const keep = new Set(keepIds);
  return rows.map((r) => r.id).filter((id) => !keep.has(id));
}
