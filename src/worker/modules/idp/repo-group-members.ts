import { all, first, run, stmt } from '../../platform/db.ts';

export interface GroupMemberRow {
  id: string;
  group_key: string;
  subject: string;
  user_id: string | null;
  source: 'manual' | 'invitation';
  platform_invitation_id: string | null;
  added_by: string | null;
  created_at: number;
  removed_at: number | null;
  removed_by: string | null;
}

const COLUMNS = `id, group_key, subject, user_id, source, platform_invitation_id, added_by, created_at,
  removed_at, removed_by`;

export interface NewGroupMember {
  id: string;
  groupKey: string;
  subject: string;
  userId: string | null;
  /** The platform invitation that made the row; null for a manual member. */
  platformInvitationId: string | null;
  addedBy: string | null;
  now: number;
}

/** Manual unless a platform invitation made it. Needs a live group; a second live row for the pair is refused. */
export const insertMemberStmt = (db: D1Database, m: NewGroupMember) =>
  stmt(
    db,
    `INSERT INTO idp_group_members (id, group_key, subject, user_id, source, platform_invitation_id, added_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      m.id,
      m.groupKey,
      m.subject,
      m.userId,
      m.platformInvitationId ? 'invitation' : 'manual',
      m.platformInvitationId,
      m.addedBy,
      m.now,
    ],
  );

export async function insertMember(db: D1Database, m: NewGroupMember): Promise<void> {
  await insertMemberStmt(db, m).run();
}

export const removeMemberStmt = (db: D1Database, id: string, by: string | null, now: number) =>
  stmt(
    db,
    'UPDATE idp_group_members SET removed_at = ?, removed_by = ? WHERE id = ? AND removed_at IS NULL',
    [now, by, id],
  );

/** True when a live member was removed. `by` is null when the sweep or a group delete removes it. */
export async function removeMember(
  db: D1Database,
  id: string,
  by: string | null,
  now: number,
): Promise<boolean> {
  return (await removeMemberStmt(db, id, by, now).run()).meta.changes > 0;
}

export const memberById = (db: D1Database, id: string) =>
  first<GroupMemberRow>(db, `SELECT ${COLUMNS} FROM idp_group_members WHERE id = ?`, [id]);

export const liveMembersOfGroup = (db: D1Database, groupKey: string) =>
  all<GroupMemberRow>(
    db,
    `SELECT ${COLUMNS} FROM idp_group_members WHERE group_key = ? AND removed_at IS NULL ORDER BY created_at, id`,
    [groupKey],
  );

export const liveMembershipsOfSubject = (db: D1Database, subject: string) =>
  all<GroupMemberRow>(
    db,
    `SELECT ${COLUMNS} FROM idp_group_members WHERE subject = ? AND removed_at IS NULL ORDER BY group_key, id`,
    [subject],
  );

/** Removes every live member of a group (a delete), returning how many were removed. */
export async function removeMembersOfGroup(
  db: D1Database,
  groupKey: string,
  by: string | null,
  now: number,
): Promise<number> {
  return (
    await run(
      db,
      'UPDATE idp_group_members SET removed_at = ?, removed_by = ? WHERE group_key = ? AND removed_at IS NULL',
      [now, by, groupKey],
    )
  ).changes;
}
