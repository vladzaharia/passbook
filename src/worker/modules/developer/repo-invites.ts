import { all } from '../../platform/db.ts';

/** Orgs with an open developer invitation for an address the user has verified, by name. */
export async function pendingInviteOrgs(
  db: D1Database,
  userId: string,
  now: number,
): Promise<string[]> {
  const rows = await all<{ name: string }>(
    db,
    `SELECT DISTINCT o.name FROM developer_invitations i
       JOIN orgs o ON o.id = i.org_id AND o.status = 'active'
       JOIN user_emails e ON e.email = i.email AND e.user_id = ?
      WHERE i.revoked_at IS NULL AND i.accepted_at IS NULL AND i.expires_at > ?
      ORDER BY o.name LIMIT 5`,
    [userId, now],
  );
  return rows.map((r) => r.name);
}
