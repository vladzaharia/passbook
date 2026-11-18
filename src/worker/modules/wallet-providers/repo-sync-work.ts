import { first } from '../../platform/db.ts';

/**
 * Coarse probe: is anything queued that the sync drain could pick up? It ignores the keyset pin on
 * purpose, so an installation with no wallet rows never needs the keyset. A false positive only
 * means the drain then requires the keyset.
 */
export async function walletSyncHasWork(db: D1Database, now: number): Promise<boolean> {
  const row = await first(
    db,
    `SELECT 1 AS found WHERE
      EXISTS (SELECT 1 FROM wallet_provider_instance_dirty WHERE next_attempt_at <= ?)
      OR EXISTS (SELECT 1 FROM wallet_provider_instance_operations
        WHERE (state = 'claimed' AND claim_expires_at <= ?)
          OR (state IN ('pending', 'retry') AND attempts < 8
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)))
      OR EXISTS (SELECT 1 FROM wallet_provider_instances
        WHERE lifecycle = 'revoked' AND retirement_next_attempt_at <= ?)`,
    [now, now, now, now],
  );
  return row !== null;
}
