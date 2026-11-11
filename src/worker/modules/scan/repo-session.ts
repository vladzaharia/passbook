import { likeEscape, stmt } from '../../platform/db.ts';

type Db = D1Database;

export const orgNameStmt = (db: Db, orgId: string) =>
  stmt(db, 'SELECT name FROM orgs WHERE id = ?', [orgId]);

/** The sign-in roster: bounded, so a large org never turns a session read into a full table scan. */
export const STAFF_ROSTER_LIMIT = 500;
const STAFF_SEARCH_LIMIT = 50;

/** One row past the limit tells the caller the roster was cut. */
export const staffListStmt = (db: Db, orgId: string) =>
  stmt(
    db,
    `SELECT id, name, role FROM scan_staff
     WHERE org_id = ? AND disabled_at IS NULL ORDER BY name COLLATE NOCASE, id LIMIT ?`,
    [orgId, STAFF_ROSTER_LIMIT + 1],
  );

/** People whose name contains `q`, for a roster that was cut. */
export const staffSearchStmt = (db: Db, orgId: string, q: string) =>
  stmt(
    db,
    `SELECT id, name, role FROM scan_staff
     WHERE org_id = ? AND disabled_at IS NULL AND name LIKE ? ESCAPE '\\'
     ORDER BY name COLLATE NOCASE, id LIMIT ?`,
    [orgId, `%${likeEscape(q)}%`, STAFF_SEARCH_LIMIT],
  );

export const userNameStmt = (db: Db, userId: string) =>
  stmt(db, 'SELECT name, primary_email FROM users WHERE id = ?', [userId]);
