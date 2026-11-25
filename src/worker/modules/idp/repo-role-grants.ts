import { all, first, run, stmt } from '../../platform/db.ts';

export type PlatformRole = 'developer' | 'support';

export interface PlatformGrantRow {
  id: string;
  user_id: string;
  role: PlatformRole;
  granted_by: string;
  created_at: number;
  revoked_at: number | null;
  revoked_by: string | null;
}

const COLUMNS = 'id, user_id, role, granted_by, created_at, revoked_at, revoked_by';

/** Live grants of a user: the platform reason for developer and support. */
export const activePlatformGrants = (db: D1Database, userId: string) =>
  all<PlatformGrantRow>(
    db,
    `SELECT ${COLUMNS} FROM platform_role_grants WHERE user_id = ? AND revoked_at IS NULL ORDER BY role`,
    [userId],
  );

export const liveGrantOf = (db: D1Database, userId: string, role: PlatformRole) =>
  first<PlatformGrantRow>(
    db,
    `SELECT ${COLUMNS} FROM platform_role_grants WHERE user_id = ? AND role = ? AND revoked_at IS NULL`,
    [userId, role],
  );

/** Every grant of a user, newest first: history for the Access card. */
export const grantHistory = (db: D1Database, userId: string) =>
  all<PlatformGrantRow>(
    db,
    `SELECT ${COLUMNS} FROM platform_role_grants WHERE user_id = ? ORDER BY created_at DESC, id`,
    [userId],
  );

export interface NewPlatformGrant {
  id: string;
  userId: string;
  role: PlatformRole;
  grantedBy: string;
  now: number;
}

/** A statement, so the service can batch it with its audit row. A second live grant is refused by its index. */
export const insertGrantStmt = (db: D1Database, g: NewPlatformGrant) =>
  stmt(
    db,
    'INSERT INTO platform_role_grants (id, user_id, role, granted_by, created_at) VALUES (?, ?, ?, ?, ?)',
    [g.id, g.userId, g.role, g.grantedBy, g.now],
  );

export const revokeGrantStmt = (
  db: D1Database,
  g: { userId: string; role: PlatformRole; by: string; now: number },
) =>
  stmt(
    db,
    `UPDATE platform_role_grants SET revoked_at = ?, revoked_by = ?
     WHERE user_id = ? AND role = ? AND revoked_at IS NULL`,
    [g.now, g.by, g.userId, g.role],
  );

export async function insertGrant(db: D1Database, g: NewPlatformGrant): Promise<void> {
  await insertGrantStmt(db, g).run();
}

/** True when a live grant ended. */
export async function revokeGrant(
  db: D1Database,
  g: { userId: string; role: PlatformRole; by: string; now: number },
): Promise<boolean> {
  return (await revokeGrantStmt(db, g).run()).meta.changes > 0;
}

/** Ends every live grant of a user (offboard), returning the roles that ended. */
export async function revokeAllGrants(
  db: D1Database,
  userId: string,
  by: string,
  now: number,
): Promise<PlatformRole[]> {
  const live = await activePlatformGrants(db, userId);
  if (live.length === 0) return [];
  await run(
    db,
    'UPDATE platform_role_grants SET revoked_at = ?, revoked_by = ? WHERE user_id = ? AND revoked_at IS NULL',
    [now, by, userId],
  );
  return live.map((g) => g.role);
}
