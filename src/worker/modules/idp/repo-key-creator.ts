import { first } from '../../platform/db.ts';
import { creatorLiveSql } from '../../platform/repo-api-key-sql.ts';

/** The creator of a key whose creator is still the admin who made it (the gate's own test), or null. */
export const activeCreatorOfKey = (db: D1Database, keyId: string) =>
  first<{ created_by: string }>(
    db,
    `SELECT k.created_by FROM api_keys k WHERE k.id = ? AND ${creatorLiveSql('k')}`,
    [keyId],
  );
