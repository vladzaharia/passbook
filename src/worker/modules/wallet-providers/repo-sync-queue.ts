import { run } from '../../platform/db.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import type {
  WalletCredentialKeysetProof,
  WalletOperationRef,
  WalletScope,
} from './instance-types.ts';
import { isCredentialKeysetCommitment } from './instance-types.ts';
import { walletInstanceOperationCurrentSql } from './repo-instance-proof.ts';
import { walletNoProviderArtifactsSql } from './repo-instance-retirement.ts';

/** Ack only the same dirty generation while the current holder's placeholder is pristine. */
export async function ackCleanWalletPlaceholder(
  db: D1Database,
  p: WalletScope & WalletCredentialKeysetProof & { instanceId: string; generation: number },
): Promise<boolean> {
  if (!isCredentialKeysetCommitment(p.credentialKeysetCommitment)) return false;
  const result = await run(
    db,
    `DELETE FROM wallet_provider_instance_dirty AS d
    WHERE d.instance_id = ? AND d.generation = ?
      AND EXISTS (SELECT 1 FROM wallet_provider_instances i JOIN passes pass
        ON pass.id = i.pass_id AND pass.org_id = i.org_id AND pass.mode = i.mode
        AND pass.credential_generation = i.credential_generation
        WHERE i.id = d.instance_id AND i.org_id = ? AND i.mode = ? AND i.provider = ?
          AND i.lifecycle IN ('blocked', 'ready') AND i.retirement_requested_at IS NULL
          AND pass.deleted_at IS NULL AND pass.test_data_quarantined = 0
          AND i.credential_keyset_commitment = ? AND ${credentialRefKeysetSql}
          AND ${walletNoProviderArtifactsSql('i')})`,
    [
      p.instanceId,
      p.generation,
      p.orgId,
      p.mode,
      p.provider,
      p.credentialKeysetCommitment,
      p.credentialKeysetCommitment,
    ],
  );
  return result.changes === 1;
}

/** A missing Samsung region is not a provider attempt; rotate it without consuming retries. */
export async function deferWalletSyncOperation(
  db: D1Database,
  op: WalletOperationRef & WalletCredentialKeysetProof,
  now: number,
  delayMs: number,
): Promise<boolean> {
  if (
    !isCredentialKeysetCommitment(op.credentialKeysetCommitment) ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(delayMs) ||
    delayMs < 1 ||
    delayMs > 300_000
  )
    return false;
  const result = await run(
    db,
    `UPDATE wallet_provider_instance_operations AS op SET next_attempt_at = ?
    WHERE op.instance_id = ? AND op.version = ? AND op.state IN ('pending', 'retry')
      AND EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE i.id = op.instance_id
        AND i.org_id = ? AND i.mode = ? AND i.provider = ? AND ${walletInstanceOperationCurrentSql('i', 'op', '?')}
        AND i.credential_keyset_commitment = ? AND op.credential_keyset_commitment = ? AND ${credentialRefKeysetSql})`,
    [
      now + delayMs,
      op.instanceId,
      op.version,
      op.orgId,
      op.mode,
      op.provider,
      now,
      op.credentialKeysetCommitment,
      op.credentialKeysetCommitment,
      op.credentialKeysetCommitment,
    ],
  );
  return result.changes === 1;
}
