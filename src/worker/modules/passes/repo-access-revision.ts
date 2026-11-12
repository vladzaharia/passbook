import { first } from '../../platform/db.ts';

export async function loadUserAccessRevision(db: D1Database, userId: string) {
  return (
    await first<{ r: number }>(db, 'SELECT access_revision AS r FROM users WHERE id = ?', [userId])
  )?.r;
}

export async function loadOrgAccessRevision(db: D1Database, orgId: string) {
  return (
    await first<{ r: number }>(db, 'SELECT access_revision AS r FROM orgs WHERE id = ?', [orgId])
  )?.r;
}
