import { authorityPredicate } from '../../platform/authority-read.ts';
import { type HistoryRow, scanReferenceOf } from './history-row.ts';
import { readHistoryPage } from './repo-history-rows.ts';
import type { ScanReadAuthority } from './repo-read-authority.ts';
import { loadManifests, type ManifestCache, manifestCacheKey } from './repo-template-manifests.ts';

/** Test-only: a fence that holds for one org in live mode, so a page statement runs without a session. */
export function testFence(orgId: string, mode: 'live' | 'test' = 'live'): ScanReadAuthority {
  // Only its SQL fragments are used (the join, the tenant); the CTEs below are the test's own.
  const predicate = authorityPredicate(
    { kind: 'scanner', scannerId: 'test', credentialEpoch: 0 },
    { scope: 'org_mode', now: 0 },
  );
  return {
    ctes: `actor AS MATERIALIZED (SELECT ? AS org_id, ? AS mode),
      actor_ok AS MATERIALIZED (SELECT 1 AS present, org_id, mode, NULL AS limit_key FROM actor)`,
    params: [orgId, mode],
    rows: predicate.rows,
    anchor: predicate.anchor,
    present: predicate.ok,
    platform: predicate.platform,
    tenantOnce: (alias, table) => predicate.tenant(alias, table, 'org_mode'),
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
