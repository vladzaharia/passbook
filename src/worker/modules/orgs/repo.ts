import { all, chunk, first, placeholders, run } from '../../platform/db.ts';

export const COUNT_CAP = 100_000;

export interface OrgRow {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended' | 'deleted';
  default_identity_id: string | null;
  branding: string;
  created_at: number;
  updated_at: number;
}

export interface OrgCounts {
  passes: number;
  templates: number;
  connections: number;
  apiKeys: number;
}

const COLUMNS = 'id, slug, name, status, default_identity_id, branding, created_at, updated_at';

export function getOrgRow(db: D1Database, id: string): Promise<OrgRow | null> {
  return first<OrgRow>(db, `SELECT ${COLUMNS} FROM orgs WHERE id = ? AND status != 'deleted'`, [
    id,
  ]);
}

export async function slugTaken(db: D1Database, slug: string, exceptId?: string): Promise<boolean> {
  const row = await first(db, 'SELECT 1 AS x FROM orgs WHERE slug = ? AND id != ?', [
    slug,
    exceptId ?? '',
  ]);
  return row !== null;
}

/** Newest first; `before` is the exclusive id bound (UUIDv7 ids sort by creation time). */
export function listOrgRows(db: D1Database, before: string | undefined, limit: number) {
  return all<OrgRow>(
    db,
    `SELECT ${COLUMNS} FROM orgs WHERE status != 'deleted' AND id < ? ORDER BY id DESC LIMIT ?`,
    [before ?? '￿', limit],
  );
}

export async function insertOrg(db: D1Database, row: OrgRow): Promise<void> {
  await run(
    db,
    `INSERT INTO orgs (id, slug, name, status, default_identity_id, branding, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.slug,
      row.name,
      row.status,
      row.default_identity_id,
      row.branding,
      row.created_at,
      row.updated_at,
    ],
  );
}

export async function updateOrgRow(
  db: D1Database,
  row: Pick<
    OrgRow,
    'id' | 'slug' | 'name' | 'status' | 'default_identity_id' | 'branding' | 'updated_at'
  >,
): Promise<void> {
  await run(
    db,
    `UPDATE orgs SET slug = ?, name = ?, status = ?, default_identity_id = ?, branding = ?, updated_at = ?
     WHERE id = ?`,
    [row.slug, row.name, row.status, row.default_identity_id, row.branding, row.updated_at, row.id],
  );
}

export async function markOrgDeleted(db: D1Database, id: string, now: number): Promise<void> {
  await run(
    db,
    "UPDATE orgs SET status = 'deleted', default_identity_id = NULL, updated_at = ? WHERE id = ?",
    [now, id],
  );
}

/** Identity an org may default to: global (no org) or its own. */
export async function identityUsableBy(
  db: D1Database,
  identityId: string,
  orgId: string | null,
): Promise<boolean> {
  const row = await first<{ org_id: string | null }>(
    db,
    'SELECT org_id FROM signing_identities WHERE id = ?',
    [identityId],
  );
  return row !== null && (row.org_id === null || row.org_id === orgId);
}

const capped = (table: string, where: string) =>
  `(SELECT count(*) FROM (SELECT 1 FROM ${table} WHERE org_id = o.id${where} LIMIT ${COUNT_CAP}))`;

/** Per-org counts, each bounded by COUNT_CAP index rows. */
export async function countsFor(db: D1Database, orgIds: string[]): Promise<Map<string, OrgCounts>> {
  const out = new Map<string, OrgCounts>();
  for (const ids of chunk(orgIds)) {
    const rows = await all<{ id: string } & OrgCounts>(
      db,
      `SELECT o.id AS id,
         ${capped('passes', '')} AS passes,
         ${capped('templates', " AND status != 'deleted'")} AS templates,
         ${capped('connections', '')} AS connections,
         ${capped('api_keys', ' AND revoked_at IS NULL')} AS apiKeys
       FROM orgs o WHERE o.id IN (${placeholders(ids.length)})`,
      ids,
    );
    for (const { id, ...counts } of rows) out.set(id, counts);
  }
  return out;
}
