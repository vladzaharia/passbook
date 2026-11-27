import { all } from '../../platform/db.ts';

/** The SQL behind `referencedObjectKeys`; exported so a test can pin its query plan. */
export const REFERENCED_KEYS_SQL = `WITH k(key) AS (SELECT value FROM json_each(?1))
     SELECT key FROM k WHERE
       EXISTS (SELECT 1 FROM pass_versions v WHERE v.object_key = k.key AND (v.pass_id, v.version) NOT IN
         (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?2)))
       OR EXISTS (SELECT 1 FROM passes p WHERE p.object_key = k.key)
       -- Held for the row's life: a claim is not cleared on restore and compensation re-reads its snapshot.
       OR EXISTS (SELECT 1 FROM passes p WHERE p.removal_claim_object_key = k.key)
       OR EXISTS (SELECT 1 FROM pass_boundaries b WHERE b.object_key = k.key)
       -- Held for the row's life, terminal or not: the delivery ledger is immutable authority (0045), and
       -- the asset GC (repo-pass-asset-references.ts) treats these keys as held the same way.
       OR EXISTS (SELECT 1 FROM pass_issuance_deliveries d WHERE d.source_object_key = k.key)
       OR EXISTS (SELECT 1 FROM pass_issuance_deliveries d WHERE d.target_object_key = k.key)`;

/**
 * The keys among `keys` that a row still points at: a version, the pass, a removal claim, a boundary or a
 * delivery. `except` are (passId, version) rows being purged, which do not count as holders of their own key.
 */
export async function referencedObjectKeys(
  db: D1Database,
  keys: string[],
  except: { passId: string; version: number }[] = [],
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await all<{ key: string }>(db, REFERENCED_KEYS_SQL, [
    JSON.stringify(keys),
    JSON.stringify(except.map((e) => [e.passId, e.version])),
  ]);
  return new Set(rows.map((r) => r.key));
}

/**
 * The voided Apple copies (`passId`, `version`) nothing serves any more: the version was purged, or the
 * pass is gone. The current version's copy and a live retained version's copy stay.
 */
export async function deletableVoidedCopies(
  db: D1Database,
  copies: { passId: string; version: number }[],
): Promise<Set<string>> {
  if (copies.length === 0) return new Set();
  const rows = await all<{ pass_id: string; version: number }>(
    db,
    `SELECT json_extract(j.value, '$[0]') AS pass_id, json_extract(j.value, '$[1]') AS version
     FROM json_each(?1) j
     WHERE NOT EXISTS (SELECT 1 FROM passes p WHERE p.id = json_extract(j.value, '$[0]'))
       OR (NOT EXISTS (SELECT 1 FROM passes p WHERE p.id = json_extract(j.value, '$[0]')
             AND p.version = json_extract(j.value, '$[1]'))
         AND EXISTS (SELECT 1 FROM pass_versions v WHERE v.pass_id = json_extract(j.value, '$[0]')
             AND v.version = json_extract(j.value, '$[1]') AND v.purged_at IS NOT NULL))`,
    [JSON.stringify(copies.map((c) => [c.passId, c.version]))],
  );
  return new Set(rows.map((r) => `${r.pass_id}/${r.version}`));
}
