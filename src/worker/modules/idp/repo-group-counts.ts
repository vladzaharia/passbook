import { all } from '../../platform/db.ts';

/** Live org rules and manual members per group, in two queries. */
export async function liveSourceCounts(
  db: D1Database,
): Promise<Map<string, { rules: number; manual: number }>> {
  const [rules, members] = await Promise.all([
    all<{ k: string; n: number }>(
      db,
      'SELECT group_key AS k, count(*) AS n FROM idp_group_rules WHERE ended_at IS NULL GROUP BY group_key',
    ),
    all<{ k: string; n: number }>(
      db,
      'SELECT group_key AS k, count(*) AS n FROM idp_group_members WHERE removed_at IS NULL GROUP BY group_key',
    ),
  ]);
  const out = new Map<string, { rules: number; manual: number }>();
  const slot = (k: string) => {
    const cur = out.get(k) ?? { rules: 0, manual: 0 };
    out.set(k, cur);
    return cur;
  };
  for (const r of rules) slot(r.k).rules = r.n;
  for (const m of members) slot(m.k).manual = m.n;
  return out;
}
