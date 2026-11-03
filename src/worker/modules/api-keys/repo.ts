import { all, first, run, stmt } from '../../platform/db.ts';

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

export function insertKeyStmt(db: Db, key: ApiKeyRow): D1PreparedStatement {
  return stmt(
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

export interface KeyFilter {
  orgId?: string | undefined;
  state?: 'live' | 'revoked' | undefined;
  /** The last id of the previous page. */
  cursor?: string | undefined;
  limit: number;
}

function keyWhere(f: Pick<KeyFilter, 'orgId' | 'state'>) {
  const where: string[] = [];
  const params: string[] = [];
  if (f.orgId) {
    where.push('k.org_id = ?');
    params.push(f.orgId);
  }
  if (f.state === 'live') where.push('k.revoked_at IS NULL');
  if (f.state === 'revoked') where.push('k.revoked_at IS NOT NULL');
  return { where, params };
}

/** Newest first, with the creator's name (or email) for the actor chip. */
export function listKeys(db: Db, f: KeyFilter) {
  const { where, params } = keyWhere(f);
  if (f.cursor) {
    where.push('(k.created_at, k.id) < (SELECT created_at, id FROM api_keys WHERE id = ?)');
    params.push(f.cursor);
  }
  return all<ApiKeyRow & { created_by_name: string | null }>(
    db,
    `SELECT k.*, coalesce(u.name, u.primary_email) AS created_by_name
     FROM api_keys k LEFT JOIN users u ON u.id = k.created_by
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY k.created_at DESC, k.id DESC LIMIT ?`,
    [...params, f.limit],
  );
}

export async function countRevoked(db: Db, orgId: string | undefined): Promise<number> {
  const { where, params } = keyWhere({ orgId, state: 'revoked' });
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM api_keys k WHERE ${where.join(' AND ')}`,
    params,
  );
  return row?.n ?? 0;
}

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
