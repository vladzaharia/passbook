import { all } from '../../platform/db.ts';

/** Display names for user ids: the name, else the sign-in email; never the id. */
export async function userNames(
  db: D1Database,
  ids: readonly (string | null)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))];
  const names = new Map<string, string>();
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const rows = await all<{ id: string; name: string | null; email: string }>(
      db,
      `SELECT id, name, primary_email AS email FROM users WHERE id IN (${chunk.map(() => '?').join(', ')})`,
      chunk,
    );
    for (const r of rows) names.set(r.id, r.name?.trim() || r.email);
  }
  return names;
}
