import { all, chunk, placeholders } from '../../platform/db.ts';

export interface UserMembership {
  membership_id: string;
  org_id: string;
  org_name: string;
  org_status: string;
  last_admin: 0 | 1;
}

/**
 * Live memberships of a user outside personal orgs, with whether each org would lose its last active org admin
 * if this one ended: the same rule the revoke enforces.
 */
export const membershipsOfUser = (db: D1Database, userId: string) =>
  all<UserMembership>(
    db,
    `SELECT m.id AS membership_id, m.org_id, o.name AS org_name, o.status AS org_status,
       CASE WHEN EXISTS (SELECT 1 FROM json_each(m.roles) r WHERE r.type = 'text' AND r.value = 'org_admin')
         AND NOT EXISTS (SELECT 1 FROM org_memberships o2 JOIN users u2 ON u2.id = o2.user_id
           WHERE o2.org_id = m.org_id AND o2.id != m.id AND o2.revoked_at IS NULL AND u2.status = 'active'
             AND EXISTS (SELECT 1 FROM json_each(o2.roles) r2 WHERE r2.type = 'text' AND r2.value = 'org_admin'))
         THEN 1 ELSE 0 END AS last_admin
     FROM org_memberships m JOIN orgs o ON o.id = m.org_id
     WHERE m.user_id = ? AND m.revoked_at IS NULL AND o.personal_user_id IS NULL
     ORDER BY o.name, m.id`,
    [userId],
  );

/** Org names and statuses by id. */
export async function orgInfo(
  db: D1Database,
  ids: readonly string[],
): Promise<Map<string, { name: string; status: string }>> {
  const out = new Map<string, { name: string; status: string }>();
  for (const part of chunk([...new Set(ids)])) {
    const rows = await all<{ id: string; name: string; status: string }>(
      db,
      `SELECT id, name, status FROM orgs WHERE id IN (${placeholders(part.length)})`,
      part,
    );
    for (const r of rows) out.set(r.id, { name: r.name, status: r.status });
  }
  return out;
}

/** Live personal keys of memberships: they stop working with the membership. */
export async function livePersonalKeyCount(
  db: D1Database,
  membershipIds: readonly string[],
): Promise<number> {
  let n = 0;
  for (const part of chunk([...membershipIds]))
    n +=
      (
        await all<{ n: number }>(
          db,
          `SELECT count(*) AS n FROM api_keys WHERE kind = 'personal' AND revoked_at IS NULL
           AND membership_id IN (${placeholders(part.length)})`,
          part,
        )
      )[0]?.n ?? 0;
  return n;
}

/** Live platform-wide keys the user made. */
export async function platformKeysMadeBy(db: D1Database, userId: string): Promise<string[]> {
  const rows = await all<{ id: string }>(
    db,
    `SELECT id FROM api_keys WHERE kind = 'platform' AND created_by = ? AND revoked_at IS NULL ORDER BY id`,
    [userId],
  );
  return rows.map((r) => r.id);
}

export async function liveSessionCount(
  db: D1Database,
  userId: string,
  now: number,
): Promise<number> {
  const rows = await all<{ n: number }>(
    db,
    'SELECT count(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?',
    [userId, now],
  );
  return rows[0]?.n ?? 0;
}

/** The newest change the SCIM feed carried, or null before any. */
export async function lastScimChange(db: D1Database): Promise<number | null> {
  const rows = await all<{ at: number | null }>(
    db,
    'SELECT max(last_modified) AS at FROM idp_directory_users',
  );
  return rows[0]?.at ?? null;
}
