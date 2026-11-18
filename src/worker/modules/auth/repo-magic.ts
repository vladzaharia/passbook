import { knownEmail } from '../../../shared/email.ts';
import { first, run } from '../../platform/db.ts';

type Db = D1Database;

export type MagicPurpose = 'sign_in' | 'verify_email';

export interface MagicLinkRow {
  token_hash: string;
  email: string;
  purpose: MagicPurpose;
  user_id: string | null;
  code_hash: string | null;
  redirect_path: string | null;
  attempt_count: number;
  browser_binding_hash: string | null;
  pending_identity: string | null;
  invitation_id: string | null;
}

const COLUMNS = `token_hash, email, purpose, user_id, code_hash, redirect_path, attempt_count,
  browser_binding_hash, pending_identity, invitation_id`;

/**
 * An invitation link lives while its invitation is pending in an active org, and only until the
 * address has an account: after that the person signs in normally and accepts in the app.
 * `?` binds the current time.
 */
const INVITE_LIVE = `(invitation_id IS NULL OR (
  NOT EXISTS (SELECT 1 FROM user_emails e WHERE e.email = magic_links.email)
  AND EXISTS (SELECT 1 FROM org_invitations i JOIN orgs o ON o.id = i.org_id AND o.status = 'active'
    WHERE i.id = magic_links.invitation_id AND i.revoked_at IS NULL AND i.accepted_at IS NULL
      AND i.expires_at > ?)))`;

/** An account, a pass, or a pending invitation: the only addresses that may receive a sign-in mail. */
export async function isKnownAddress(db: Db, email: string, now: number): Promise<boolean> {
  const row = await first<{ found: number }>(
    db,
    `SELECT 1 AS found WHERE EXISTS (SELECT 1 FROM user_emails WHERE email = ?)
       OR EXISTS (SELECT 1 FROM passes WHERE holder_email = ? AND deleted_at IS NULL)
       OR EXISTS (SELECT 1 FROM org_invitations i JOIN orgs o ON o.id = i.org_id AND o.status = 'active'
         WHERE i.email = ? AND i.revoked_at IS NULL AND i.accepted_at IS NULL AND i.expires_at > ?)`,
    [email, email, email, now],
  );
  return row !== null;
}

/**
 * A newer verify_email link replaces older ones. Sign-in links never invalidate each other, so a
 * stranger's request cannot kill a live link.
 */
export async function insertLink(
  db: Db,
  link: {
    tokenHash: string;
    email: string;
    purpose: MagicPurpose;
    userId: string | null;
    codeHash: string | null;
    bindingHash: string | null;
    redirectPath: string | null;
    pendingIdentity: string | null;
    invitationId?: string | null;
    now: number;
    expiresAt: number;
  },
): Promise<void> {
  if (link.purpose === 'verify_email') {
    await run(
      db,
      `UPDATE magic_links SET consumed_at = ?
       WHERE email = ? AND purpose = 'verify_email' AND user_id IS ? AND consumed_at IS NULL`,
      [link.now, link.email, link.userId],
    );
  }
  await run(
    db,
    `INSERT INTO magic_links (token_hash, email, purpose, user_id, code_hash, browser_binding_hash,
       redirect_path, pending_identity, invitation_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      link.tokenHash,
      link.email,
      link.purpose,
      link.userId,
      link.codeHash,
      link.bindingHash,
      link.redirectPath,
      link.pendingIdentity,
      link.invitationId ?? null,
      link.now,
      link.expiresAt,
    ],
  );
}

/** Read-only peek for the confirm page; consumes nothing. */
export const peekLink = (db: Db, tokenHash: string, now: number) =>
  first<MagicLinkRow>(
    db,
    `SELECT ${COLUMNS} FROM magic_links WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
       AND ${INVITE_LIVE}`,
    [tokenHash, now, now],
  );

/** The stored next of any link, live, used or expired. */
/** A link's purpose and next, live or not. */
export const linkTrace = (db: Db, tokenHash: string) =>
  first<{ redirect_path: string | null; purpose: MagicPurpose }>(
    db,
    'SELECT redirect_path, purpose FROM magic_links WHERE token_hash = ?',
    [tokenHash],
  );

export const consumeLink = (db: Db, tokenHash: string, now: number) =>
  first<MagicLinkRow>(
    db,
    `UPDATE magic_links SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
       AND ${INVITE_LIVE}
     RETURNING ${COLUMNS}`,
    [now, tokenHash, now, now],
  );

export const findLinkForCode = (db: Db, email: string, bindingHash: string, now: number) =>
  first<MagicLinkRow>(
    db,
    `SELECT ${COLUMNS} FROM magic_links
     WHERE email = ? AND browser_binding_hash = ? AND purpose = 'sign_in' AND code_hash IS NOT NULL
       AND consumed_at IS NULL AND expires_at > ?
     ORDER BY created_at DESC LIMIT 1`,
    [email, bindingHash, now],
  );

/** Counts a guess. False once the link has used all its attempts. */
export async function spendAttempt(db: Db, tokenHash: string, max: number): Promise<boolean> {
  const row = await first<{ attempt_count: number }>(
    db,
    `UPDATE magic_links SET attempt_count = attempt_count + 1
     WHERE token_hash = ? AND attempt_count < ? AND consumed_at IS NULL RETURNING attempt_count`,
    [tokenHash, max],
  );
  return row !== null;
}

export { bump as bumpCounter } from '../../platform/counters.ts';

/**
 * True when another account holds the address as verified, or as primary without an external
 * identity. A provider-created account's primary email is a claim, so it cannot squat the address.
 */
export async function isOwnedByOther(db: Db, email: string, userId: string): Promise<boolean> {
  const row = await first<{ found: number }>(
    db,
    `SELECT 1 AS found WHERE EXISTS (SELECT 1 FROM user_emails WHERE email = ? AND user_id != ?)
       OR EXISTS (SELECT 1 FROM users u WHERE u.primary_email = ? AND u.id != ?
         AND NOT EXISTS (SELECT 1 FROM auth_identities a
           WHERE a.user_id = u.id AND a.provider <> 'breakglass'))`,
    [email, userId, email, userId],
  );
  return row !== null;
}

export { read as readCounter } from '../../platform/counters.ts';

/** The account's address for display or mail, or null when it has proven none. */
export const primaryEmailOf = async (db: Db, userId: string): Promise<string | null> =>
  knownEmail(
    (
      await first<{ primary_email: string }>(db, 'SELECT primary_email FROM users WHERE id = ?', [
        userId,
      ])
    )?.primary_email,
  );
