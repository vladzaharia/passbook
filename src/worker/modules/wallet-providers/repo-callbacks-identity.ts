import type { Mode } from '../../../shared/contracts/common.ts';
import { first } from '../../platform/db.ts';

export interface InstancePass {
  orgId: string;
  passId: string;
  mode: Mode;
}

/** The pass an instance belongs to; fixed for the instance's life, so read before its batch. */
export async function instancePass(
  db: D1Database,
  instanceId: string,
): Promise<InstancePass | null> {
  const row = await first<{ org_id: string; pass_id: string; mode: Mode }>(
    db,
    'SELECT org_id, pass_id, mode FROM wallet_provider_instances WHERE id = ?',
    [instanceId],
  );
  return row ? { orgId: row.org_id, passId: row.pass_id, mode: row.mode } : null;
}
