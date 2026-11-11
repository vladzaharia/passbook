import { all, first, run } from '../../platform/db.ts';

type Db = D1Database;

export { emailsOf, getUser } from '../auth/repo.ts';
export { getSession, listLiveSessions } from '../auth/repo-sessions.ts';

export interface MyPassRow {
  id: string;
  org_id: string;
  template_id: string;
  template_version: string;
  display_title: string | null;
  display_subtitle: string | null;
  status: 'active' | 'voided';
  mode: 'live' | 'test';
  version: number;
  link_generation: number;
  connection_id: string | null;
  external_ref: string | null;
  test_data_quarantined: number;
  deleted_at: number | null;
  modified_at: number;
  removed_at: number | null;
  removal_message: string | null;
  last_refreshed_at: number | null;
  refresh_requested_at: number | null;
  download_token: string;
  template_name: string;
  org_name: string;
  org_status: string;
  pass_json: string | null;
  /** 1 when a device registered the pass. */
  registered: number;
}

// pass_versions keeps the built pass.json for recent versions; it is what the card renders.
const SELECT = `
  SELECT p.id, p.org_id, p.template_id, p.template_version, p.display_title, p.display_subtitle, p.status, p.mode, p.modified_at, p.removed_at, p.removal_message, p.last_refreshed_at,
         p.version, p.link_generation, p.connection_id, p.external_ref, p.test_data_quarantined, p.deleted_at,
         p.refresh_requested_at, p.download_token, t.name AS template_name, o.name AS org_name, o.status AS org_status,
         COALESCE(pv.pass_json, p.pending_pass_json) AS pass_json,
         EXISTS (SELECT 1 FROM registrations r WHERE r.pass_id = p.id) AS registered
  FROM passes p
  JOIN templates t ON t.id = p.template_id
  JOIN orgs o ON o.id = p.org_id
  LEFT JOIN pass_versions pv ON pv.pass_id = p.id AND pv.version = p.version`;

export const listMyPasses = (db: Db, userId: string, cursor: string | undefined, limit: number) =>
  all<MyPassRow>(
    db,
    `${SELECT} WHERE p.owner_user_id = ? AND p.test_data_quarantined = 0 ${cursor ? 'AND p.id < ?' : ''} ORDER BY p.id DESC LIMIT ?`,
    cursor ? [userId, cursor, limit + 1] : [userId, limit + 1],
  );

export const getMyPass = (db: Db, userId: string, passId: string) =>
  first<MyPassRow>(db, `${SELECT} WHERE p.owner_user_id = ? AND p.id = ? AND p.test_data_quarantined = 0`, [userId, passId]);

export async function removeEmail(db: Db, userId: string, email: string): Promise<boolean> {
  const { changes } = await run(db, 'DELETE FROM user_emails WHERE user_id = ? AND email = ?', [
    userId,
    email,
  ]);
  return changes > 0;
}

/** Sign-in emails go to `email`, which must be one of the user's verified addresses. */
export async function setPrimaryEmail(db: Db, userId: string, email: string): Promise<boolean> {
  const { changes } = await run(
    db,
    `UPDATE users SET primary_email = ?
     WHERE id = ? AND EXISTS (SELECT 1 FROM user_emails WHERE user_id = ? AND email = ?)`,
    [email, userId, userId, email],
  );
  return changes > 0;
}

// A pass already in someone's Wallet leaves the Add all bundle (re-adding stays per pass).
const NOT_IN_WALLET = 'NOT EXISTS (SELECT 1 FROM registrations r WHERE r.pass_id = passes.id)';

export interface BundleRow {
  id: string;
  object_key: string;
  object_size: number | null;
}

export const countBundlePasses = async (db: Db, userId: string) =>
  (
    await first<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM passes WHERE owner_user_id = ? AND status = 'active'
       AND deleted_at IS NULL AND removed_at IS NULL AND test_data_quarantined = 0 AND ${NOT_IN_WALLET}`,
      [userId],
    )
  )?.n ?? 0;

export const listBundlePasses = (db: Db, userId: string, limit: number, offset: number) =>
  all<BundleRow>(
    db,
    `SELECT id, object_key, object_size FROM passes
     WHERE owner_user_id = ? AND status = 'active' AND deleted_at IS NULL AND removed_at IS NULL
       AND test_data_quarantined = 0 AND ${NOT_IN_WALLET}
     ORDER BY id DESC LIMIT ? OFFSET ?`,
    [userId, limit, offset],
  );
