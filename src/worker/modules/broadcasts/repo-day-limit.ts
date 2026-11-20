import type { Mode } from '../../../shared/contracts/common.ts';
import { first } from '../../platform/db.ts';

const DAY = 86_400_000;

/**
 * Manual broadcasts of the mode created in the last day: drafts count; cancelled ones, rule runs and
 * follow-ups do not, and test sends never use up the live allowance.
 */
const MANUAL_TODAY = `SELECT COUNT(*) FROM broadcasts bc WHERE bc.org_id = ? AND bc.mode = ?
  AND bc.rule_id IS NULL AND bc.parent_id IS NULL AND bc.state <> 'cancelled' AND bc.created_at > ?`;

export async function manualBroadcastsToday(
  db: D1Database,
  orgId: string,
  mode: Mode,
  now: number,
): Promise<number> {
  const row = await first<{ n: number }>(db, `SELECT (${MANUAL_TODAY}) AS n`, [
    orgId,
    mode,
    now - DAY,
  ]);
  return row?.n ?? 0;
}

/**
 * The plan's `messages.perDay` as a statement condition: a missing value or a reached cap refuses. A rule's
 * test send is not a manual broadcast and is not capped.
 */
export function planGate(
  ruleId: string | null | undefined,
  orgId: string,
  mode: Mode,
  now: number,
) {
  if (ruleId) return { sql: '', params: [] };
  return {
    sql: ` AND COALESCE((SELECT CASE json_type(v.value) WHEN 'null' THEN 1
        WHEN 'integer' THEN (${MANUAL_TODAY}) < CAST(v.value AS INTEGER) ELSE 0 END
      FROM org_entitlement_values v WHERE v.org_id = ? AND v.key = 'messages.perDay'), 0) = 1`,
    params: [orgId, mode, now - DAY, orgId],
  };
}
