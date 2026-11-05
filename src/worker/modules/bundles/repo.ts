import type { Mode } from '../../../shared/contracts/common.ts';
import { all, chunk, first, placeholders, stmt } from '../../platform/db.ts';
import { readMode, type ScopeArg, scopeOrg } from '../passes/scope.ts';

export interface BundleRow {
  id: string;
  org_id: string;
  mode: Mode;
  name: string;
  token: string;
  token_rotated_at: number | null;
  holder_email: string | null;
  created_at: number;
}

export interface MemberRow {
  bundle_id: string;
  pass_id: string;
  title: string;
  status: 'active' | 'voided';
}

export interface NewBundle {
  id: string;
  orgId: string;
  mode: Mode;
  name: string;
  token: string;
  holderEmail: string | null;
  actor: { type: string; id: string | null };
  passIds: string[];
  now: number;
}

/** The bundle and its passes, in the order given; batch them with the audit row. */
export function insertBundleStmts(db: D1Database, b: NewBundle): D1PreparedStatement[] {
  return [
    stmt(
      db,
      `INSERT INTO bundles (id, org_id, mode, name, token, holder_email, created_by_type, created_by_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [b.id, b.orgId, b.mode, b.name, b.token, b.holderEmail, b.actor.type, b.actor.id, b.now],
    ),
    ...b.passIds.map((passId, position) =>
      stmt(db, 'INSERT INTO bundle_passes (bundle_id, pass_id, position) VALUES (?, ?, ?)', [
        b.id,
        passId,
        position,
      ]),
    ),
  ];
}

/** Null scope = platform-wide. A bundle outside the scope (org, or an API key's mode) reads as missing. */
export function getBundle(db: D1Database, id: string, scope: ScopeArg) {
  const orgScope = scopeOrg(scope);
  const mode = readMode(scope);
  return first<BundleRow>(
    db,
    'SELECT * FROM bundles WHERE id = ? AND (? IS NULL OR org_id = ?) AND (? IS NULL OR mode = ?)',
    [id, orgScope, orgScope, mode, mode],
  );
}

export const getBundleByToken = (db: D1Database, token: string) =>
  first<BundleRow>(db, 'SELECT * FROM bundles WHERE token = ?', [token]);

export interface BundleListFilter {
  orgScope: string | null;
  orgId?: string | undefined;
  mode: Mode;
  passId?: string | undefined;
  cursor?: string | undefined;
  limit: number;
}

/** `org_id = ?` is added only when an org is set, so SQLite can pick bundles_org over bundles_mode. */
export function listBundleRows(db: D1Database, f: BundleListFilter) {
  const orgId = f.orgScope ?? f.orgId ?? null;
  return all<BundleRow>(
    db,
    `SELECT * FROM bundles
     WHERE mode = ?${orgId ? ' AND org_id = ?' : ''}
       AND (? IS NULL OR EXISTS (SELECT 1 FROM bundle_passes bp WHERE bp.bundle_id = bundles.id AND bp.pass_id = ?))
       AND (? IS NULL OR id < ?)
     ORDER BY id DESC LIMIT ?`,
    [
      f.mode,
      ...(orgId ? [orgId] : []),
      f.passId ?? null,
      f.passId ?? null,
      f.cursor ?? null,
      f.cursor ?? null,
      f.limit,
    ],
  );
}

/** The bundles' passes in order, leaving out passes that were deleted. */
export async function membersOf(db: D1Database, bundleIds: string[]): Promise<MemberRow[]> {
  const rows: MemberRow[] = [];
  for (const part of chunk(bundleIds)) {
    rows.push(
      ...(await all<MemberRow>(
        db,
        `SELECT bp.bundle_id, bp.pass_id, COALESCE(p.display_title, p.serial) AS title,
                CASE WHEN p.removed_at IS NOT NULL THEN 'voided' ELSE p.status END AS status
         FROM bundle_passes bp JOIN passes p ON p.id = bp.pass_id
         WHERE p.deleted_at IS NULL AND bp.bundle_id IN (${placeholders(part.length)})
         ORDER BY bp.bundle_id, bp.position`,
        part,
      )),
    );
  }
  return rows;
}

export const setBundleTokenStmt = (db: D1Database, id: string, token: string, now: number) =>
  stmt(db, 'UPDATE bundles SET token = ?, token_rotated_at = ? WHERE id = ?', [token, now, id]);

export const deleteBundleStmt = (db: D1Database, id: string) =>
  stmt(db, 'DELETE FROM bundles WHERE id = ?', [id]);

export interface PackRow {
  id: string;
  object_key: string;
  object_size: number | null;
}

/** The bundle's passes that can be added: not voided, not removed, not deleted. */
export const listAddablePasses = (db: D1Database, bundleId: string) =>
  all<PackRow>(
    db,
    `SELECT p.id, p.object_key, p.object_size FROM bundle_passes bp
     JOIN passes p ON p.id = bp.pass_id
     WHERE bp.bundle_id = ? AND p.status = 'active' AND p.deleted_at IS NULL AND p.removed_at IS NULL
     ORDER BY bp.position`,
    [bundleId],
  );
