import { stmt } from '../../platform/db.ts';

type Db = D1Database;

export const orgNameStmt = (db: Db, orgId: string) =>
  stmt(db, 'SELECT name FROM orgs WHERE id = ?', [orgId]);

export const staffListStmt = (db: Db, orgId: string) =>
  stmt(
    db,
    `SELECT id, name, role FROM scan_staff
     WHERE org_id = ? AND disabled_at IS NULL ORDER BY name COLLATE NOCASE LIMIT 200`,
    [orgId],
  );

export const userNameStmt = (db: Db, userId: string) =>
  stmt(db, 'SELECT name, primary_email FROM users WHERE id = ?', [userId]);
