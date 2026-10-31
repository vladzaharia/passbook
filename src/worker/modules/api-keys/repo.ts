import { all, first, run } from '../../platform/db.ts';

type Db = D1Database;

export interface ApiKeyRow {
  id: string;
  org_id: string | null;
  name: string;
  prefix: string;
  key_hash: string;
  scopes: string;
  created_by: string | null;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
}

export async function insertKey(db: Db, key: ApiKeyRow): Promise<void> {
  await run(
    db,
    `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      key.id,
      key.org_id,
      key.name,
      key.prefix,
      key.key_hash,
      key.scopes,
      key.created_by,
      key.created_at,
      key.expires_at,
    ],
  );
}

export const listKeys = (db: Db) =>
  all<ApiKeyRow>(db, 'SELECT * FROM api_keys ORDER BY created_at DESC, id DESC LIMIT 500');

export const getKey = (db: Db, id: string) =>
  first<ApiKeyRow>(db, 'SELECT * FROM api_keys WHERE id = ?', [id]);

/** The key plus its org's status; null org status means a platform key. */
export const findByPrefix = (db: Db, prefix: string) =>
  first<ApiKeyRow & { org_status: string | null }>(
    db,
    `SELECT k.*, o.status AS org_status FROM api_keys k LEFT JOIN orgs o ON o.id = k.org_id
     WHERE k.prefix = ?`,
    [prefix],
  );

export async function orgExists(db: Db, orgId: string): Promise<boolean> {
  return (
    (await first(db, "SELECT 1 AS found FROM orgs WHERE id = ? AND status = 'active'", [orgId])) !==
    null
  );
}

export async function revokeKey(db: Db, id: string, now: number): Promise<boolean> {
  const { changes } = await run(
    db,
    'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
    [now, id],
  );
  return changes > 0;
}

/** Writes at most once per interval. */
export async function touchKey(db: Db, id: string, now: number, everyMs: number): Promise<void> {
  await run(
    db,
    'UPDATE api_keys SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)',
    [now, id, now - everyMs],
  );
}
