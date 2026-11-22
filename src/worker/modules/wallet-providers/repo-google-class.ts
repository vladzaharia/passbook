import type { GoogleType } from '../../../passkit/wallets/google/types.ts';
import { first } from '../../platform/db.ts';

export interface GoogleClassWrite {
  releaseId: string;
  releaseGeneration: number;
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
