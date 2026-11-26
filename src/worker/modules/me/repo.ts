import { all, batch, first, run, stmt } from '../../platform/db.ts';
import { holderReissueCurrentSql } from '../holders/repo.ts';

type Db = D1Database;

export { emailsOf, getUser } from '../auth/repo.ts';
export { getSession, listLiveSessions } from '../auth/repo-sessions.ts';

export interface MyPassRow {
  id: string;
  org_id: string;
  identity_id: string;
  template_id: string;
  template_version: string;
  release_id: string | null;
  display_title: string | null;
  display_subtitle: string | null;
  status: 'active' | 'voided';
  mode: 'live' | 'test';
  version: number;
  revision: number;
  row_version: number;
  link_generation: number;
  credential_generation: number;
  lifecycle_generation: number;
  holder_email: string | null;
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
  /** The input; only a stamp card's count is read from it, to pick the strip. */
  personalization: string;
  /** 1 when a device registered the pass. */
  registered: number;
  /** 1 for an ended pass not yet attached to the account: listed, never written. */
  read_only: number;
}

// pass_versions keeps the built pass.json for recent versions; it is what the card renders. `version`
// also rises for a write that stores no artifact (a metadata-only sync or bind), so the card reads the
// newest stored version at or below it, like every other reader of the current pass.json.
const SELECT = `
  SELECT p.id, p.org_id, p.identity_id, p.template_id, p.template_version, p.display_title, p.display_subtitle, p.status, p.mode, p.modified_at, p.removed_at, p.removal_message, p.last_refreshed_at,
         p.version, p.revision, p.row_version, p.release_id, p.link_generation, p.credential_generation, p.lifecycle_generation,
         p.holder_email, p.connection_id, p.external_ref, p.test_data_quarantined, p.deleted_at,
         p.refresh_requested_at, p.download_token, p.personalization, t.name AS template_name, o.name AS org_name, o.status AS org_status,
         COALESCE((SELECT pv.pass_json FROM pass_versions pv
                   WHERE pv.pass_id = p.id AND pv.version <= p.version AND pv.pass_json IS NOT NULL
                   ORDER BY pv.version DESC LIMIT 1), p.pending_pass_json) AS pass_json,
         EXISTS (SELECT 1 FROM registrations r WHERE r.pass_id = p.id) AS registered,
         (p.owner_user_id IS NULL) AS read_only
  FROM passes p
  JOIN templates t ON t.id = p.template_id
  JOIN orgs o ON o.id = p.org_id`;

export const NO_PENDING_TRANSFER = `NOT EXISTS (SELECT 1 FROM pass_credential_transfers transfer
  WHERE transfer.pass_id = p.id AND transfer.state = 'pending')`;

/**
 * An ended pass (voided; removed once its removal is published) waiting for this account's verified
 * address: listed read-only, never attached or written. Not purged, not a joined card (a stranger's
 * typed address), not contested by another account. Three parameters: the user, three times.
 */
const ENDED_WAITING = `(p.owner_user_id IS NULL AND p.deleted_at IS NULL AND p.test_data_quarantined = 0
  AND p.status = 'voided' AND (p.removed_at IS NULL OR p.removal_published_generation = p.lifecycle_generation)
  AND EXISTS (SELECT 1 FROM user_emails e JOIN users u ON u.id = e.user_id
    WHERE e.user_id = ? AND u.status = 'active' AND e.email = p.holder_email)
  AND NOT EXISTS (SELECT 1 FROM users u2 JOIN user_emails e2 ON e2.user_id = u2.id
    WHERE u2.id != ? AND u2.status = 'active' AND e2.email = p.holder_email)
  AND NOT EXISTS (SELECT 1 FROM pass_attach_blocks b WHERE b.pass_id = p.id AND b.user_id = ?)
  AND NOT EXISTS (SELECT 1 FROM join_marks j WHERE j.pass_id = p.id)
  AND ${NO_PENDING_TRANSFER})`;
const OWNED = `(p.owner_user_id = ? AND p.deleted_at IS NULL AND p.test_data_quarantined = 0 AND ${NO_PENDING_TRANSFER})`;
/** What My passes shows: the owned passes, and the ended ones waiting for the address. */
const LISTED = `(${OWNED} OR ${ENDED_WAITING})`;
const listedBinds = (userId: string) => [userId, userId, userId, userId];

export const listMyPasses = (db: Db, userId: string, cursor: string | undefined, limit: number) =>
  all<MyPassRow>(
    db,
    `${SELECT} WHERE ${LISTED} ${cursor ? 'AND p.id < ?' : ''} ORDER BY p.id DESC LIMIT ?`,
    cursor ? [...listedBinds(userId), cursor, limit + 1] : [...listedBinds(userId), limit + 1],
  );

/** Owned passes only: every write (refresh, remove, help) starts here. */
export const getMyPass = (db: Db, userId: string, passId: string) =>
  first<MyPassRow>(db, `${SELECT} WHERE ${OWNED} AND p.id = ?`, [userId, passId]);

/** The detail read: owned, or ended and waiting for this account. */
export const getMyPassListed = (db: Db, userId: string, passId: string) =>
  first<MyPassRow>(db, `${SELECT} WHERE ${LISTED} AND p.id = ?`, [...listedBinds(userId), passId]);

/** Fence the whole page and its status notices in one final D1 snapshot. */
export async function portfolioSnapshot(db: Db, userId: string, ids: readonly string[]) {
  const results = await batch(db, [
    stmt(
      db,
      `${SELECT} JOIN json_each(?) expected ON expected.value = p.id
      WHERE ${LISTED}`,
      [JSON.stringify(ids), ...listedBinds(userId)],
    ),
    stmt(
      db,
      `SELECT t.pass_id AS passId, t.id AS transferId
      FROM pass_credential_transfers t JOIN passes p ON p.id = t.pass_id
      WHERE t.state = 'pending' AND t.requested_by_type = 'user' AND t.requested_by_id = ?
        AND t.target_owner_user_id IS NULL AND p.owner_user_id = ?
        AND EXISTS (SELECT 1 FROM pass_attach_blocks b WHERE b.pass_id = p.id AND b.user_id = ?)
      ORDER BY t.requested_at, t.id`,
      [userId, userId, userId],
    ),
    stmt(
      db,
      `SELECT p.id AS passId, o.name AS orgName, o.id AS orgId, p.display_title AS title
      FROM passes p JOIN orgs o ON o.id = p.org_id AND o.status = 'active'
      WHERE p.id IN (SELECT pass_id FROM pass_holder_reissue_required WHERE user_id = ?)
        AND ${holderReissueCurrentSql('p', '?')} ORDER BY p.id DESC`,
      [userId, userId],
    ),
  ]);
  return {
    current: (results[0]?.results ?? []) as MyPassRow[],
    pendingRemovals: (results[1]?.results ?? []) as { passId: string; transferId: string }[],
    reissueRequired: (results[2]?.results ?? []) as {
      passId: string;
      orgName: string;
      orgId: string;
      title: string | null;
    }[],
  };
}

/** The source owner is retained while pending; let the holder CAS report that conflict. */
export const getPassForRemoval = (db: Db, userId: string, passId: string) =>
  first<MyPassRow>(
    db,
    `${SELECT} WHERE p.owner_user_id = ? AND p.id = ? AND p.deleted_at IS NULL
    AND p.test_data_quarantined = 0`,
    [userId, passId],
  );

/** The requester's receipt stays readable after ownership is cleared. */
export const getMyRemoval = (db: Db, userId: string, transferId: string) =>
  first<{ transferId: string; state: 'pending' | 'completed' }>(
    db,
    `
    SELECT id AS transferId, state FROM pass_credential_transfers
    WHERE id = ? AND requested_by_type = 'user' AND requested_by_id = ?
      AND target_owner_user_id IS NULL`,
    [transferId, userId],
  );

/** False when there is no such email, or it is the account's last one (never none to sign in with). */
export async function removeEmail(db: Db, userId: string, email: string): Promise<boolean> {
  const { changes } = await run(
    db,
    `DELETE FROM user_emails WHERE user_id = ? AND email = ?
     AND (SELECT COUNT(*) FROM user_emails WHERE user_id = ?) > 1`,
    [userId, email, userId],
  );
  return changes > 0;
}

export const hasEmail = async (db: Db, userId: string, email: string) =>
  (await first(db, 'SELECT 1 FROM user_emails WHERE user_id = ? AND email = ?', [
    userId,
    email,
  ])) !== null;

/** Sign-in emails go to `email`, which must be one of the user's verified addresses. */
export async function setPrimaryEmail(
  db: Db,
  userId: string,
  email: string,
  amr: string,
): Promise<boolean> {
  const { changes } = await run(
    db,
    `UPDATE users SET primary_email = ?, primary_set_amr = ?
     WHERE id = ? AND EXISTS (SELECT 1 FROM user_emails WHERE user_id = ? AND email = ?)`,
    [email, amr, userId, userId, email],
  );
  return changes > 0;
}

/** The user belongs to an organization now: their primary email is what a Polaris ID sign-in links by. */
export async function hasActiveMembership(db: Db, userId: string): Promise<boolean> {
  return (
    (await first(db, 'SELECT 1 FROM org_memberships WHERE user_id = ? AND revoked_at IS NULL', [
      userId,
    ])) !== null
  );
}

/**
 * A removal waits on its own wallet transfer: pending, asked for by this holder, taking the pass off every account,
 * and made no later than the operation. Another person's later transfer on the pass is not its wait.
 */
export async function hasPendingOwnRemoval(
  db: Db,
  passId: string,
  userId: string,
  operationAt: number,
): Promise<boolean> {
  return (
    (await first(
      db,
      `SELECT 1 FROM pass_credential_transfers
       WHERE pass_id = ? AND state = 'pending' AND requested_by_type = 'user' AND requested_by_id = ?
         AND target_owner_user_id IS NULL AND requested_at <= ?`,
      [passId, userId, operationAt],
    )) !== null
  );
}

/** How a session began: its method and when. Null when it is gone. */
export const sessionBirth = (db: Db, idHash: string) =>
  first<{ amr: string; created_at: number; auth_time: number | null }>(
    db,
    'SELECT amr, created_at, auth_time FROM sessions WHERE id_hash = ? AND revoked_at IS NULL',
    [idHash],
  );
