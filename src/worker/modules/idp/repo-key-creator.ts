import { first } from '../../platform/db.ts';

/** The active user who minted a key, or null. */
export const activeCreatorOfKey = (db: D1Database, keyId: string) =>
  first<{ created_by: string }>(
    db,
    `SELECT k.created_by FROM api_keys k JOIN users u ON u.id = k.created_by AND u.status = 'active'
     WHERE k.id = ?`,
    [keyId],
  );
