import { all, first, run, stmt } from '../../platform/db.ts';

export interface RuleRow {
  id: string;
  group_key: string;
  org_id: string;
  /** JSON array of org role names, or null for any role. */
  org_roles: string | null;
  created_by: string;
  created_at: number;
  ended_at: number | null;
  ended_by: string | null;
}

const COLUMNS = 'id, group_key, org_id, org_roles, created_by, created_at, ended_at, ended_by';

export interface NewRule {
  id: string;
  groupKey: string;
  orgId: string;
  orgRoles: readonly string[] | null;
  createdBy: string;
  now: number;
}

/** The statement, so a service can batch it with its audit row. A personal org or sandbox, a sixth rule and a second live rule for the pair are refused by the schema. */
export const insertRuleStmt = (db: D1Database, r: NewRule) =>
  stmt(
    db,
    'INSERT INTO idp_group_rules (id, group_key, org_id, org_roles, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [r.id, r.groupKey, r.orgId, r.orgRoles ? JSON.stringify(r.orgRoles) : null, r.createdBy, r.now],
  );

export async function insertRule(db: D1Database, r: NewRule): Promise<void> {
  await insertRuleStmt(db, r).run();
}

export const endRuleStmt = (db: D1Database, id: string, by: string, now: number) =>
  stmt(
    db,
    'UPDATE idp_group_rules SET ended_at = ?, ended_by = ? WHERE id = ? AND ended_at IS NULL',
    [now, by, id],
  );

/** True when a live rule ended. */
export async function endRule(
  db: D1Database,
  id: string,
  by: string,
  now: number,
): Promise<boolean> {
  return (await endRuleStmt(db, id, by, now).run()).meta.changes > 0;
}

export const ruleById = (db: D1Database, id: string) =>
  first<RuleRow>(db, `SELECT ${COLUMNS} FROM idp_group_rules WHERE id = ?`, [id]);

export const liveRulesOfGroup = (db: D1Database, groupKey: string) =>
  all<RuleRow>(
    db,
    `SELECT ${COLUMNS} FROM idp_group_rules WHERE group_key = ? AND ended_at IS NULL ORDER BY created_at, id`,
    [groupKey],
  );

/** Tenant-scoped: the live rules that feed from one org (the org closes, its rules end with it). */
export const liveRulesOfOrg = (db: D1Database, orgId: string) =>
  all<RuleRow>(
    db,
    `SELECT ${COLUMNS} FROM idp_group_rules WHERE org_id = ? AND ended_at IS NULL ORDER BY group_key, id`,
    [orgId],
  );

/** Ends every live rule of a group (a delete), returning how many ended. */
export async function endRulesOfGroup(
  db: D1Database,
  groupKey: string,
  by: string,
  now: number,
): Promise<number> {
  return (
    await run(
      db,
      'UPDATE idp_group_rules SET ended_at = ?, ended_by = ? WHERE group_key = ? AND ended_at IS NULL',
      [now, by, groupKey],
    )
  ).changes;
}
