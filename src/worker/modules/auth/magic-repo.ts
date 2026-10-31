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
}

export async function isKnownAddress(db: Db, email: string): Promise<boolean> {
  const row = await first<{ found: number }>(
    db,
    `SELECT 1 AS found WHERE EXISTS (SELECT 1 FROM user_emails WHERE email = ?)
       OR EXISTS (SELECT 1 FROM passes WHERE holder_email = ?)`,
    [email, email],
  );
  return row !== null;
}

/** Only the newest link for an address stays usable. */
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
    now: number;
    expiresAt: number;
  },
): Promise<void> {
  await run(
    db,
    `UPDATE magic_links SET consumed_at = ? WHERE email = ? AND purpose = ? AND consumed_at IS NULL`,
    [link.now, link.email, link.purpose],
  );
  await run(
    db,
    `INSERT INTO magic_links (token_hash, email, purpose, user_id, code_hash, browser_binding_hash,
       redirect_path, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      link.tokenHash,
      link.email,
      link.purpose,
      link.userId,
      link.codeHash,
      link.bindingHash,
      link.redirectPath,
      link.now,
      link.expiresAt,
    ],
  );
}

/** Read-only peek for the confirm page; consumes nothing. */
export const peekLink = (db: Db, tokenHash: string, now: number) =>
  first<MagicLinkRow>(
    db,
    `SELECT token_hash, email, purpose, user_id, code_hash, redirect_path, attempt_count
     FROM magic_links WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
    [tokenHash, now],
  );

export const consumeLink = (db: Db, tokenHash: string, now: number) =>
  first<MagicLinkRow>(
    db,
    `UPDATE magic_links SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
     RETURNING token_hash, email, purpose, user_id, code_hash, redirect_path, attempt_count`,
    [now, tokenHash, now],
  );

export const findLinkForCode = (db: Db, email: string, bindingHash: string, now: number) =>
  first<MagicLinkRow>(
    db,
    `SELECT token_hash, email, purpose, user_id, code_hash, redirect_path, attempt_count
     FROM magic_links
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

/** Fixed-window counter in D1. Returns the count after this hit. */
export async function bumpCounter(db: Db, key: string, windowStart: number): Promise<number> {
  const row = await first<{ count: number }>(
    db,
    `INSERT INTO counters (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1 RETURNING count`,
    [key, windowStart],
  );
  return row?.count ?? 1;
}
