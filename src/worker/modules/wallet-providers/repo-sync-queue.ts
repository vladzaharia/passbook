import { first } from '../../platform/db.ts';
import type { WalletOperationRef, WalletScope } from './instance-types.ts';
import { walletInstanceOperationCurrentSql } from './repo-instance-proof.ts';
import { walletNoProviderArtifactsSql } from './repo-instance-retirement.ts';
import { pinnedKeysetSql } from './repo-keyset-pin.ts';

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
  db: D1Database,
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
  const row = await first(
    db,
    `UPDATE wallet_provider_instance_operations AS op SET next_attempt_at = ?
    WHERE op.instance_id = ? AND op.version = ? AND op.state IN ('pending', 'retry')
      AND EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE i.id = op.instance_id
        AND i.org_id = ? AND i.mode = ? AND i.provider = ? AND ${walletInstanceOperationCurrentSql('i', 'op', '?')}
        AND i.credential_keyset_commitment = ${pinnedKeysetSql} AND op.credential_keyset_commitment = ${pinnedKeysetSql})
    RETURNING id`,
    [now + delayMs, op.instanceId, op.version, op.orgId, op.mode, op.provider, now],
  );
  return row !== null;
}
