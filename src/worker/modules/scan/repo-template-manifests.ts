import { chunk, stmt } from '../../platform/db.ts';

/** A template version in an org's reach: its own template or a platform one. */
export interface ManifestKey {
  orgId: string;
  templateId: string;
  version: string;
}

/** Raw manifest JSON by key, or null for a version that does not exist. Private to one request. */
export type ManifestCache = Map<string, string | null>;

const KEYS_PER_STATEMENT = 30;

export const manifestCacheKey = (k: ManifestKey) => `${k.orgId}\0${k.templateId}\0${k.version}`;

/**
 * Fetch the manifests of template versions once per request. A version is immutable (an update
 * trigger refuses it and a deleted one leaves a tombstone), so a key maps to the same bytes
 * forever or to nothing: no fence is needed, and a missing version reads as no policy.
 */
export async function loadManifests(
  db: D1Database,
  cache: ManifestCache,
  keys: readonly ManifestKey[],
): Promise<void> {
  const missing = new Map<string, ManifestKey>();
  for (const key of keys) {
    const id = manifestCacheKey(key);
    if (!cache.has(id)) missing.set(id, key);
  }
  if (!missing.size) return;
  const groups = chunk([...missing.values()], KEYS_PER_STATEMENT);
  const results = await db.batch(
    groups.map((group) =>
      stmt(
        db,
        `WITH keys(org_id, template_id, version) AS (VALUES ${group.map(() => '(?, ?, ?)').join(', ')})
        SELECT keys.org_id, keys.template_id, keys.version, tv.manifest
        FROM keys
        JOIN template_versions tv ON tv.template_id = keys.template_id AND tv.version = keys.version
        JOIN templates t ON t.id = tv.template_id AND (t.org_id IS NULL OR t.org_id = keys.org_id)`,
        group.flatMap((key) => [key.orgId, key.templateId, key.version]),
      ),
    ),
  );
  for (const id of missing.keys()) cache.set(id, null);
  for (const result of results)
    for (const row of result.results as {
      org_id: string;
      template_id: string;
      version: string;
      manifest: string;
    }[])
      cache.set(
        manifestCacheKey({ orgId: row.org_id, templateId: row.template_id, version: row.version }),
        row.manifest,
      );
}
