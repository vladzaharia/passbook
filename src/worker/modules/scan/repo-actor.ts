import { first } from '../../platform/db.ts';

/** Read the original live session used to capture scanner tenant authority. */
export function scanTenantSession(
  db: D1Database,
  sessionId: string,
  userId: string,
  expiresNow: number,
  idleNow: number,
): Promise<{ csrf_secret: string; created_at: number; expires_at: number } | null> {
  return first<{ csrf_secret: string; created_at: number; expires_at: number }>(
    db,
    `SELECT s.csrf_secret,s.created_at,s.expires_at FROM sessions s
     JOIN users u ON u.id=s.user_id AND u.status='active'
     WHERE s.id_hash=?/* scan-ephemeral-session-id-hash */ AND s.user_id=? AND s.revoked_at IS NULL
       AND s.expires_at>? AND s.idle_expires_at>?`,
    [sessionId, userId, expiresNow, idleNow],
  );
}
