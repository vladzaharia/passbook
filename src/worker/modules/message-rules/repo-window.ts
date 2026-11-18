import { run, type SqlValue } from '../../platform/db.ts';
import type { RuleWindow } from './windows.ts';

type Sql = { sql: string; params: SqlValue[] };

const PASS = 'passes';

/** The anchor input's text value; null for a missing key, a non-object or a non-text value. */
function anchorSql(input: string): Sql {
  return {
    sql: `(CASE WHEN json_valid(${PASS}.personalization) AND json_type(${PASS}.personalization) = 'object'
      THEN (SELECT i.value FROM json_each(${PASS}.personalization) i WHERE i.key = ? AND i.type = 'text') END)`,
    params: [input],
  };
}

const lastScanSql = (): Sql => ({
  sql: `(SELECT MAX(s.at) FROM scans s WHERE s.pass_id = ${PASS}.id AND s.org_id = ${PASS}.org_id
    AND s.mode = ${PASS}.mode AND s.state = 'done')`,
  params: [],
});

/** What makes a fire unique, as SQL over the pass: the same value the claim writes. */
function occurrenceSql(w: RuleWindow): Sql {
  if (w.kind === 'lastScan') {
    const l = lastScanSql();
    return { sql: `CAST(${l.sql} AS TEXT)`, params: l.params };
  }
  if (w.kind === 'yearly') return { sql: '?', params: [w.occurrence] };
  return anchorSql(w.input);
}

function windowSql(w: RuleWindow): Sql {
  if (w.kind === 'lastScan') {
    const l = lastScanSql();
    return { sql: `${l.sql} >= ? AND ${l.sql} < ?`, params: [w.fromMs, w.toMs] };
  }
  const a = anchorSql(w.input);
  const twice = (n: number) => Array.from({ length: n }, () => a.params).flat();
  if (w.kind === 'date') return { sql: `${a.sql} = ?`, params: [...a.params, w.date] };
  if (w.kind === 'yearly')
    return {
      sql: `length(${a.sql}) = 10 AND substr(${a.sql}, 6, 5) IN (${w.monthDays.map(() => '?').join(', ')})`,
      params: [...twice(2), ...w.monthDays],
    };
  const end = w.inclusiveEnd ? '<=' : '<';
  return {
    sql: `length(${a.sql}) > 10 AND unixepoch(${a.sql}) * 1000 >= ? AND unixepoch(${a.sql}) * 1000 ${end} ?`,
    params: [...twice(1), ...twice(1), w.fromMs, ...twice(1), w.toMs],
  };
}

/**
 * The predicate for a rule run: the pass is inside the window and has no fire row for this
 * occurrence. Both sides use the same value, so the exclusion and the claim agree.
 */
export function ruleWindowWhere(w: RuleWindow, ruleId: string): Sql {
  const win = windowSql(w);
  const occ = occurrenceSql(w);
  return {
    sql: `(${win.sql}) AND NOT EXISTS (SELECT 1 FROM message_rule_fires f
      WHERE f.rule_id = ? AND f.pass_id = ${PASS}.id AND f.occurrence = ${occ.sql})`,
    params: [...win.params, ruleId, ...occ.params],
  };
}

export interface Claim {
  ruleId: string;
  broadcastId: string;
  passId: string;
  orgId: string;
  mode: string;
  window: RuleWindow;
  now: number;
}

/** Writes the fire row before the publish. False when the pass already fired this occurrence. */
export async function claimFire(db: D1Database, c: Claim): Promise<boolean> {
  const occ = occurrenceSql(c.window);
  const { changes } = await run(
    db,
    `INSERT OR IGNORE INTO message_rule_fires (rule_id, pass_id, occurrence, org_id, mode, broadcast_id, fired_at)
     SELECT ?, ${PASS}.id, ${occ.sql}, ${PASS}.org_id, ${PASS}.mode, ?, ?
     FROM ${PASS} WHERE ${PASS}.id = ? AND ${PASS}.org_id = ? AND ${PASS}.mode = ? AND ${occ.sql} IS NOT NULL`,
    [c.ruleId, ...occ.params, c.broadcastId, c.now, c.passId, c.orgId, c.mode, ...occ.params],
  );
  return changes === 1;
}

/** A pass-level failure: the claim goes, so a later check inside the window retries. */
export const releaseFire = (db: D1Database, ruleId: string, passId: string, broadcastId: string) =>
  run(db, 'DELETE FROM message_rule_fires WHERE rule_id = ? AND pass_id = ? AND broadcast_id = ?', [
    ruleId,
    passId,
    broadcastId,
  ]);

/** Fires older than `before`, oldest first; yearly occurrences are keyed by year, so 400 days is enough. */
export const deleteOldFires = async (db: D1Database, before: number, limit: number) =>
  (
    await run(
      db,
      `DELETE FROM message_rule_fires WHERE (rule_id, pass_id, occurrence) IN
         (SELECT rule_id, pass_id, occurrence FROM message_rule_fires WHERE fired_at < ? ORDER BY fired_at LIMIT ?)`,
      [before, limit],
    )
  ).changes;

export const addRuleCounts = (db: D1Database, ruleId: string, sent: number, skipped: number) =>
  run(db, 'UPDATE message_rules SET sent = sent + ?, skipped = skipped + ? WHERE id = ?', [
    sent,
    skipped,
    ruleId,
  ]);
