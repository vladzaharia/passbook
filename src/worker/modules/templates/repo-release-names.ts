import { all } from '../../platform/db.ts';
import { userLabelSql } from '../orgs/repo-user-label.ts';

/**
 * Display names for user ids: the name, else the email the org knows the user by, else "Account"; never
 * the id. Only a platform administrator's response (`platform`) may fall back to the account email.
 */
export async function userNames(
  db: D1Database,
  ids: readonly (string | null)[],
  orgId: string | null,
  platform: boolean,
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))];
  const names = new Map<string, string>();
  // The org is a bound parameter only where the label uses it: a membership lookup for a tenant.
  const bound = orgId !== null && !platform;
  const org = bound ? '?' : 'NULL';
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const rows = await all<{ id: string; name: string }>(
      db,
      `SELECT id, ${userLabelSql('users.id', org, platform)} AS name FROM users WHERE id IN (${chunk.map(() => '?').join(', ')})`,
      [...(bound ? [orgId] : []), ...chunk],
    );
    for (const r of rows) names.set(r.id, r.name);
  }
  return names;
}
