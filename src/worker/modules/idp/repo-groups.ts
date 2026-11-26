import { all, first, run, stmt } from '../../platform/db.ts';

export type GroupKind = 'custom' | 'adopted';

export interface GroupRow {
  key: string;
  kind: GroupKind;
  friendly_name: string;
  created_by: string | null;
  created_at: number;
  deleted_at: number | null;
}

const COLUMNS = 'key, kind, friendly_name, created_by, created_at, deleted_at';

export const groupByKey = (db: D1Database, key: string) =>
  first<GroupRow>(db, `SELECT ${COLUMNS} FROM idp_groups WHERE key = ?`, [key]);

export const liveGroups = (db: D1Database) =>
  all<GroupRow>(db, `SELECT ${COLUMNS} FROM idp_groups WHERE deleted_at IS NULL ORDER BY key`);

/** Counts toward `CUSTOM_GROUP_LIMIT`. */
export async function liveGroupCount(db: D1Database): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    'SELECT count(*) AS n FROM idp_groups WHERE deleted_at IS NULL',
  );
  return row?.n ?? 0;
}

export interface NewGroup {
  key: string;
  kind: GroupKind;
  friendlyName: string;
  createdBy: string | null;
  now: number;
}

/** The statement, so a service can batch it with the group's rules and its audit row. A key is never reused, even after a delete: the insert is refused. */
export const insertGroupStmt = (db: D1Database, g: NewGroup) =>
  stmt(
    db,
    'INSERT INTO idp_groups (key, kind, friendly_name, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
    [g.key, g.kind, g.friendlyName, g.createdBy, g.now],
  );

export async function insertGroup(db: D1Database, g: NewGroup): Promise<void> {
  await insertGroupStmt(db, g).run();
}

/** The display name only: the group's name never changes. True when a live group changed. */
export async function renameGroup(
  db: D1Database,
  key: string,
  friendlyName: string,
): Promise<boolean> {
  return (
    (
      await run(
        db,
        'UPDATE idp_groups SET friendly_name = ? WHERE key = ? AND deleted_at IS NULL',
        [friendlyName, key],
      )
    ).changes > 0
  );
}

/** Soft delete, once. The caller ends the group's rules and members first. */
export async function markGroupDeleted(db: D1Database, key: string, now: number): Promise<boolean> {
  return (
    (
      await run(db, 'UPDATE idp_groups SET deleted_at = ? WHERE key = ? AND deleted_at IS NULL', [
        now,
        key,
      ])
    ).changes > 0
  );
}

/**
 * Records that a create is about to be sent. True when an earlier attempt left its intent (the group may already
 * exist in Polaris ID), false when this one is the first.
 */
export async function noteGroupIntent(
  db: D1Database,
  key: string,
  friendlyName: string,
  now: number,
): Promise<boolean> {
  return (
    (
      await run(
        db,
        'INSERT OR IGNORE INTO idp_group_intents (key, friendly_name, created_at) VALUES (?, ?, ?)',
        [key, friendlyName, now],
      )
    ).changes === 0
  );
}

export const clearGroupIntentStmt = (db: D1Database, key: string) =>
  stmt(db, 'DELETE FROM idp_group_intents WHERE key = ?', [key]);
