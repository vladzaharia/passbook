import { first } from '../../platform/db.ts';

const DAY = 86_400_000;

/** Manual broadcasts created in the last day: drafts count; cancelled ones, rule runs and follow-ups do not. */
const MANUAL_TODAY = `SELECT COUNT(*) FROM broadcasts bc WHERE bc.org_id = ? AND bc.rule_id IS NULL
  AND bc.parent_id IS NULL AND bc.state <> 'cancelled' AND bc.created_at > ?`;

export async function manualBroadcastsToday(
  db: D1Database,
  orgId: string,
  now: number,
): Promise<number> {
  return (
    (await first<{ n: number }>(db, `SELECT (${MANUAL_TODAY}) AS n`, [orgId, now - DAY]))?.n ?? 0
  );
}

/**
 * The plan's `messages.perDay` as a statement condition: a missing value or a reached cap refuses. A rule's
 * test send is not a manual broadcast and is not capped.
 */
export function planGate(ruleId: string | null | undefined, orgId: string, now: number) {
  if (ruleId) return { sql: '', params: [] };
  return {
    sql: ` AND COALESCE((SELECT CASE json_type(v.value) WHEN 'null' THEN 1
        WHEN 'integer' THEN (${MANUAL_TODAY}) < CAST(v.value AS INTEGER) ELSE 0 END
      FROM org_entitlement_values v WHERE v.org_id = ? AND v.key = 'messages.perDay'), 0) = 1`,
    params: [orgId, now - DAY, orgId],
  };
}
