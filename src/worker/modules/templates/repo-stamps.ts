import type { Mode } from '../../../shared/contracts/common.ts';
import { all } from '../../platform/db.ts';

export interface StampRow {
  version: string;
  stamps: number;
  cards: number;
}

/**
 * Live cards of a template by version and stamp count, read from each pass's input. `orgId`
 * undefined reads every organization; null reads none.
 */
export async function stampHistogram(
  db: D1Database,
  q: { templateId: string; input: string; mode: Mode; orgId?: string | null },
): Promise<StampRow[]> {
  if (q.orgId === null) return [];
  const rows = await all<{ v: string; c: number | null; n: number }>(
    db,
    `SELECT template_version AS v, CAST(json_extract(personalization, ?) AS INTEGER) AS c, COUNT(*) AS n
     FROM passes
     WHERE template_id = ? AND mode = ? AND status = 'active' AND deleted_at IS NULL${q.orgId === undefined ? '' : ' AND org_id = ?'}
     GROUP BY v, c`,
    [`$."${q.input}"`, q.templateId, q.mode, ...(q.orgId === undefined ? [] : [q.orgId])],
  );
  return rows.map((r) => ({ version: r.v, stamps: Math.max(0, r.c ?? 0), cards: r.n }));
}
