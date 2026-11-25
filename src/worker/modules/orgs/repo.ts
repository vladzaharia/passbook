import type { Mode } from '../../../shared/contracts/common.ts';
import { all, chunk, containsMatch, first, placeholders, stmt } from '../../platform/db.ts';

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
  /** Moves with name, slug, branding, default identity and org settings; the CAS for edits. */
  config_revision: number;
  /** The user this personal org belongs to; set at creation, never changed. */
  personal_user_id: string | null;
  kind: 'standard' | 'developer';
}

export interface OrgCounts {
  passes: number;
  templates: number;
  connections: number;
  apiKeys: number;
  members: number;
}

const COLUMNS =
  'id, slug, name, status, default_identity_id, branding, created_at, updated_at, config_revision, personal_user_id, kind';

/** The org row as a batch statement, to read it in one transaction with the org's settings. */
export const orgRowStmt = (db: D1Database, id: string) =>
  stmt(db, `SELECT ${COLUMNS} FROM orgs WHERE id = ? AND status != 'deleted'`, [id]);

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
 * The platform directory, newest first; `before` is the exclusive id bound (UUIDv7 ids sort by creation
 * time). `q` matches the name or slug. Personal orgs belong to their owners and are never listed.
 */
export function listOrgRows(db: D1Database, before: string | undefined, limit: number, q?: string) {
  const term = q?.trim().toLowerCase();
  const name = term ? containsMatch('lower(name)', term) : null;
  const slug = term ? containsMatch('slug', term) : null;
  return all<OrgRow>(
    db,
    `SELECT ${COLUMNS} FROM orgs WHERE status != 'deleted' AND personal_user_id IS NULL AND id < ?
       ${name && slug ? `AND (${name.sql} OR ${slug.sql})` : ''}
     ORDER BY id DESC LIMIT ?`,
    name && slug ? [before ?? '￿', ...name.params, ...slug.params, limit] : [before ?? '￿', limit],
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

/** Per-org counts, each bounded by COUNT_CAP index rows. Passes are those of `mode`. */
export async function countsFor(
  db: D1Database,
  orgIds: string[],
  mode: Mode = 'live',
): Promise<Map<string, OrgCounts>> {
  const out = new Map<string, OrgCounts>();
  for (const ids of chunk(orgIds)) {
    const rows = await all<{ id: string } & OrgCounts>(
      db,
      `SELECT o.id AS id,
         ${capped('passes', ' AND mode = ?')} AS passes,
         ${capped('templates', " AND status != 'deleted'")} AS templates,
         ${capped('connections', '')} AS connections,
         ${capped('api_keys', ' AND revoked_at IS NULL')} AS apiKeys,
         ${capped('org_memberships', ' AND revoked_at IS NULL')} AS members
       FROM orgs o WHERE o.id IN (${placeholders(ids.length)})`,
      [mode, ...ids],
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

/**
 * An active org serves its passes. A closed org serves only a voided one: the last version Wallet fetches
 * before the purge (org-lifecycle). Alias the orgs row as `o` and the passes row as `p`.
 */
export const ORG_SERVES_SQL = `(o.status = 'active'
  OR (o.status = 'deleted' AND o.closed_at IS NOT NULL AND p.status = 'voided'))`;

/** The org serves this pass now: see `ORG_SERVES_SQL`. */
export async function orgServesPass(db: D1Database, passId: string): Promise<boolean> {
  return (
    (await first(
      db,
      `SELECT 1 AS x FROM passes p JOIN orgs o ON o.id = p.org_id AND ${ORG_SERVES_SQL} WHERE p.id = ?`,
      [passId],
    )) !== null
  );
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

export interface OrgForPassRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  default_identity_id: string | null;
  branding: string | null;
  /** 1 for a personal org: read here, from the row, never from a template or request. */
  personal: number;
}

export function orgForPassStmt(db: D1Database, orgId: string) {
  return stmt(
    db,
    'SELECT id, slug, name, status, default_identity_id, branding, personal_user_id IS NOT NULL AS personal FROM orgs WHERE id = ?',
    [orgId],
  );
}

export function orgForPass(db: D1Database, orgId: string) {
  return orgForPassStmt(db, orgId).first<OrgForPassRow>();
}
