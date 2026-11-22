import { all } from '../../platform/db.ts';
import type { WalletMode } from './instance-types.ts';

/** Past the claim lease and the provider timeouts: whatever that attempt sent is no longer in flight. */
const UNCERTAIN_GRACE_MS = 600_000;

export interface UncertainGoogleOperation {
  instanceId: string;
  orgId: string;
  mode: WalletMode;
  version: number;
}

export function listUncertainGoogleOperations(
  db: D1Database,
  now: number,
  limit: number,
): Promise<UncertainGoogleOperation[]> {
  return all<UncertainGoogleOperation>(
    db,
    `SELECT i.id AS instanceId, i.org_id AS orgId, i.mode, op.version
    FROM wallet_provider_instance_operations op JOIN wallet_provider_instances i ON i.id = op.instance_id
    WHERE op.state = 'uncertain' AND i.provider = 'google' AND op.last_attempt_at <= ?
    ORDER BY op.last_attempt_at, op.id LIMIT ?`,
    [now - UNCERTAIN_GRACE_MS, limit],
  );
}
