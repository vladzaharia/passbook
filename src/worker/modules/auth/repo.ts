import { deleteInBatches } from '../../platform/batched.ts';
import { pruneCounters } from '../../platform/counters.ts';
import { all, first, run } from '../../platform/db.ts';

type Db = D1Database;

export interface UserRow {
  id: string;
  name: string | null;
  primary_email: string;
  status: 'active' | 'disabled';
  created_at: number;
  last_login_at: number | null;
  last_roles: string;
}

export interface IdentityRow {
  provider: string;
  subject: string;
  user_id: string;
}

export const getUser = (db: Db, id: string) =>
  first<UserRow>(db, 'SELECT * FROM users WHERE id = ?', [id]);

export const findUserByEmail = (db: Db, email: string) =>
  first<UserRow>(
    db,
    'SELECT u.* FROM user_emails e JOIN users u ON u.id = e.user_id WHERE e.email = ?',
    [email],
  );

export const findUserByPrimaryEmail = (db: Db, email: string) =>
  first<UserRow>(db, 'SELECT * FROM users WHERE primary_email = ?', [email]);

/**
 * Stands in for a primary email nobody has proven (an account an identity provider created). It
 * sits on the reserved .invalid TLD, so it never receives mail and is never a real address.
 */
const UNVERIFIED_SUFFIX = '@unverified.invalid';
export const unverifiedPrimaryEmail = (userId: string) => `${userId}${UNVERIFIED_SUFFIX}`;
export const isUnverifiedPrimary = (email: string) => email.endsWith(UNVERIFIED_SUFFIX);

/** The account signs in through an identity provider (anything but the break-glass token). */
const hasExternalIdentity = async (db: Db, userId: string) =>
  (await first(db, "SELECT 1 FROM auth_identities WHERE user_id = ? AND provider <> 'breakglass'", [
    userId,
  ])) !== null;

/**
 * The account that owns `email`: a verified address, or a primary email on an account with no
 * external identity. A primary email on an account that has one is a claim, not ownership (it may
 * come from an identity provider that never proved it), so it never matches here.
 */
export async function findUserByProvenEmail(db: Db, email: string): Promise<UserRow | null> {
  const verified = await findUserByEmail(db, email);
  if (verified) return verified;
  const byPrimary = await findUserByPrimaryEmail(db, email);
  return byPrimary && !(await hasExternalIdentity(db, byPrimary.id)) ? byPrimary : null;
}

/** Frees the address from an account that held it unproven. Returns the account, if any. */
export async function releaseUnprovenPrimary(db: Db, email: string): Promise<UserRow | null> {
  const holder = await findUserByPrimaryEmail(db, email);
  if (!holder) return null;
  await run(db, 'UPDATE users SET primary_email = ? WHERE id = ? AND primary_email = ?', [
    unverifiedPrimaryEmail(holder.id),
    holder.id,
    email,
  ]);
  return holder;
}

/** An account with a placeholder primary email takes the first address it proves. */
export async function adoptPrimaryEmail(db: Db, userId: string, email: string): Promise<void> {
  await run(
    db,
    `UPDATE users SET primary_email = ? WHERE id = ? AND primary_email = ?
       AND NOT EXISTS (SELECT 1 FROM users WHERE primary_email = ?)`,
    [email, userId, unverifiedPrimaryEmail(userId), email],
  );
}

/** No-op when the primary email is already taken; callers re-select. */
export async function insertUser(
  db: Db,
  user: { id: string; name: string | null; email: string; now: number },
): Promise<void> {
  await run(
    db,
    'INSERT OR IGNORE INTO users (id, name, primary_email, created_at) VALUES (?, ?, ?, ?)',
    [user.id, user.name, user.email, user.now],
  );
}

export type EmailVia = 'magic_link' | 'oidc' | 'admin';

/** Adds the email unless any user already has it. Returns the owning user id. */
export async function addUserEmail(
  db: Db,
  email: string,
  userId: string,
  via: EmailVia,
  now: number,
): Promise<{ ownerId: string; added: boolean }> {
  const { changes } = await run(
    db,
    'INSERT OR IGNORE INTO user_emails (email, user_id, verified_via, verified_at) VALUES (?, ?, ?, ?)',
    [email, userId, via, now],
  );
  const owner = await first<{ user_id: string }>(
    db,
    'SELECT user_id FROM user_emails WHERE email = ?',
    [email],
  );
  return { ownerId: owner?.user_id ?? userId, added: changes > 0 };
}

export const findIdentity = (db: Db, provider: string, subject: string) =>
  first<IdentityRow>(
    db,
    'SELECT provider, subject, user_id FROM auth_identities WHERE provider = ? AND subject = ?',
    [provider, subject],
  );

export async function insertIdentity(
  db: Db,
  row: {
    provider: string;
    subject: string;
    userId: string;
    emailClaim: string | null;
    emailVerified: boolean;
    groups: string[];
    now: number;
  },
): Promise<void> {
  await run(
    db,
    `INSERT OR IGNORE INTO auth_identities
       (provider, subject, user_id, email_claim, email_verified, groups, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.provider,
      row.subject,
      row.userId,
      row.emailClaim,
      row.emailVerified,
      JSON.stringify(row.groups),
      row.now,
      row.now,
    ],
  );
}

export async function updateIdentity(
  db: Db,
  row: {
    provider: string;
    subject: string;
    emailClaim: string | null;
    emailVerified: boolean;
    groups: string[];
    now: number;
  },
): Promise<void> {
  await run(
    db,
    `UPDATE auth_identities SET email_claim = ?, email_verified = ?, groups = ?, last_used_at = ?
     WHERE provider = ? AND subject = ?`,
    [
      row.emailClaim,
      row.emailVerified,
      JSON.stringify(row.groups),
      row.now,
      row.provider,
      row.subject,
    ],
  );
}

export async function recordLogin(
  db: Db,
  userId: string,
  roles: string[],
  name: string | null,
  now: number,
): Promise<void> {
  await run(
    db,
    'UPDATE users SET last_login_at = ?, last_roles = ?, name = COALESCE(name, ?) WHERE id = ?',
    [now, JSON.stringify(roles), name, userId],
  );
}

export const emailsOf = (db: Db, userId: string) =>
  all<{ email: string; verified_via: EmailVia; verified_at: number }>(
    db,
    'SELECT email, verified_via, verified_at FROM user_emails WHERE user_id = ? ORDER BY verified_at, email',
    [userId],
  );

const DAY = 24 * 60 * 60 * 1000;

/** Daily retention. Returns rows removed per table. */
export async function purgeExpired(db: Db, now: number): Promise<Record<string, number>> {
  const del = (table: string, where: string, ...params: number[]) =>
    deleteInBatches(db, table, where, params);
  return {
    magicLinks: await del('magic_links', 'expires_at < ?', now - DAY),
    oidcFlows: await del('oidc_flows', 'expires_at < ?', now),
    sessions: await del(
      'sessions',
      'expires_at < ? OR idle_expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)',
      now - DAY,
      now - DAY,
      now - 7 * DAY,
    ),
    counters: await pruneCounters(db, now - 2 * DAY),
  };
}

// OIDC flow state

export interface FlowRow {
  nonce: string;
  code_verifier: string;
  redirect_path: string | null;
}

export async function insertFlow(
  db: Db,
  flow: {
    stateHash: string;
    nonce: string;
    verifier: string;
    redirectPath: string | null;
    bindingHash: string;
    expiresAt: number;
  },
): Promise<void> {
  await run(
    db,
    `INSERT INTO oidc_flows (state_hash, nonce, code_verifier, redirect_path, browser_binding_hash, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      flow.stateHash,
      flow.nonce,
      flow.verifier,
      flow.redirectPath,
      flow.bindingHash,
      flow.expiresAt,
    ],
  );
}

/** Single use: the row is gone once returned. A wrong browser binding consumes nothing. */
export const consumeFlow = (db: Db, stateHash: string, bindingHash: string, now: number) =>
  first<FlowRow>(
    db,
    `DELETE FROM oidc_flows WHERE state_hash = ? AND browser_binding_hash = ? AND expires_at > ?
     RETURNING nonce, code_verifier, redirect_path`,
    [stateHash, bindingHash, now],
  );
