import { all, chunk, first, likeEscape, placeholders, run, stmt } from '../../platform/db.ts';

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

/**
 * Newest first; `before` is the exclusive id bound (UUIDv7 ids sort by creation time). `q` matches
 * the name or slug.
 */
export function listOrgRows(db: D1Database, before: string | undefined, limit: number, q?: string) {
  const term = q?.trim().toLowerCase();
  const like = term ? `%${likeEscape(term)}%` : null;
  return all<OrgRow>(
    db,
    `SELECT ${COLUMNS} FROM orgs WHERE status != 'deleted' AND id < ?
       ${like ? "AND (lower(name) LIKE ? ESCAPE '\\' OR slug LIKE ? ESCAPE '\\')" : ''}
     ORDER BY id DESC LIMIT ?`,
    like ? [before ?? '￿', like, like, limit] : [before ?? '￿', limit],
  );
}

export async function setOrgStatus(
  db: D1Database,
  id: string,
  status: 'active' | 'suspended',
  now: number,
): Promise<void> {
  await run(db, 'UPDATE orgs SET status = ?, updated_at = ? WHERE id = ?', [status, now, id]);
}

export async function setOrgBranding(
  db: D1Database,
  id: string,
  branding: string,
  now: number,
): Promise<void> {
  await run(db, 'UPDATE orgs SET branding = ?, updated_at = ? WHERE id = ?', [branding, now, id]);
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

export type OrgState = OrgRow['status'];

/** The one lookup behind every "does this org exist / may it be used" question. */
export async function orgState(db: D1Database, id: string): Promise<OrgState | null> {
  const row = await first<{ status: OrgState }>(db, 'SELECT status FROM orgs WHERE id = ?', [id]);
  return row?.status ?? null;
}

/** Creating anything needs an active org. */
export async function orgIsActive(db: D1Database, id: string): Promise<boolean> {
  return (await orgState(db, id)) === 'active';
}

/** Reads exclude deleted orgs; a suspended one is still readable. */
export async function orgIsReadable(db: D1Database, id: string): Promise<boolean> {
  const state = await orgState(db, id);
  return state !== null && state !== 'deleted';
}

export async function orgDefaultIdentityId(db: D1Database, orgId: string): Promise<string | null> {
  const row = await first<{ default_identity_id: string | null }>(
    db,
    "SELECT default_identity_id FROM orgs WHERE id = ? AND status != 'deleted'",
    [orgId],
  );
  return row?.default_identity_id ?? null;
}

export function orgIdentity(
  db: D1Database,
  orgId: string,
): Promise<{ id: string; name: string; slug: string } | null> {
  return first(db, "SELECT id, name, slug FROM orgs WHERE id = ? AND status != 'deleted'", [orgId]);
}

/** orgs.branding as stored (JSON text), or null when the org is gone. */
export async function orgBrandingJson(db: D1Database, orgId: string): Promise<string | null> {
  const row = await first<{ branding: string }>(db, 'SELECT branding FROM orgs WHERE id = ?', [
    orgId,
  ]);
  return row?.branding ?? null;
}

export function orgForPass(db: D1Database, orgId: string) {
  return first<{
    id: string;
    slug: string;
    name: string;
    status: string;
    default_identity_id: string | null;
    branding: string | null;
  }>(db, 'SELECT id, slug, name, status, default_identity_id, branding FROM orgs WHERE id = ?', [
    orgId,
  ]);
}

/** Creates a baked org on first sight; an existing slug is left as it is. */
export function ensureOrgStmt(
  db: D1Database,
  o: { id: string; slug: string; name: string; now: number },
): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO orgs (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (slug) DO NOTHING`,
    [o.id, o.slug, o.name, o.now, o.now],
  );
}
