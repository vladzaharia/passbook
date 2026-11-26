import { first } from '../../platform/db.ts';
import { creatorLiveSql, type Fragment, keyLive } from '../../platform/repo-api-key-sql.ts';

/** The creator of a key whose creator is still the admin who made it (the gate's own test), or null. */
export const activeCreatorOfKey = (db: D1Database, keyId: string) =>
  first<{ created_by: string }>(
    db,
    `SELECT k.created_by FROM api_keys k WHERE k.id = ? AND ${creatorLiveSql('k')}`,
    [keyId],
  );

/** The invitation row `alias` was not made by a key, or its creating key is live at `now` (the gate's own `keyLive`). */
export function madeByLiveKey(alias: string, now: number): Fragment {
  const live = keyLive('k', now);
  return {
    sql: `(${alias}.created_by_key IS NULL OR EXISTS (SELECT 1 FROM api_keys k
      WHERE k.id = ${alias}.created_by_key AND ${live.sql}))`,
    params: live.params,
  };
}
