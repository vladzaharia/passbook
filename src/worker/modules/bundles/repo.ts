import type { Mode } from '../../../shared/contracts/common.ts';
import { all, chunk, first, placeholders } from '../../platform/db.ts';
import type { PassDbRow } from '../passes/repo-map.ts';
import { readMode, type ScopeArg, scopeOrg } from '../passes/scope.ts';

const noQuarantinedMembers = (bundleId: string) =>
  `NOT EXISTS (SELECT 1 FROM bundle_passes quarantine_bp
    JOIN passes quarantine_p ON quarantine_p.id = quarantine_bp.pass_id
    WHERE quarantine_bp.bundle_id = ${bundleId} AND quarantine_p.test_data_quarantined = 1)`;

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
  removed_at: number | null;
}

/** Null scope = platform-wide. A bundle outside the scope (org, or an API key's mode) reads as missing. */
export function getBundle(db: D1Database, id: string, scope: ScopeArg) {
  const orgScope = scopeOrg(scope);
  const mode = readMode(scope);
  return first<BundleRow>(
    db,
    `SELECT * FROM bundles WHERE id = ? AND (? IS NULL OR org_id = ?) AND (? IS NULL OR mode = ?)
     AND ${noQuarantinedMembers('bundles.id')}`,
    [id, orgScope, orgScope, mode, mode],
  );
}

export const getBundleByToken = (db: D1Database, token: string) =>
  first<BundleRow>(
    db,
    `SELECT * FROM bundles WHERE token = ? AND ${noQuarantinedMembers('bundles.id')}`,
    [token],
  );

export interface BundleListFilter {
  orgId: string;
  mode: Mode;
  passId?: string | undefined;
  cursor?: string | undefined;
  limit: number;
}

/** Every list is scoped to an explicit organization. */
export function listBundleRows(db: D1Database, f: BundleListFilter) {
  return all<BundleRow>(
    db,
    `SELECT * FROM bundles
     WHERE mode = ? AND org_id = ?
       AND ${noQuarantinedMembers('bundles.id')}
       AND (? IS NULL OR EXISTS (SELECT 1 FROM bundle_passes bp WHERE bp.bundle_id = bundles.id AND bp.pass_id = ?
         AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = bp.pass_id AND t.state = 'pending')))
       AND (? IS NULL OR id < ?)
     ORDER BY id DESC LIMIT ?`,
    [
      f.mode,
      f.orgId,
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
                CASE WHEN p.removed_at IS NOT NULL THEN 'voided' ELSE p.status END AS status,
                p.removed_at
         FROM bundle_passes bp JOIN passes p ON p.id = bp.pass_id
         WHERE p.deleted_at IS NULL AND bp.bundle_id IN (${placeholders(part.length)})
           AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
             WHERE t.pass_id = p.id AND t.state = 'pending')
           AND ${noQuarantinedMembers('bp.bundle_id')}
         ORDER BY bp.bundle_id, bp.position`,
        part,
      )),
    );
  }
  return rows;
}

export type BundleEmailRow = PassDbRow & {
  email_bundle_id: string;
  email_bundle_org_id: string;
  email_bundle_mode: Mode;
  email_bundle_name: string;
  email_bundle_token: string;
  email_bundle_token_rotated_at: number | null;
  email_bundle_holder_email: string | null;
  email_bundle_created_at: number;
  email_bundle_position: number;
};

/** One database snapshot for the bundle and every live member. */
export function bundleEmailRows(db: D1Database, id: string): Promise<BundleEmailRow[]> {
  return all(
    db,
    `SELECT p.*, b.id AS email_bundle_id, b.org_id AS email_bundle_org_id,
       b.mode AS email_bundle_mode, b.name AS email_bundle_name, b.token AS email_bundle_token,
       b.token_rotated_at AS email_bundle_token_rotated_at,
       b.holder_email AS email_bundle_holder_email, b.created_at AS email_bundle_created_at,
       bp.position AS email_bundle_position
     FROM bundles b JOIN bundle_passes bp ON bp.bundle_id = b.id
     JOIN passes p ON p.id = bp.pass_id
     WHERE b.id = ? AND p.deleted_at IS NULL AND ${noQuarantinedMembers('b.id')}
       AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
         WHERE t.pass_id = p.id AND t.state = 'pending') ORDER BY bp.position`,
    [id],
  );
}
