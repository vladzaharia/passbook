import { all, chunk, first, placeholders, run } from '../../platform/db.ts';

/** The SCIM mirror: opaque ids and flags only. A name or an address from the feed never reaches these tables. */
export interface DirectoryUser {
  scim_id: string;
  subject: string;
  active: 0 | 1;
  last_modified: number;
  deleted_at: number | null;
  /** A revocation that could not be carried out yet: the sweep ends the sessions while the user is still off. */
  revoke_pending: 0 | 1;
  /** When the receiver last ended this subject's sessions. */
  revoked_at: number | null;
}

export interface DirectoryGroup {
  scim_id: string;
  group_id: string;
  /** JSON array of SCIM user ids. */
  members: string;
  last_modified: number;
  deleted_at: number | null;
}

const USER = 'scim_id, subject, active, last_modified, deleted_at, revoke_pending, revoked_at';
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
     ON CONFLICT (subject) DO UPDATE SET active = excluded.active, last_modified = excluded.last_modified, deleted_at = NULL,
       revoke_pending = CASE WHEN excluded.active = 1 THEN 0 ELSE revoke_pending END
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
  // Switching a user back on settles any revocation still owed.
  const sql = active
    ? 'UPDATE idp_directory_users SET active = 1, revoke_pending = 0, last_modified = ? WHERE scim_id = ? AND deleted_at IS NULL'
    : 'UPDATE idp_directory_users SET active = 0, last_modified = ? WHERE scim_id = ? AND deleted_at IS NULL';
  return (await run(db, sql, [now, scimId])).changes > 0;
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

/** Records what became of a revocation: `pending` leaves it for the sweep; `revokedAt` starts the per-subject hour. */
export async function setRevocation(
  db: D1Database,
  scimId: string,
  r: { pending: boolean; revokedAt: number | null },
): Promise<void> {
  const pending = r.pending ? 1 : 0;
  if (r.revokedAt === null)
    await run(db, 'UPDATE idp_directory_users SET revoke_pending = ? WHERE scim_id = ?', [
      pending,
      scimId,
    ]);
  else
    await run(
      db,
      'UPDATE idp_directory_users SET revoke_pending = ?, revoked_at = ? WHERE scim_id = ?',
      [pending, r.revokedAt, scimId],
    );
}

/** Users off in Polaris ID whose revocation is still owed, oldest first. */
export const pendingRevocations = (db: D1Database, limit: number) =>
  all<DirectoryUser>(
    db,
    `SELECT ${USER} FROM idp_directory_users
     WHERE revoke_pending = 1 AND (active = 0 OR deleted_at IS NOT NULL) ORDER BY last_modified LIMIT ?`,
    [limit],
  );

/** True while a latched breaker is open: one counter row, opened at `window_start`, good for `ttl`. */
export async function breakerOpen(
  db: D1Database,
  key: string,
  now: number,
  ttl: number,
): Promise<boolean> {
  return (
    (await first(db, 'SELECT 1 AS open FROM counters WHERE key = ? AND window_start > ? LIMIT 1', [
      key,
      now - ttl,
    ])) !== null
  );
}

/**
 * Marks subjects for the next drain without touching the backoff of ones that are failing: the version moves, so
 * the mark is not lost, and `attempts` and `next_at` stay.
 */
export async function markManyQueued(db: D1Database, subjects: readonly string[]): Promise<void> {
  for (const part of chunk(subjects, 40))
    await run(
      db,
      `INSERT INTO idp_dirty (subject) VALUES ${part.map(() => '(?)').join(',')}
       ON CONFLICT (subject) DO UPDATE SET version = version + 1`,
      part,
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
