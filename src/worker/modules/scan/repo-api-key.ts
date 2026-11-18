import { first } from '../../platform/db.ts';

/** The key still acts as this terminal: not revoked or expired, lists `scans:write`, bound to it, in its org and mode. */
export async function apiKeyActs(
  db: D1Database,
  key: { id: string; orgId: string; mode: string; scannerId: string },
  now: number,
): Promise<boolean> {
  const row = await first<{ ok: number }>(
    db,
    `SELECT 1 AS ok FROM api_keys k
     WHERE k.id = ? AND k.org_id = ? AND k.mode = ? AND k.revoked_at IS NULL
       AND (k.expires_at IS NULL OR k.expires_at > ?)
       AND EXISTS (SELECT 1 FROM json_each(k.scopes) j WHERE j.type = 'text' AND j.value = 'scans:write')
       AND EXISTS (SELECT 1 FROM api_key_terminals t WHERE t.key_id = k.id AND t.scanner_id = ?)`,
    [key.id, key.orgId, key.mode, now, key.scannerId],
  );
  return row !== null;
}

/** Whether the key was minted for this terminal. */
export async function keyBoundTo(
  db: D1Database,
  keyId: string,
  scannerId: string,
): Promise<boolean> {
  const row = await first<{ ok: number }>(
    db,
    'SELECT 1 AS ok FROM api_key_terminals WHERE key_id = ? AND scanner_id = ?',
    [keyId, scannerId],
  );
  return row !== null;
}

/** The org's `access_revision`, captured with the key so a suspend or membership change since refuses at commit. */
export async function orgAccessRevisionOf(db: D1Database, orgId: string): Promise<number | null> {
  const row = await first<{ access_revision: number }>(
    db,
    'SELECT access_revision FROM orgs WHERE id = ?',
    [orgId],
  );
  return row?.access_revision ?? null;
}
