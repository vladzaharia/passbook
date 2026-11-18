import { stmt } from '../../platform/db.ts';
import { broadcastValues, type NewBroadcast } from './repo.ts';

/** Automatic-message runs waiting or sending, and how many may exist at once. */
export interface RunCaps {
  /** Per organization and mode. */
  org: number;
  /** Platform-wide. */
  platform: number;
}

/**
 * Inserts an automatic message's run only while the rule has no run waiting or sending and the org
 * and the platform have room. One statement, so rules due in the same minute cannot all pass a
 * stale count. Test sends (`test:` keys) are not counted.
 */
export function insertRuleRunStmt(
  db: D1Database,
  b: NewBroadcast,
  caps: RunCaps,
): D1PreparedStatement {
  const live = `rule_id IS NOT NULL AND parent_id IS NULL AND state IN ('scheduled', 'sending')
    AND window_key NOT LIKE 'test:%'`;
  return stmt(
    db,
    `INSERT OR IGNORE INTO broadcasts (id, org_id, mode, kind, name, state, target, patch, notify, at,
       clear_after, expect, parent_id, rule_id, window_key, created_by_type, created_by_id, created_at, started_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM broadcasts WHERE ${live} AND rule_id = ?) = 0
       AND (SELECT COUNT(*) FROM broadcasts WHERE ${live} AND org_id = ? AND mode = ?) < ?
       AND (SELECT COUNT(*) FROM broadcasts WHERE ${live}) < ?`,
    [...broadcastValues(b), b.ruleId ?? '', b.orgId, b.mode, caps.org, caps.platform],
  );
}
