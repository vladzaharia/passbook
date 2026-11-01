import { all, first, likeEscape, run } from '../../platform/db.ts';
import type { UserRow } from '../auth/repo.ts';

export { getUser, type UserRow } from '../auth/repo.ts';
export { listRecentSessions } from '../auth/sessions-repo.ts';

type Db = D1Database;

export interface ListFilter {
  q?: string;
  status?: 'active' | 'disabled';
  cursor?: string;
  limit: number;
}

/** Newest first. The cursor is the last id (UUIDv7, so id order is creation order). */
export async function listUsers(db: Db, f: ListFilter): Promise<UserRow[]> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (f.status) {
    where.push('status = ?');
    params.push(f.status);
  }
  if (f.cursor) {
    where.push('id < ?');
    params.push(f.cursor);
  }
  const q = f.q?.trim();
  if (q) {
    const like = `%${likeEscape(q.toLowerCase())}%`;
    where.push(
      `(id = ? OR lower(primary_email) LIKE ? ESCAPE '\\' OR lower(coalesce(name, '')) LIKE ? ESCAPE '\\'
        OR id IN (SELECT user_id FROM user_emails WHERE email LIKE ? ESCAPE '\\'))`,
    );
    params.push(q, like, like, like);
  }
  params.push(f.limit + 1);
  return all<UserRow>(
    db,
    `SELECT * FROM users ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
    params,
  );
}

export const identitiesOf = (db: Db, userId: string) =>
  all<{
    provider: string;
    subject: string;
    email_claim: string | null;
    email_verified: number;
    groups: string;
    last_used_at: number | null;
  }>(
    db,
    `SELECT provider, subject, email_claim, email_verified, groups, last_used_at
     FROM auth_identities WHERE user_id = ? ORDER BY created_at`,
    [userId],
  );

export interface OwnedPassRow {
  id: string;
  title: string;
  template_name: string;
  org_name: string;
  status: 'active' | 'voided';
}

export const ownedPasses = (db: Db, userId: string) =>
  all<OwnedPassRow>(
    db,
    `SELECT p.id, COALESCE(p.display_title, p.serial) AS title,
            COALESCE(t.name, p.template_id) AS template_name, o.name AS org_name, p.status
     FROM passes p
     JOIN orgs o ON o.id = p.org_id
     LEFT JOIN templates t ON t.id = p.template_id
     WHERE p.owner_user_id = ? ORDER BY p.id DESC LIMIT 100`,
    [userId],
  );

export async function ownedPassCount(db: Db, userId: string): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    'SELECT count(*) AS n FROM passes WHERE owner_user_id = ?',
    [userId],
  );
  return row?.n ?? 0;
}

export const recentAudit = (db: Db, userId: string) =>
  all<{ id: number; at: number; action: string; actor_type: string; actor_id: string | null }>(
    db,
    `SELECT id, at, action, actor_type, actor_id FROM audit_log
     WHERE target_type = 'user' AND target_id = ? ORDER BY at DESC, id DESC LIMIT 20`,
    [userId],
  );

export async function setStatus(db: Db, userId: string, status: 'active' | 'disabled') {
  await run(db, 'UPDATE users SET status = ? WHERE id = ?', [status, userId]);
}

export async function removeEmail(db: Db, userId: string, email: string): Promise<boolean> {
  const { changes } = await run(db, 'DELETE FROM user_emails WHERE user_id = ? AND email = ?', [
    userId,
    email,
  ]);
  return changes > 0;
}
