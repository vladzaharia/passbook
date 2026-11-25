import { all, chunk, first, placeholders, run } from '../../platform/db.ts';

/** The SCIM mirror: opaque ids and flags only. A name or an address from the feed never reaches these tables. */
export interface DirectoryUser {
  scim_id: string;
  subject: string;
  active: 0 | 1;
  last_modified: number;
  deleted_at: number | null;
}

export interface DirectoryGroup {
  scim_id: string;
  group_id: string;
  /** JSON array of SCIM user ids. */
  members: string;
  last_modified: number;
  deleted_at: number | null;
}

const USER = 'scim_id, subject, active, last_modified, deleted_at';
const GROUP = 'scim_id, group_id, members, last_modified, deleted_at';

export const userById = (db: D1Database, scimId: string) =>
  first<DirectoryUser>(db, `SELECT ${USER} FROM idp_directory_users WHERE scim_id = ?`, [scimId]);

export const userBySubject = (db: D1Database, subject: string) =>
  first<DirectoryUser>(db, `SELECT ${USER} FROM idp_directory_users WHERE subject = ?`, [subject]);

/** Creates the user, or brings a known subject (even a deleted one) back under its own id. */
export async function upsertUser(
  db: D1Database,
  u: { scimId: string; subject: string; active: boolean; now: number },
): Promise<DirectoryUser | null> {
  return first<DirectoryUser>(
    db,
    `INSERT INTO idp_directory_users (scim_id, subject, active, last_modified) VALUES (?, ?, ?, ?)
     ON CONFLICT (subject) DO UPDATE SET active = excluded.active, last_modified = excluded.last_modified, deleted_at = NULL
     RETURNING ${USER}`,
    [u.scimId, u.subject, u.active ? 1 : 0, u.now],
  );
}

export async function setUserActive(
  db: D1Database,
  scimId: string,
  active: boolean,
  now: number,
): Promise<boolean> {
  return (
    (
      await run(
        db,
        'UPDATE idp_directory_users SET active = ?, last_modified = ? WHERE scim_id = ? AND deleted_at IS NULL',
        [active ? 1 : 0, now, scimId],
      )
    ).changes > 0
  );
}

/** Keeps the row as a tombstone so a repeat DELETE answers the same and a later POST finds its id. */
export async function deleteUser(db: D1Database, scimId: string, now: number): Promise<boolean> {
  return (
    (
      await run(
        db,
        'UPDATE idp_directory_users SET deleted_at = ?, last_modified = ? WHERE scim_id = ? AND deleted_at IS NULL',
        [now, now, scimId],
      )
    ).changes > 0
  );
}

export const listUsers = (db: D1Database, offset: number, limit: number) =>
  all<DirectoryUser>(
    db,
    `SELECT ${USER} FROM idp_directory_users WHERE deleted_at IS NULL ORDER BY scim_id LIMIT ? OFFSET ?`,
    [limit, offset],
  );

export const countUsers = async (db: D1Database): Promise<number> =>
  (
    await first<{ n: number }>(
      db,
      'SELECT count(*) AS n FROM idp_directory_users WHERE deleted_at IS NULL',
    )
  )?.n ?? 0;

/** The subjects behind SCIM user ids, in chunks. An id nobody pushed is absent. */
export async function subjectsOfScimIds(
  db: D1Database,
  scimIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const part of chunk(scimIds))
    for (const r of await all<{ scim_id: string; subject: string }>(
      db,
      `SELECT scim_id, subject FROM idp_directory_users WHERE scim_id IN (${placeholders(part.length)})`,
      part,
    ))
      out.set(r.scim_id, r.subject);
  return out;
}

export const groupById = (db: D1Database, scimId: string) =>
  first<DirectoryGroup>(db, `SELECT ${GROUP} FROM idp_directory_groups WHERE scim_id = ?`, [
    scimId,
  ]);

export const groupByGroupId = (db: D1Database, groupId: string) =>
  first<DirectoryGroup>(db, `SELECT ${GROUP} FROM idp_directory_groups WHERE group_id = ?`, [
    groupId,
  ]);

export async function upsertGroup(
  db: D1Database,
  g: { scimId: string; groupId: string; members: readonly string[]; now: number },
): Promise<DirectoryGroup | null> {
  return first<DirectoryGroup>(
    db,
    `INSERT INTO idp_directory_groups (scim_id, group_id, members, last_modified) VALUES (?, ?, ?, ?)
     ON CONFLICT (group_id) DO UPDATE SET members = excluded.members, last_modified = excluded.last_modified, deleted_at = NULL
     RETURNING ${GROUP}`,
    [g.scimId, g.groupId, JSON.stringify(g.members), g.now],
  );
}

export async function setGroupMembers(
  db: D1Database,
  scimId: string,
  members: readonly string[],
  now: number,
): Promise<boolean> {
  return (
    (
      await run(
        db,
        'UPDATE idp_directory_groups SET members = ?, last_modified = ? WHERE scim_id = ? AND deleted_at IS NULL',
        [JSON.stringify(members), now, scimId],
      )
    ).changes > 0
  );
}

export async function deleteGroup(db: D1Database, scimId: string, now: number): Promise<boolean> {
  return (
    (
      await run(
        db,
        'UPDATE idp_directory_groups SET deleted_at = ?, last_modified = ? WHERE scim_id = ? AND deleted_at IS NULL',
        [now, now, scimId],
      )
    ).changes > 0
  );
}

export const listGroups = (db: D1Database, offset: number, limit: number) =>
  all<DirectoryGroup>(
    db,
    `SELECT ${GROUP} FROM idp_directory_groups WHERE deleted_at IS NULL ORDER BY scim_id LIMIT ? OFFSET ?`,
    [limit, offset],
  );

export const countGroups = async (db: D1Database): Promise<number> =>
  (
    await first<{ n: number }>(
      db,
      'SELECT count(*) AS n FROM idp_directory_groups WHERE deleted_at IS NULL',
    )
  )?.n ?? 0;

/** Members of a stored group: the column is ours, valid JSON by its CHECK, and always an array of SCIM user ids. */
export const membersOf = (group: Pick<DirectoryGroup, 'members'>): string[] =>
  JSON.parse(group.members) as string[];
