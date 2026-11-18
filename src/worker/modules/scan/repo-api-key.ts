import { first } from '../../platform/db.ts';

/** The key still acts: not revoked or expired, lists `scans:write`, and belongs to this org and mode. */
export async function apiKeyActs(
  db: D1Database,
  key: { id: string; orgId: string; mode: string },
  now: number,
): Promise<boolean> {
  const row = await first<{ ok: number }>(
    db,
    `SELECT 1 AS ok FROM api_keys k
     WHERE k.id = ? AND k.org_id = ? AND k.mode = ? AND k.revoked_at IS NULL
       AND (k.expires_at IS NULL OR k.expires_at > ?)
       AND EXISTS (SELECT 1 FROM json_each(k.scopes) j WHERE j.type = 'text' AND j.value = 'scans:write')`,
    [key.id, key.orgId, key.mode, now],
  );
  return row !== null;
}
