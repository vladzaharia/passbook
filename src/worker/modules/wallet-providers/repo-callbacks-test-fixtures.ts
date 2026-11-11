import { batch, first, stmt } from '../../platform/db.ts';

export function findCallbackCredentialKeyset(db: D1Database) {
  return first(db, 'SELECT id FROM credential_ref_keyset WHERE id = 1');
}

export function findCallbackCredentialKeysetTrigger(db: D1Database, triggerName: string) {
  return first<{ sql: string }>(
    db,
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
    [triggerName],
  );
}

export function replaceCallbackCredentialKeysetBatch(
  db: D1Database,
  triggerName: string,
  commitment: string | null,
  existing: boolean,
  trigger: { sql: string },
) {
  return batch(db, [
    stmt(db, `DROP TRIGGER ${triggerName}`),
    commitment === null
      ? stmt(db, 'DELETE FROM credential_ref_keyset WHERE id = 1')
      : existing
        ? stmt(db, 'UPDATE credential_ref_keyset SET commitment = ? WHERE id = 1', [commitment])
        : stmt(db, 'INSERT INTO credential_ref_keyset (id, commitment) VALUES (1, ?)', [
            commitment,
          ]),
    stmt(db, trigger.sql),
  ]);
}
