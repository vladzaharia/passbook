import type { GoogleType } from '../../../passkit/wallets/google/types.ts';
import { first, run } from '../../platform/db.ts';

export interface GoogleClassWrite {
  releaseId: string;
  releaseGeneration: number;
}

export function getGoogleClassWrite(
  db: D1Database,
  classIdHash: string,
): Promise<GoogleClassWrite | null> {
  return first(
    db,
    `SELECT release_id AS releaseId, release_generation AS releaseGeneration
    FROM wallet_google_classes WHERE class_id_hash = ?`,
    [classIdHash],
  );
}

/** Records the release that wrote the class; a later write by a newer release replaces it. */
export async function putGoogleClassWrite(
  db: D1Database,
  input: GoogleClassWrite & { classIdHash: string; now: number },
): Promise<void> {
  await run(
    db,
    `INSERT INTO wallet_google_classes (class_id_hash, release_id, release_generation, written_at)
    VALUES (?, ?, ?, ?) ON CONFLICT (class_id_hash) DO UPDATE SET
      release_id = excluded.release_id, release_generation = excluded.release_generation,
      written_at = excluded.written_at
    WHERE excluded.release_generation > wallet_google_classes.release_generation`,
    [input.classIdHash, input.releaseId, input.releaseGeneration, input.now],
  );
}

/** What an instance's binding recorded about its class, for a revoke and for refusing a changed class key. */
export async function getGoogleBindingClass(
  db: D1Database,
  instanceId: string,
): Promise<
  ({ classIdHash: string } & { classType: GoogleType | null; classKey: string | null }) | null
> {
  return first(
    db,
    `SELECT class_id_hash AS classIdHash, class_type AS classType, class_key AS classKey
    FROM wallet_google_callback_bindings WHERE instance_id = ?`,
    [instanceId],
  );
}

/** Whether an upsert of the instance ever succeeded, so an object Google no longer has is unexpected. */
export async function hadSucceededUpsert(db: D1Database, instanceId: string): Promise<boolean> {
  return (
    (await first(
      db,
      `SELECT 1 FROM wallet_provider_instance_operations
      WHERE instance_id = ? AND kind = 'upsert' AND state = 'succeeded' LIMIT 1`,
      [instanceId],
    )) !== null
  );
}
