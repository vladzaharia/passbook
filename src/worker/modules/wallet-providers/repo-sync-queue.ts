import { writePart } from '../../platform/authority-include.ts';
import { first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { WalletOperationRef, WalletScope } from './instance-types.ts';
import { PART_CURRENT, PART_SCOPE } from './repo-instance-claim-sql.ts';
import { revokeKindCheck, walletOpCurrentCheck } from './repo-instance-current.ts';
import { walletNoProviderArtifactsSql } from './repo-instance-retirement.ts';
import { pinnedKeysetSql } from './repo-keyset-pin.ts';
import { commitWalletGrant, walletQueueGrant } from './repo-queue-grant.ts';

/** Ack only the same dirty generation while the current holder's placeholder is pristine. */
export async function ackCleanWalletPlaceholder(
  db: D1Database,
  p: WalletScope & { instanceId: string; generation: number },
): Promise<boolean> {
  const row = await first(
    db,
    `DELETE FROM wallet_provider_instance_dirty AS d
    WHERE d.instance_id = ? AND d.generation = ?
      AND EXISTS (SELECT 1 FROM wallet_provider_instances i JOIN passes pass
        ON pass.id = i.pass_id AND pass.org_id = i.org_id AND pass.mode = i.mode
        AND pass.credential_generation = i.credential_generation
        WHERE i.id = d.instance_id AND i.org_id = ? AND i.mode = ? AND i.provider = ?
          AND i.lifecycle IN ('blocked', 'ready') AND i.retirement_requested_at IS NULL
          AND pass.deleted_at IS NULL AND pass.test_data_quarantined = 0
          AND i.credential_keyset_commitment = ${pinnedKeysetSql}
          AND ${walletNoProviderArtifactsSql('i')})
    RETURNING instance_id`,
    [p.instanceId, p.generation, p.orgId, p.mode, p.provider],
  );
  return row !== null;
}

/** A missing Samsung region is not a provider attempt; rotate it without consuming retries. */
export async function deferWalletSyncOperation(
  ctx: ServiceContext,
  op: WalletOperationRef,
  now: number,
  delayMs: number,
): Promise<boolean> {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(delayMs) ||
    delayMs < 1 ||
    delayMs > 300_000
  )
    return false;
  // A revoke defers under the revoke grant, which runs for a suspended or closed org: a refused defer would leave
  // it at the head of the queue and starve everything behind it.
  const stored = await first<{ kind: string }>(
    ctx.env.DB,
    'SELECT kind FROM wallet_provider_instance_operations WHERE instance_id = ? AND version = ?',
    [op.instanceId, op.version],
  );
  const revoke = stored?.kind === 'revoke';
  const g = walletQueueGrant(ctx, revoke ? 'revoke' : 'sync', op, [
    walletOpCurrentCheck(op.instanceId, op.version),
    ...(revoke ? [revokeKindCheck(op.instanceId, op.version)] : []),
  ]);
  g.include(
    writePart(
      `UPDATE wallet_provider_instance_operations AS op SET next_attempt_at = ?
    WHERE op.instance_id = ? AND op.version = ? AND op.state IN ('pending', 'retry')
      AND EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE ${PART_SCOPE} AND ${PART_CURRENT})
      AND {grant}
    RETURNING id`,
      [now + delayMs, op.instanceId, op.version, op.instanceId, op.provider],
    ),
  );
  const committed = await commitWalletGrant(g);
  if (!('results' in committed)) {
    ctx.log.warn('wallet.sync_defer_refused', {
      code: 'WALLET_SYNC_DEFER',
      reason: committed.refused,
    });
    return false;
  }
  return (committed.results[0]?.results.length ?? 0) === 1;
}
