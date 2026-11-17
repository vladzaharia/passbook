import { tenantFilter } from '../../platform/authority-read.ts';
import { type HistoryRow, scanReferenceOf } from './history-row.ts';
import { readHistoryPage } from './repo-history-rows.ts';
import type { ScanReadAuthority } from './repo-read-authority.ts';
import { loadManifests, type ManifestCache, manifestCacheKey } from './repo-template-manifests.ts';

/** Test-only: a fence that holds for one org in live mode, so a page statement runs without a session. */
export function testFence(orgId: string, mode: 'live' | 'test' = 'live'): ScanReadAuthority {
  return {
    ctes: `actor AS MATERIALIZED (SELECT ? AS org_id, ? AS mode),
      actor_ok AS MATERIALIZED (SELECT org_id, mode FROM actor)`,
    params: [orgId, mode],
    ok: 'EXISTS (SELECT 1 FROM actor_ok)',
    tenant: (alias, table) => tenantFilter(alias, table, 'org_mode'),
  };
}

/** Test-only: the rows of the given scan ids, whatever the ledger scope says. */
export async function testHistoryRows(
  db: D1Database,
  orgId: string,
  ids: readonly string[],
  now: number,
): Promise<HistoryRow[]> {
  const { rows } = await readHistoryPage(
    db,
    testFence(orgId),
    {
      where: `s.id IN (${ids.map(() => '?').join(', ')})`,
      params: ids,
      limit: Math.max(ids.length, 1),
    },
    now,
  );
  return rows;
}

/** Test-only: the original event, scan reference, personalization and manifests of one scan. */
export async function testHistoryProof(db: D1Database, orgId: string, scanId: string, now: number) {
  const [row] = await testHistoryRows(db, orgId, [scanId], now);
  const scan = row ? scanReferenceOf(row.raw) : null;
  if (!row?.ledger || !scan || !row.templateId) throw new Error('The scan has no recorded proof.');
  const manifests: ManifestCache = new Map();
  const key = (version: string | null) =>
    version === null ? null : { orgId, templateId: row.templateId as string, version };
  const keys = [key(row.raw.event_pinned_version), key(row.raw.event_active_version)].flatMap(
    (k) => (k ? [k] : []),
  );
  await loadManifests(db, manifests, keys);
  const manifest = (version: string | null) => {
    const k = key(version);
    return k ? (manifests.get(manifestCacheKey(k)) ?? null) : null;
  };
  return {
    event: row.ledger,
    scan,
    currentPersonalization: row.raw.current_personalization,
    versionPersonalization: row.raw.recorded_personalization,
    eventPinnedManifest: manifest(row.raw.event_pinned_version),
    eventActiveVersion: row.raw.event_active_version,
    eventActiveManifest: manifest(row.raw.event_active_version),
  };
}
