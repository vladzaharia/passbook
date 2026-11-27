import { all, first, run, type SqlValue } from '../../platform/db.ts';

/** A CLI sign-in session (`cli_sessions`, 0245). The device and user codes are stored as digests only. */
export interface CliSessionRow {
  id: string;
  device_hash: string;
  code_mac: string;
  state: 'pending' | 'approved' | 'denied';
  client: string;
  account_hint: string | null;
  created_at: number;
  expires_at: number;
  ip_prefix: string | null;
  country: string | null;
  city: string | null;
  interval_s: number;
  last_poll_at: number | null;
  user_id: string | null;
  org_id: string | null;
  approved_at: number | null;
  mismatch_at: number | null;
  token_id: string | null;
  consumed_at: number | null;
  token_revoked_at: number | null;
}

export interface NewCliSession {
  id: string;
  deviceHash: string;
  codeMac: string;
  client: string;
  accountHint: string | null;
  now: number;
  expiresAt: number;
  ipPrefix: string | null;
  country: string | null;
  city: string | null;
}

/** False when the code collides with a pending one (the unique index): the caller draws another. */
export async function insertCliSession(db: D1Database, s: NewCliSession): Promise<boolean> {
  const { changes } = await run(
    db,
    `INSERT INTO cli_sessions (id, device_hash, code_mac, client, account_hint, created_at, expires_at, ip_prefix, country, city)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [
      s.id,
      s.deviceHash,
      s.codeMac,
      s.client,
      s.accountHint,
      s.now,
      s.expiresAt,
      s.ipPrefix,
      s.country,
      s.city,
    ],
  );
  return changes > 0;
}

export async function countPending(db: D1Database, now: number): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    "SELECT count(*) AS n FROM cli_sessions WHERE state = 'pending' AND expires_at > ?",
    [now],
  );
  return row?.n ?? 0;
}

/** Drops sessions that ended unused more than an hour ago, a few at a time: never a session that made a key. */
export const purgeCliSessions = (db: D1Database, now: number) =>
  run(
    db,
    `DELETE FROM cli_sessions WHERE id IN (
       SELECT id FROM cli_sessions WHERE token_id IS NULL AND expires_at < ? LIMIT 50)`,
    [now - 3_600_000],
  );

export const pendingByCode = (db: D1Database, codeMac: string, now: number) =>
  first<CliSessionRow>(
    db,
    "SELECT * FROM cli_sessions WHERE code_mac = ? AND state = 'pending' AND expires_at > ?",
    [codeMac, now],
  );

export const pendingById = (db: D1Database, id: string, now: number) =>
  first<CliSessionRow>(
    db,
    "SELECT * FROM cli_sessions WHERE id = ? AND state = 'pending' AND expires_at > ?",
    [id, now],
  );

export const byDeviceHash = (db: D1Database, deviceHash: string) =>
  first<CliSessionRow>(db, 'SELECT * FROM cli_sessions WHERE device_hash = ?', [deviceHash]);

/** Pending to approved or denied in one statement: a second caller finds nothing. */
export async function settleCliSession(
  db: D1Database,
  id: string,
  now: number,
  to:
    | { state: 'denied' }
    | { state: 'approved'; userId: string; orgId: string; country: string | null },
): Promise<boolean> {
  const approved = to.state === 'approved';
  const { changes } = await run(
    db,
    `UPDATE cli_sessions SET state = ?, user_id = ?, org_id = ?, approved_at = ?, approve_country = ?
     WHERE id = ? AND state = 'pending' AND expires_at > ?`,
    [
      to.state,
      approved ? to.userId : null,
      approved ? to.orgId : null,
      approved ? now : null,
      approved ? to.country : null,
      id,
      now,
    ],
  );
  return changes > 0;
}

/** Undoes an approval whose key could not be made. */
export const reopenCliSession = (db: D1Database, id: string) =>
  run(
    db,
    `UPDATE cli_sessions SET state = 'pending', user_id = NULL, org_id = NULL, approved_at = NULL, approve_country = NULL
     WHERE id = ? AND state = 'approved' AND token_id IS NULL`,
    [id],
  );

export const attachCliToken = (db: D1Database, id: string, keyId: string) =>
  run(db, 'UPDATE cli_sessions SET token_id = ? WHERE id = ? AND state = ? AND token_id IS NULL', [
    keyId,
    id,
    'approved',
  ]);

/** Notes a poll: the time, and a longer interval when it came too soon. */
export const notePoll = (db: D1Database, id: string, now: number, tooFast: boolean) =>
  run(db, 'UPDATE cli_sessions SET last_poll_at = ?, interval_s = interval_s + ? WHERE id = ?', [
    now,
    tooFast ? 5 : 0,
    id,
  ]);

/** The one poll that sets `consumed_at` gets the token: an approved, unconsumed, unended session with its key. */
export const consumeCliSession = (db: D1Database, id: string, now: number) =>
  first<{ token_id: string; org_id: string; user_id: string }>(
    db,
    `UPDATE cli_sessions SET consumed_at = ?
     WHERE id = ? AND state = 'approved' AND consumed_at IS NULL AND token_id IS NOT NULL AND token_revoked_at IS NULL
       AND expires_at + 60000 > ?
     RETURNING token_id, org_id, user_id`,
    [now, id, now],
  );

export const userOf = (db: D1Database, id: string) =>
  first<{ id: string; name: string | null; primary_email: string }>(
    db,
    'SELECT id, name, primary_email FROM users WHERE id = ?',
    [id],
  );

export const orgOf = (db: D1Database, id: string) =>
  first<{ name: string; kind: string | null }>(db, 'SELECT name, kind FROM orgs WHERE id = ?', [
    id,
  ]);

export const keySecretParts = (db: D1Database, id: string) =>
  first<{ prefix: string; key_hash: string; expires_at: number | null }>(
    db,
    'SELECT prefix, key_hash, expires_at FROM api_keys WHERE id = ?',
    [id],
  );

/** A member's live CLI tokens, newest first: five at most. */
export const liveCliTokens = (db: D1Database, membershipId: string, now: number) =>
  all<{ id: string }>(
    db,
    `SELECT k.id FROM api_keys k JOIN cli_sessions c ON c.token_id = k.id
     WHERE k.membership_id = ? AND k.origin = 'cli' AND k.revoked_at IS NULL AND c.token_revoked_at IS NULL
       AND (k.expires_at IS NULL OR k.expires_at > ?) ORDER BY k.created_at DESC, k.rowid DESC`,
    [membershipId, now],
  );

/** Ends CLI tokens by who or where: a person, an org, a person's sandbox (`orgIds`), or every one. Returns how many. */
export async function endCliTokensWhere(
  db: D1Database,
  where: { userId?: string; orgId?: string },
  reason: string,
  now: number,
): Promise<number> {
  const sql = ['token_id IS NOT NULL', 'token_revoked_at IS NULL'];
  const params: SqlValue[] = [now, reason];
  if (where.userId !== undefined) {
    sql.push('user_id = ?');
    params.push(where.userId);
  }
  if (where.orgId !== undefined) {
    sql.push('org_id = ?');
    params.push(where.orgId);
  }
  // Counted from the rows returned: `changes` would count the key each one's trigger ends too.
  const ended = await all<{ token_id: string }>(
    db,
    `UPDATE cli_sessions SET token_revoked_at = ?, token_revoke_reason = ? WHERE ${sql.join(' AND ')}
     RETURNING token_id`,
    params,
  );
  return ended.length;
}

/** The token `id` was approved by this person. */
export async function ownsCliToken(db: D1Database, id: string, userId: string): Promise<boolean> {
  const row = await first<{ ok: number }>(
    db,
    'SELECT 1 AS ok FROM cli_sessions WHERE token_id = ? AND user_id = ?',
    [id, userId],
  );
  return row !== null;
}

/** Notes that another account tried to approve: the polling device is told. */
export const markMismatch = (db: D1Database, id: string, now: number) =>
  run(db, 'UPDATE cli_sessions SET mismatch_at = ? WHERE id = ? AND mismatch_at IS NULL', [
    now,
    id,
  ]);
