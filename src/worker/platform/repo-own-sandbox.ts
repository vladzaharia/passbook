import { first } from './db.ts';

/** The org id of the person's open sandbox, or null. */
export async function ownSandboxOrgId(db: D1Database, userId: string): Promise<string | null> {
  const row = await first<{ org_id: string }>(
    db,
    'SELECT org_id FROM developer_sandboxes WHERE user_id = ?1 AND closed_at IS NULL',
    [userId],
  );
  return row?.org_id ?? null;
}
