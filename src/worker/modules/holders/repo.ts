import { all, first, placeholders, run } from '../../platform/db.ts';

export interface HolderPass {
  id: string;
  orgId: string;
  holderEmail: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  modifiedAt: number;
}

interface HolderDbRow {
  id: string;
  org_id: string;
  holder_email: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  modified_at: number;
}

const mapHolder = (r: HolderDbRow): HolderPass => ({
  id: r.id,
  orgId: r.org_id,
  holderEmail: r.holder_email,
  ownerUserId: r.owner_user_id,
  ownerName: r.owner_name,
  modifiedAt: r.modified_at,
});

const SELECT_HOLDER = `SELECT p.id, p.org_id, p.holder_email, p.owner_user_id, p.modified_at, u.name AS owner_name
  FROM passes p LEFT JOIN users u ON u.id = p.owner_user_id`;

export async function getHolderPass(
  db: D1Database,
  passId: string,
  orgScope: string | null,
): Promise<HolderPass | null> {
  const row = await first<HolderDbRow>(
    db,
    `${SELECT_HOLDER} WHERE p.id = ? AND (? IS NULL OR p.org_id = ?)`,
    [passId, orgScope, orgScope],
  );
  return row ? mapHolder(row) : null;
}

export interface HolderFilter {
  orgId?: string | null;
  email?: string;
  state?: 'unassigned' | 'waiting' | 'owned';
  cursor?: string;
  limit: number;
}

export async function listHolderPasses(
  db: D1Database,
  filter: HolderFilter,
): Promise<{ items: HolderPass[]; nextCursor: string | null }> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.orgId) {
    where.push('p.org_id = ?');
    params.push(filter.orgId);
  }
  if (filter.email) {
    where.push('p.holder_email = ?');
    params.push(filter.email);
  }
  if (filter.state === 'unassigned')
    where.push('p.holder_email IS NULL AND p.owner_user_id IS NULL');
  if (filter.state === 'waiting')
    where.push('p.holder_email IS NOT NULL AND p.owner_user_id IS NULL');
  if (filter.state === 'owned') where.push('p.owner_user_id IS NOT NULL');
  if (filter.cursor) {
    where.push('p.id < ?');
    params.push(filter.cursor);
  }
  const rows = await all<HolderDbRow>(
    db,
    `${SELECT_HOLDER} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.id DESC LIMIT ?`,
    [...params, filter.limit + 1],
  );
  const page = rows.slice(0, filter.limit).map(mapHolder);
  const last = page.at(-1);
  return { items: page, nextCursor: rows.length > filter.limit && last ? last.id : null };
}

export async function blockedUsers(
  db: D1Database,
  passIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (passIds.length === 0) return out;
  const rows = await all<{ pass_id: string; user_id: string }>(
    db,
    `SELECT pass_id, user_id FROM pass_attach_blocks WHERE pass_id IN (${placeholders(passIds.length)})`,
    passIds,
  );
  for (const r of rows) out.set(r.pass_id, [...(out.get(r.pass_id) ?? []), r.user_id]);
  return out;
}

/** Active users that verified `email`: a user_emails row, or an identity with email_verified. */
export async function verifiedCandidates(db: D1Database, email: string): Promise<string[]> {
  const rows = await all<{ id: string }>(
    db,
    `SELECT u.id FROM users u WHERE u.status = 'active' AND (
       EXISTS (SELECT 1 FROM user_emails e WHERE e.user_id = u.id AND e.email = ?1)
       OR EXISTS (SELECT 1 FROM auth_identities a WHERE a.user_id = u.id AND a.email_verified = 1
                  AND lower(a.email_claim) = ?1))`,
    [email],
  );
  return rows.map((r) => r.id);
}

export async function userVerifiedEmail(
  db: D1Database,
  userId: string,
  email: string,
): Promise<boolean> {
  const row = await first<{ ok: number }>(
    db,
    `SELECT 1 AS ok FROM users u WHERE u.id = ?1 AND u.status = 'active' AND (
       EXISTS (SELECT 1 FROM user_emails e WHERE e.user_id = u.id AND e.email = ?2)
       OR EXISTS (SELECT 1 FROM auth_identities a WHERE a.user_id = u.id AND a.email_verified = 1
                  AND lower(a.email_claim) = ?2))`,
    [userId, email],
  );
  return row !== null;
}

export async function blockedUserIds(db: D1Database, passId: string): Promise<string[]> {
  const rows = await all<{ user_id: string }>(
    db,
    'SELECT user_id FROM pass_attach_blocks WHERE pass_id = ?',
    [passId],
  );
  return rows.map((r) => r.user_id);
}

/**
 * Always executed, even without a candidate (`userId` null matches nothing), so hook A runs the
 * same statements whether or not an account exists.
 */
export async function attachOwner(
  db: D1Database,
  passId: string,
  userId: string | null,
  email: string | null,
): Promise<boolean> {
  const row = await first<{ id: string }>(
    db,
    `UPDATE passes SET owner_user_id = ?1 WHERE id = ?2 AND owner_user_id IS NULL
       AND holder_email IS ?3 AND ?1 IS NOT NULL RETURNING id`,
    [userId, passId, email],
  );
  return row !== null;
}

/** Hook B: one statement attaches every waiting, unblocked pass with this email. */
export async function attachWaiting(
  db: D1Database,
  userId: string,
  email: string,
): Promise<{ id: string; orgId: string }[]> {
  const rows = await all<{ id: string; org_id: string }>(
    db,
    `UPDATE passes SET owner_user_id = ?1
     WHERE holder_email = ?2 AND owner_user_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM pass_attach_blocks b WHERE b.pass_id = passes.id AND b.user_id = ?1)
     RETURNING id, org_id`,
    [userId, email],
  );
  return rows.map((r) => ({ id: r.id, orgId: r.org_id }));
}

/** Changes the email of an unowned pass. */
export async function setEmailIfUnowned(
  db: D1Database,
  passId: string,
  email: string | null,
): Promise<boolean> {
  const row = await first<{ id: string }>(
    db,
    'UPDATE passes SET holder_email = ? WHERE id = ? AND owner_user_id IS NULL RETURNING id',
    [email, passId],
  );
  return row !== null;
}

/** Explicit admin move: clears the owner and sets the email in one statement. */
export async function reassign(
  db: D1Database,
  passId: string,
  email: string | null,
): Promise<boolean> {
  return (
    (
      await run(db, 'UPDATE passes SET holder_email = ?, owner_user_id = NULL WHERE id = ?', [
        email,
        passId,
      ])
    ).changes > 0
  );
}

export async function addBlockAndClearOwner(
  db: D1Database,
  passId: string,
  userId: string,
  now: number,
): Promise<boolean> {
  // The block goes in first so a concurrent attach cannot re-attach in between.
  await run(
    db,
    'INSERT OR IGNORE INTO pass_attach_blocks (pass_id, user_id, created_at) VALUES (?, ?, ?)',
    [passId, userId, now],
  );
  const row = await first<{ id: string }>(
    db,
    'UPDATE passes SET owner_user_id = NULL WHERE id = ? AND owner_user_id = ? RETURNING id',
    [passId, userId],
  );
  return row !== null;
}

export async function isOwner(db: D1Database, passId: string, userId: string): Promise<boolean> {
  const row = await first<{ id: string }>(
    db,
    'SELECT id FROM passes WHERE id = ? AND owner_user_id = ?',
    [passId, userId],
  );
  return row !== null;
}

export async function removeBlock(
  db: D1Database,
  passId: string,
  userId: string,
): Promise<boolean> {
  return (
    (
      await run(db, 'DELETE FROM pass_attach_blocks WHERE pass_id = ? AND user_id = ?', [
        passId,
        userId,
      ])
    ).changes > 0
  );
}
