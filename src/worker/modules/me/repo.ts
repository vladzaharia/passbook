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
  /** 1 when a device registered the pass. */
  registered: number;
}

// pass_versions keeps the built pass.json for recent versions; it is what the card renders.
const SELECT = `
  SELECT p.id, p.org_id, p.identity_id, p.template_id, p.template_version, p.display_title, p.display_subtitle, p.status, p.mode, p.modified_at, p.removed_at, p.removal_message, p.last_refreshed_at,
         p.version, p.revision, p.row_version, p.release_id, p.link_generation, p.credential_generation, p.lifecycle_generation,
         p.holder_email, p.connection_id, p.external_ref, p.test_data_quarantined, p.deleted_at,
         p.refresh_requested_at, p.download_token, t.name AS template_name, o.name AS org_name, o.status AS org_status,
         COALESCE(pv.pass_json, p.pending_pass_json) AS pass_json,
         EXISTS (SELECT 1 FROM registrations r WHERE r.pass_id = p.id) AS registered
  FROM passes p
  JOIN templates t ON t.id = p.template_id
  JOIN orgs o ON o.id = p.org_id
  LEFT JOIN pass_versions pv ON pv.pass_id = p.id AND pv.version = p.version`;

const NO_PENDING_TRANSFER = `NOT EXISTS (SELECT 1 FROM pass_credential_transfers transfer
  WHERE transfer.pass_id = p.id AND transfer.state = 'pending')`;

export const listMyPasses = (db: Db, userId: string, cursor: string | undefined, limit: number) =>
  all<MyPassRow>(
    db,
    `${SELECT} WHERE p.owner_user_id = ? AND p.test_data_quarantined = 0 AND ${NO_PENDING_TRANSFER}
      ${cursor ? 'AND p.id < ?' : ''} ORDER BY p.id DESC LIMIT ?`,
    cursor ? [userId, cursor, limit + 1] : [userId, limit + 1],
  );

export const getMyPass = (db: Db, userId: string, passId: string) =>
  first<MyPassRow>(
    db,
    `${SELECT} WHERE p.owner_user_id = ? AND p.id = ?
    AND p.test_data_quarantined = 0 AND ${NO_PENDING_TRANSFER}`,
    [userId, passId],
  );

/** Fence the whole page and its status notices in one final D1 snapshot. */
export async function portfolioSnapshot(db: Db, userId: string, ids: readonly string[]) {
  const results = await batch(db, [
    stmt(
      db,
      `${SELECT} JOIN json_each(?) expected ON expected.value = p.id
      WHERE p.owner_user_id = ? AND p.test_data_quarantined = 0 AND ${NO_PENDING_TRANSFER}`,
      [JSON.stringify(ids), userId],
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
      WHERE ${holderReissueCurrentSql('p', '?')} ORDER BY p.id DESC`,
      [userId],
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
    `${SELECT} WHERE p.owner_user_id = ? AND p.id = ?
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
const NOT_IN_WALLET = 'NOT EXISTS (SELECT 1 FROM registrations r WHERE r.pass_id = p.id)';

export interface BundleRow {
  id: string;
  object_key: string;
  object_size: number | null;
  version: number;
  revision: number;
  credential_generation: number;
  lifecycle_generation: number;
  link_generation: number;
}

const BUNDLE_WHERE = `p.owner_user_id = ? AND p.status = 'active' AND p.deleted_at IS NULL
  AND p.removed_at IS NULL AND p.test_data_quarantined = 0 AND ${NO_PENDING_TRANSFER}
  AND ${NOT_IN_WALLET}`;
const ACTIVE_ORG = "JOIN orgs AS o ON o.id = p.org_id AND o.status = 'active'";

/** Every pass Add all would bundle, newest first: the snapshot's ordered ids. */
export const listBundleIds = async (db: Db, userId: string) =>
  (
    await all<{ id: string }>(
      db,
      `SELECT p.id FROM passes AS p ${ACTIVE_ORG} WHERE ${BUNDLE_WHERE} ORDER BY p.id DESC`,
      [userId],
    )
  ).map((row) => row.id);

/** One part, by id range from the snapshot: a pass leaving the set never shifts its neighbours. */
export const listBundlePasses = (
  db: Db,
  userId: string,
  range: { first: string; after: string | null },
  limit: number,
) =>
  all<BundleRow>(
    db,
    `SELECT p.id, p.object_key, p.object_size, p.version, p.revision,
       p.credential_generation, p.lifecycle_generation, p.link_generation
     FROM passes AS p ${ACTIVE_ORG}
     WHERE ${BUNDLE_WHERE} AND p.id <= ? AND (? IS NULL OR p.id > ?)
     ORDER BY p.id DESC LIMIT ?`,
    [userId, range.first, range.after, range.after, limit],
  );

/** Recheck each archive entry after its object read and before any bytes are emitted. */
export const bundlePassIsCurrent = async (db: Db, userId: string, row: BundleRow) =>
  (await first(
    db,
    `SELECT 1 FROM passes AS p ${ACTIVE_ORG} WHERE p.id = ? AND p.owner_user_id = ?
    AND p.object_key = ? AND p.object_size IS ? AND p.version = ? AND p.revision = ?
    AND p.credential_generation = ? AND p.lifecycle_generation = ? AND p.link_generation = ?
    AND p.status = 'active' AND p.deleted_at IS NULL AND p.removed_at IS NULL
    AND p.test_data_quarantined = 0 AND ${NO_PENDING_TRANSFER}
    AND ${NOT_IN_WALLET}`,
    [
      row.id,
      userId,
      row.object_key,
      row.object_size,
      row.version,
      row.revision,
      row.credential_generation,
      row.lifecycle_generation,
      row.link_generation,
    ],
  )) !== null;
