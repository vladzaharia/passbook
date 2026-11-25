import type { Amr, Role } from '../../platform/auth.ts';
import { all, first, run } from '../../platform/db.ts';

type Db = D1Database;

export interface SessionRow {
  id_hash: string;
  user_id: string;
  amr: Amr;
  auth_time: number | null;
  roles: string;
  csrf_secret: string;
  created_at: number;
  last_seen_at: number;
  idle_expires_at: number;
  expires_at: number;
  revoked_at: number | null;
  ip_prefix: string | null;
  user_agent: string | null;
  user_status: 'active' | 'disabled';
  /** `auth.consoleEmailUntil` for an email session of a user in `console_email_grace`; null otherwise. */
  console_until: number | null;
}

export const getSession = (db: Db, idHash: string) =>
  first<SessionRow>(
    db,
    `SELECT s.*, u.status AS user_status,
       CASE WHEN s.amr = 'magic_link' AND EXISTS (SELECT 1 FROM console_email_grace g WHERE g.user_id = s.user_id)
         THEN (SELECT CAST(json_extract(st.value, '$') AS INTEGER) FROM settings st
           WHERE st.scope = 'platform' AND st.key = 'auth.consoleEmailUntil') END AS console_until
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id_hash = ?`,
    [idHash],
  );

export async function insertSession(
  db: Db,
  s: {
    idHash: string;
    userId: string;
    amr: Amr;
    authTime?: number | null;
    roles: string[];
    csrfSecret: string;
    now: number;
    idleExpiresAt: number;
    expiresAt: number;
    ipPrefix: string | null;
    userAgent: string | null;
  },
): Promise<void> {
  await run(
    db,
    `INSERT INTO sessions (id_hash, user_id, amr, auth_time, roles, csrf_secret, created_at, last_seen_at,
       idle_expires_at, expires_at, ip_prefix, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      s.idHash,
      s.userId,
      s.amr,
      s.authTime ?? null,
      JSON.stringify(s.roles),
      s.csrfSecret,
      s.now,
      s.now,
      s.idleExpiresAt,
      s.expiresAt,
      s.ipPrefix,
      s.userAgent,
    ],
  );
}

/** Slides the idle window; never past the absolute expiry. */
export async function touchSession(
  db: Db,
  idHash: string,
  now: number,
  idleMs: number,
): Promise<void> {
  await run(
    db,
    `UPDATE sessions SET last_seen_at = ?, idle_expires_at = MIN(expires_at, ?)
     WHERE id_hash = ? AND revoked_at IS NULL`,
    [now, now + idleMs, idHash],
  );
}

export async function revokeSession(db: Db, idHash: string, now: number): Promise<boolean> {
  const { changes } = await run(
    db,
    'UPDATE sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL',
    [now, idHash],
  );
  return changes > 0;
}

/** Revokes a user's live sessions, optionally keeping one. Returns the count. */
export async function revokeUserSessions(
  db: Db,
  userId: string,
  now: number,
  exceptIdHash?: string,
): Promise<number> {
  const { changes } = await run(
    db,
    `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id_hash IS NOT ?`,
    [now, userId, exceptIdHash ?? null],
  );
  return changes;
}

/**
 * Revokes a user's live Polaris ID sessions whose roles include `role` (email-link and break-glass sessions stay).
 * Every Polaris ID session holds `user`, so that revokes them all. Returns the count.
 */
export async function revokeSessionsWithRole(
  db: Db,
  userId: string,
  role: Role,
  now: number,
): Promise<number> {
  const { changes } = await run(
    db,
    `UPDATE sessions SET revoked_at = ?
     WHERE user_id = ? AND amr = 'oidc' AND revoked_at IS NULL
       AND EXISTS (SELECT 1 FROM json_each(sessions.roles) WHERE value = ?)`,
    [now, userId, role],
  );
  return changes;
}

export const listLiveSessions = (db: Db, userId: string, now: number) =>
  all<SessionRow>(
    db,
    `SELECT s.*, 'active' AS user_status FROM sessions s
     WHERE s.user_id = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND s.idle_expires_at > ?
     ORDER BY s.last_seen_at DESC LIMIT 100`,
    [userId, now, now],
  );

export const listRecentSessions = (db: Db, userId: string, limit = 20) =>
  all<SessionRow>(
    db,
    `SELECT s.*, 'active' AS user_status FROM sessions s WHERE s.user_id = ?
     ORDER BY s.created_at DESC LIMIT ?`,
    [userId, limit],
  );
