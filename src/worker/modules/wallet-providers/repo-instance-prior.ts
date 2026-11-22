import { first } from '../../platform/db.ts';

/** The last operation of the instance that settled before `version`: what the provider was last told. */
export function priorSucceededOperation(
  db: D1Database,
  instanceId: string,
  version: number,
): Promise<{ kind: 'upsert' | 'revoke'; passVersion: number } | null> {
  return first(
    db,
    `SELECT kind, pass_version AS passVersion FROM wallet_provider_instance_operations
    WHERE instance_id = ? AND version < ? AND state = 'succeeded' ORDER BY version DESC LIMIT 1`,
    [instanceId, version],
  );
}
