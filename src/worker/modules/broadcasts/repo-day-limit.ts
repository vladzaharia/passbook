import type { BroadcastKind } from '../../../shared/contracts/broadcasts.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { first } from '../../platform/db.ts';

const DAY = 86_400_000;

/** The plan key that caps each kind: messages and change runs count apart. */
export const DAY_LIMIT_KEY = {
  message: 'messages.perDay',
  change: 'passes.changesPerDay',
} as const satisfies Record<BroadcastKind, string>;

const PLAN_KEY = {
  message: "v.key = 'messages.perDay'",
  change: "v.key = 'passes.changesPerDay'",
} as const satisfies Record<BroadcastKind, string>;

/**
 * Manual broadcasts of the mode and kind created in the last day: drafts count; cancelled ones, rule
 * runs, follow-ups and undos do not, and test sends never use up the live allowance.
 */
const manualToday = (kind: BroadcastKind) =>
  `SELECT COUNT(*) FROM broadcasts bc WHERE bc.org_id = ? AND bc.mode = ? AND bc.kind = '${kind}'
  AND bc.rule_id IS NULL AND bc.parent_id IS NULL AND bc.state <> 'cancelled' AND bc.created_at > ?`;

export async function manualBroadcastsToday(
  db: D1Database,
  orgId: string,
  mode: Mode,
  now: number,
  kind: BroadcastKind = 'message',
): Promise<number> {
  const row = await first<{ n: number }>(db, `SELECT (${manualToday(kind)}) AS n`, [
    orgId,
    mode,
    now - DAY,
  ]);
  return row?.n ?? 0;
}

/**
 * The plan's daily cap for the kind as a statement condition: a missing value or a reached cap
 * refuses. A rule's test send and an undo are not manual broadcasts and are not capped.
 */
export function planGate(
  exempt: string | null | undefined,
  orgId: string,
  mode: Mode,
  now: number,
  kind: BroadcastKind = 'message',
) {
  if (exempt) return { sql: '', params: [] };
  return {
    sql: ` AND COALESCE((SELECT CASE json_type(v.value) WHEN 'null' THEN 1
        WHEN 'integer' THEN (${manualToday(kind)}) < CAST(v.value AS INTEGER) ELSE 0 END
      FROM org_entitlement_values v WHERE v.org_id = ? AND ${PLAN_KEY[kind]}), 0) = 1`,
    params: [orgId, mode, now - DAY, orgId],
  };
}
