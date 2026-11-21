import { all, first } from '../../platform/db.ts';

/** Sandboxes made since `since`, counted by the furthest funnel column each has set. */
export const funnelCounts = (db: D1Database, since: number) =>
  first<Record<'sandboxes' | 'viewed' | 'called' | 'passed' | 'previewed', number>>(
    db,
    `SELECT COUNT(*) AS sandboxes,
       COUNT(quickstart_viewed_at) AS viewed,
       COUNT(first_call_at) AS called,
       COUNT(first_pass_at) AS passed,
       COUNT(first_preview_at) AS previewed
     FROM developer_sandboxes WHERE created_at >= ?`,
    [since],
  );

/** Page view to first pass in ms, ascending; only sandboxes whose first pass came after the view (a pass made first is not time to first pass). */
export const ttfpSamples = async (db: D1Database, since: number, cap: number): Promise<number[]> =>
  (
    await all<{ ms: number }>(
      db,
      `SELECT first_pass_at - quickstart_viewed_at AS ms FROM developer_sandboxes
       WHERE created_at >= ? AND first_pass_at IS NOT NULL AND quickstart_viewed_at IS NOT NULL
         AND first_pass_at >= quickstart_viewed_at
       ORDER BY ms LIMIT ?`,
      [since, cap],
    )
  ).map((r) => r.ms);

export const viewedAndPassed = async (db: D1Database, since: number): Promise<number> =>
  (
    await first<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM developer_sandboxes
       WHERE created_at >= ? AND quickstart_viewed_at IS NOT NULL AND first_pass_at IS NOT NULL
         AND first_pass_at >= quickstart_viewed_at`,
      [since],
    )
  )?.n ?? 0;
