import { first, run, type SqlValue } from '../../platform/db.ts';
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
 * occurrence, except a row this same run wrote (a retried chunk finishes its own claims, so a crash
 * after the publish still gets counted). Both sides use the same value: exclusion and claim agree.
 */
export function ruleWindowWhere(w: RuleWindow, ruleId: string, broadcastId = ''): Sql {
  const win = windowSql(w);
  const occ = occurrenceSql(w);
  return {
    sql: `(${win.sql}) AND NOT EXISTS (SELECT 1 FROM message_rule_fires f
      WHERE f.rule_id = ? AND f.pass_id = ${PASS}.id AND f.occurrence = ${occ.sql}
        AND f.broadcast_id IS NOT ?)`,
    params: [...win.params, ruleId, ...occ.params, broadcastId],
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
  /** Rule sends one pass may get in 24 hours; counted from the fire rows, in this statement. */
  slots: number;
}

const DAY_MS = 86_400_000;

/**
 * Writes the fire row before the publish. `duplicate` when another run already fired this
 * occurrence; `full` when the pass already got `slots` rule sends in 24 hours (counted in the same
 * statement, so rules racing for one pass cannot both pass); `claimed` also for this run's own row,
 * so a retry resumes it (the publish is idempotent).
 */
export async function claimFire(
  db: D1Database,
  c: Claim,
): Promise<'claimed' | 'duplicate' | 'full'> {
  const occ = occurrenceSql(c.window);
  const { changes } = await run(
    db,
    `INSERT OR IGNORE INTO message_rule_fires (rule_id, pass_id, occurrence, org_id, mode, broadcast_id, fired_at)
     SELECT ?, ${PASS}.id, ${occ.sql}, ${PASS}.org_id, ${PASS}.mode, ?, ?
     FROM ${PASS} WHERE ${PASS}.id = ? AND ${PASS}.org_id = ? AND ${PASS}.mode = ? AND ${occ.sql} IS NOT NULL
       AND (SELECT COUNT(*) FROM message_rule_fires b WHERE b.pass_id = ${PASS}.id AND b.fired_at > ?) < ?`,
    [
      c.ruleId,
      ...occ.params,
      c.broadcastId,
      c.now,
      c.passId,
      c.orgId,
      c.mode,
      ...occ.params,
      c.now - DAY_MS,
      c.slots,
    ],
  );
  if (changes === 1) return 'claimed';
  const own = await first<{ one: number }>(
    db,
    `SELECT 1 AS one FROM message_rule_fires f WHERE f.rule_id = ? AND f.pass_id = ? AND f.broadcast_id = ?
       AND f.occurrence = (SELECT ${occ.sql} FROM ${PASS} WHERE ${PASS}.id = ?)`,
    [c.ruleId, c.passId, c.broadcastId, ...occ.params, c.passId],
  );
  if (own !== null) return 'claimed';
  const taken = await first<{ one: number }>(
    db,
    `SELECT 1 AS one FROM message_rule_fires f WHERE f.rule_id = ? AND f.pass_id = ?
       AND f.occurrence = (SELECT ${occ.sql} FROM ${PASS} WHERE ${PASS}.id = ?)`,
    [c.ruleId, c.passId, ...occ.params, c.passId],
  );
  return taken === null ? 'full' : 'duplicate';
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
