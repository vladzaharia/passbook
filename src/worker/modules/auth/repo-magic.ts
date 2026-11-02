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
}

const COLUMNS = `token_hash, email, purpose, user_id, code_hash, redirect_path, attempt_count,
  browser_binding_hash, pending_identity`;

export async function isKnownAddress(db: Db, email: string): Promise<boolean> {
  const row = await first<{ found: number }>(
    db,
    `SELECT 1 AS found WHERE EXISTS (SELECT 1 FROM user_emails WHERE email = ?)
       OR EXISTS (SELECT 1 FROM passes WHERE holder_email = ? AND deleted_at IS NULL)`,
    [email, email],
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
       redirect_path, pending_identity, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      link.tokenHash,
      link.email,
      link.purpose,
      link.userId,
      link.codeHash,
      link.bindingHash,
      link.redirectPath,
      link.pendingIdentity,
      link.now,
      link.expiresAt,
    ],
  );
}

/** Read-only peek for the confirm page; consumes nothing. */
export const peekLink = (db: Db, tokenHash: string, now: number) =>
  first<MagicLinkRow>(
    db,
    `SELECT ${COLUMNS} FROM magic_links WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
    [tokenHash, now],
  );

export const consumeLink = (db: Db, tokenHash: string, now: number) =>
  first<MagicLinkRow>(
    db,
    `UPDATE magic_links SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
     RETURNING ${COLUMNS}`,
    [now, tokenHash, now],
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

/** True when another account holds the address as primary or verified. */
export async function isOwnedByOther(db: Db, email: string, userId: string): Promise<boolean> {
  const row = await first<{ found: number }>(
    db,
    `SELECT 1 AS found WHERE EXISTS (SELECT 1 FROM user_emails WHERE email = ? AND user_id != ?)
       OR EXISTS (SELECT 1 FROM users WHERE primary_email = ? AND id != ?)`,
    [email, userId, email, userId],
  );
  return row !== null;
}

export { read as readCounter } from '../../platform/counters.ts';

export const primaryEmailOf = async (db: Db, userId: string): Promise<string | null> =>
  (
    await first<{ primary_email: string }>(db, 'SELECT primary_email FROM users WHERE id = ?', [
      userId,
    ])
  )?.primary_email ?? null;
