import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first, run, type SqlValue, stmt } from '../../platform/db.ts';
import { broadcastAuthority } from '../broadcasts/repo.ts';
import type { TenantPassWrite } from '../passes/http.ts';

export interface RuleRow {
  id: string;
  org_id: string;
  mode: Mode;
  name: string;
  state: 'on' | 'paused';
  paused_code: string | null;
  template_ids: string;
  match: string | null;
  anchor_kind: 'input' | 'last_scan';
  anchor_input: string | null;
  offset_amount: number;
  offset_unit: 'day' | 'hour';
  offset_when: 'before' | 'after';
  yearly: number;
  send_at: string;
  time_zone: string;
  message: string;
  clear_after: number | null;
  next_check_at: number | null;
  checked_at: number | null;
  last_broadcast_id: string | null;
  sent: number;
  skipped: number;
  version: number;
  created_by_type: string | null;
  created_by_id: string | null;
  created_at: number;
  edited_at: number;
}

/** The columns a save writes, in order. */
export interface RuleValues {
  name: string;
  state: 'on' | 'paused';
  pausedCode: string | null;
  templateIds: string[];
  match: unknown;
  anchorKind: 'input' | 'last_scan';
  anchorInput: string | null;
  offsetAmount: number;
  offsetUnit: 'day' | 'hour';
  offsetWhen: 'before' | 'after';
  yearly: boolean;
  sendAt: string;
  timeZone: string;
  message: string;
  clearAfter: number | null;
  nextCheckAt: number | null;
}

const valuesOf = (v: RuleValues): SqlValue[] => [
  v.name,
  v.state,
  v.pausedCode,
  JSON.stringify(v.templateIds),
  v.match === undefined ? null : JSON.stringify(v.match),
  v.anchorKind,
  v.anchorInput,
  v.offsetAmount,
  v.offsetUnit,
  v.offsetWhen,
  v.yearly ? 1 : 0,
  v.sendAt,
  v.timeZone,
  v.message,
  v.clearAfter,
  v.nextCheckAt,
];

export const MAX_ACTIVE_RULES = 10;

/** Inserts while the checked authority holds and the org and mode have room for another active rule. */
export function insertRuleStmt(
  db: D1Database,
  r: {
    id: string;
    orgId: string;
    mode: Mode;
    actor: { type: string; id: string | null };
    now: number;
    values: RuleValues;
  },
  authority: TenantPassWrite,
): D1PreparedStatement {
  const guard = broadcastAuthority(authority, r.now, false);
  return stmt(
    db,
    `INSERT OR IGNORE INTO message_rules (id, org_id, mode, name, state, paused_code, template_ids, match,
       anchor_kind, anchor_input, offset_amount, offset_unit, offset_when, yearly, send_at, time_zone, message,
       clear_after, next_check_at, created_by_type, created_by_id, created_at, edited_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE ? = ? AND ? = ? AND (${guard.sql})
       AND (? <> 'on' OR (SELECT COUNT(*) FROM message_rules WHERE org_id = ? AND mode = ? AND state = 'on') < ?)`,
    [
      r.id,
      r.orgId,
      r.mode,
      ...valuesOf(r.values),
      r.actor.type,
      r.actor.id,
      r.now,
      r.now,
      r.orgId,
      authority.orgId,
      r.mode,
      authority.mode,
      ...guard.params,
      r.values.state,
      r.orgId,
      r.mode,
      MAX_ACTIVE_RULES,
    ],
  );
}

/** Replaces a rule at the version the editor read; bumps the version. */
export function updateRuleStmt(
  db: D1Database,
  id: string,
  version: number,
  values: RuleValues,
  actor: { type: string; id: string | null },
  authority: TenantPassWrite,
  now: number,
): D1PreparedStatement {
  const guard = broadcastAuthority(authority, now, false);
  return stmt(
    db,
    `UPDATE message_rules SET name = ?, state = ?, paused_code = ?, template_ids = ?, match = ?,
       anchor_kind = ?, anchor_input = ?, offset_amount = ?, offset_unit = ?, offset_when = ?, yearly = ?,
       send_at = ?, time_zone = ?, message = ?, clear_after = ?, next_check_at = ?,
       created_by_type = ?, created_by_id = ?, version = version + 1, edited_at = ?
     WHERE id = ? AND version = ? AND org_id = ? AND mode = ? AND (${guard.sql})
       AND (? <> 'on' OR state = 'on'
         OR (SELECT COUNT(*) FROM message_rules WHERE org_id = ? AND mode = ? AND state = 'on') < ?)`,
    [
      ...valuesOf(values),
      actor.type,
      actor.id,
      now,
      id,
      version,
      authority.orgId,
      authority.mode,
      ...guard.params,
      values.state,
      authority.orgId,
      authority.mode,
      MAX_ACTIVE_RULES,
    ],
  );
}

export function pauseRuleStmt(
  db: D1Database,
  id: string,
  authority: TenantPassWrite,
  now: number,
): D1PreparedStatement {
  const guard = broadcastAuthority(authority, now, false);
  return stmt(
    db,
    `UPDATE message_rules SET state = 'paused', paused_code = NULL, next_check_at = NULL,
       version = version + 1, edited_at = ?
     WHERE id = ? AND state = 'on' AND org_id = ? AND mode = ? AND (${guard.sql})`,
    [now, id, authority.orgId, authority.mode, ...guard.params],
  );
}

export function deleteRuleStmt(
  db: D1Database,
  id: string,
  authority: TenantPassWrite,
  now: number,
): D1PreparedStatement {
  const guard = broadcastAuthority(authority, now, false);
  return stmt(
    db,
    `DELETE FROM message_rules WHERE id = ? AND org_id = ? AND mode = ? AND (${guard.sql})`,
    [id, authority.orgId, authority.mode, ...guard.params],
  );
}

/** Scheduled runs of a deleted rule never start; sending ones finish. */
export const cancelScheduledRuns = (db: D1Database, ruleId: string, orgId: string, now: number) =>
  run(
    db,
    `UPDATE broadcasts SET state = 'cancelled', finished_at = ?
     WHERE rule_id = ? AND org_id = ? AND state IN ('draft', 'scheduled')`,
    [now, ruleId, orgId],
  );

export const getRule = (db: D1Database, id: string, orgId: string | null) =>
  first<RuleRow>(db, 'SELECT * FROM message_rules WHERE id = ? AND (? IS NULL OR org_id = ?)', [
    id,
    orgId,
    orgId,
  ]);

export async function listRules(
  db: D1Database,
  f: {
    orgId: string;
    mode: Mode;
    state?: string | undefined;
    cursor?: string | undefined;
    limit: number;
  },
): Promise<{ rows: RuleRow[]; nextCursor: string | null }> {
  const where = ['org_id = ?', 'mode = ?'];
  const params: SqlValue[] = [f.orgId, f.mode];
  if (f.state) {
    where.push('state = ?');
    params.push(f.state);
  }
  if (f.cursor) {
    where.push('id < ?');
    params.push(f.cursor);
  }
  const rows = await all<RuleRow>(
    db,
    `SELECT * FROM message_rules WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
    [...params, f.limit + 1],
  );
  const page = rows.slice(0, f.limit);
  const last = page.at(-1);
  return { rows: page, nextCursor: rows.length > f.limit && last ? last.id : null };
}

/** Due rules, soonest first. */
export const dueRuleIds = (db: D1Database, now: number, limit: number) =>
  all<{ id: string }>(
    db,
    `SELECT id FROM message_rules WHERE state = 'on' AND next_check_at <= ? ORDER BY next_check_at LIMIT ?`,
    [now, limit],
  );

/** The lease: a job that never runs is claimed again after `until`. */
export const leaseRules = (db: D1Database, ids: readonly string[], now: number, until: number) =>
  run(
    db,
    `UPDATE message_rules SET next_check_at = ?, checked_at = ?
     WHERE state = 'on' AND id IN (SELECT value FROM json_each(?))`,
    [until, now, JSON.stringify(ids)],
  );

export const setNextCheck = (
  db: D1Database,
  id: string,
  nextCheckAt: number,
  broadcastId?: string,
) =>
  run(
    db,
    `UPDATE message_rules SET next_check_at = ?, last_broadcast_id = COALESCE(?, last_broadcast_id)
     WHERE id = ? AND state = 'on'`,
    [nextCheckAt, broadcastId ?? null, id],
  );

/** The runner pauses a rule with a code; saving it again resumes. */
export const pauseWithCode = (db: D1Database, id: string, code: string, now: number) =>
  run(
    db,
    `UPDATE message_rules SET state = 'paused', paused_code = ?, next_check_at = NULL,
       version = version + 1, edited_at = ?
     WHERE id = ? AND state = 'on'`,
    [code, now, id],
  );

/** Rule runs still waiting or sending: for this rule, for the org and mode, and platform-wide. */
export const runningRuleBroadcasts = (db: D1Database, ruleId: string, orgId: string, mode: Mode) =>
  first<{ own: number; org: number; platform: number }>(
    db,
    `SELECT
       COALESCE(SUM(rule_id = ?), 0) AS own,
       COALESCE(SUM(org_id = ? AND mode = ? AND state = 'sending'), 0) AS org,
       COALESCE(SUM(state = 'sending'), 0) AS platform
     FROM broadcasts
     WHERE rule_id IS NOT NULL AND parent_id IS NULL AND state IN ('scheduled', 'sending')`,
    [ruleId, orgId, mode],
  );

export const deleteTestRules = async (db: D1Database, before: number, limit: number) =>
  (
    await run(
      db,
      `DELETE FROM message_rules WHERE id IN
         (SELECT id FROM message_rules WHERE mode = 'test' AND edited_at < ? LIMIT ?)`,
      [before, limit],
    )
  ).changes;

/** The run a window key made: a retried check finds it instead of making a second. */
export const runByWindow = (db: D1Database, ruleId: string, windowKey: string) =>
  first<{ id: string }>(db, 'SELECT id FROM broadcasts WHERE rule_id = ? AND window_key = ?', [
    ruleId,
    windowKey,
  ]);
