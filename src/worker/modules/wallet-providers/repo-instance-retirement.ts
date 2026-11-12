import { all, first, run } from '../../platform/db.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import type { WalletCredentialKeysetProof, WalletOperationRef } from './instance-types.ts';
import { isCredentialKeysetCommitment } from './instance-types.ts';
import {
  retirementProjectionSql,
  samsungRetirementProjectionSql,
  samsungTombstoneBindingSql,
  walletNoProviderArtifactsSql,
} from './repo-instance-retirement-sql.ts';

export {
  requestRetirement,
  retireUnissuedPlaceholder,
  walletRetirementIntentStatements,
} from './repo-instance-retirement-staging.ts';
export { walletNoProviderArtifactsSql };

export function walletUnissuedPlaceholderSql(instanceAlias: string): string {
  return `${instanceAlias}.lifecycle = 'retired' AND ${instanceAlias}.retirement_reason = 'not_issued'
    AND ${walletNoProviderArtifactsSql(instanceAlias)}`;
}

/** An issued Google object cannot retire until an independent replay guarantee exists. */
export function walletRetiredInstanceSettledSql(instanceAlias: string): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(instanceAlias)) throw new Error('Invalid trusted SQL alias');
  const i = instanceAlias;
  return `(EXISTS (SELECT 1 FROM credential_ref_keyset keyset WHERE keyset.id = 1
    AND keyset.commitment = ${i}.credential_keyset_commitment)
    AND ((${walletUnissuedPlaceholderSql(i)}) OR (${i}.lifecycle = 'retired' AND ${i}.provider = 'samsung'
    AND ${i}.retirement_reason IS NULL AND ${i}.retirement_requested_at IS NOT NULL AND ${i}.account_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM wallet_provider_accounts settled_account WHERE settled_account.id = ${i}.account_id
      AND settled_account.org_id = ${i}.org_id AND settled_account.mode = ${i}.mode AND settled_account.provider = ${i}.provider)
    AND ${samsungRetirementProjectionSql(i)}
    AND EXISTS (SELECT 1 FROM wallet_provider_instance_operations settled_revoke
      WHERE settled_revoke.id = ${i}.desired_operation_id AND settled_revoke.instance_id = ${i}.id
        AND settled_revoke.version = ${i}.desired_version AND settled_revoke.kind = 'revoke' AND settled_revoke.state = 'succeeded'
        AND settled_revoke.credential_keyset_commitment = ${i}.credential_keyset_commitment)
    AND NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations unsettled
      WHERE unsettled.instance_id = ${i}.id AND unsettled.state IN ('pending', 'retry', 'claimed', 'uncertain'))
    AND NOT EXISTS (SELECT 1 FROM wallet_samsung_fetch_refs settled_ref WHERE settled_ref.instance_id = ${i}.id
      AND NOT EXISTS (SELECT 1 FROM wallet_samsung_tombstones settled_tomb
        WHERE ${samsungTombstoneBindingSql(i, 'settled_ref', 'settled_tomb')})))))`;
}

export async function retireInstance(
  db: D1Database,
  p: WalletOperationRef & WalletCredentialKeysetProof & { now: number },
): Promise<boolean> {
  if (!isCredentialKeysetCommitment(p.credentialKeysetCommitment)) return false;
  const result = await run(
    db,
    `UPDATE wallet_provider_instances AS i SET lifecycle = 'retired', retired_at = ?, updated_at = ?
    WHERE i.id = ? AND i.org_id = ? AND i.mode = ? AND i.provider = ? AND i.desired_version = ?
      AND i.provider = 'samsung' AND i.lifecycle = 'revoked' AND i.retirement_requested_at IS NOT NULL
      AND i.credential_keyset_commitment = ? AND ${credentialRefKeysetSql}
      AND ${samsungRetirementProjectionSql('i')}
      AND EXISTS (SELECT 1 FROM wallet_provider_instance_operations op
        WHERE op.id = i.desired_operation_id AND op.instance_id = i.id AND op.version = i.desired_version
          AND op.kind = 'revoke' AND op.state = 'succeeded' AND op.credential_keyset_commitment = ?)
      AND NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations busy
        WHERE busy.instance_id = i.id AND busy.state IN ('pending', 'retry', 'claimed', 'uncertain'))
      AND NOT EXISTS (SELECT 1 FROM wallet_samsung_fetch_refs r WHERE r.instance_id = i.id
        AND NOT EXISTS (SELECT 1 FROM wallet_samsung_tombstones t
          WHERE ${samsungTombstoneBindingSql('i', 'r', 't')}))`,
    [
      p.now,
      p.now,
      p.instanceId,
      p.orgId,
      p.mode,
      p.provider,
      p.version,
      p.credentialKeysetCommitment,
      p.credentialKeysetCommitment,
      p.credentialKeysetCommitment,
    ],
  );
  return result.changes === 1;
}

/** Fence idempotent retirement acknowledgements, including the no-reference case. */
export async function retirementReconciled(
  db: D1Database,
  p: WalletOperationRef & WalletCredentialKeysetProof,
): Promise<boolean> {
  if (!isCredentialKeysetCommitment(p.credentialKeysetCommitment)) return false;
  return (
    (await first(
      db,
      `SELECT 1 FROM wallet_provider_instances i
    JOIN wallet_provider_instance_operations op ON op.id = i.desired_operation_id
      AND op.instance_id = i.id AND op.version = i.desired_version
    WHERE i.id = ? AND i.org_id = ? AND i.mode = ? AND i.provider = ? AND i.desired_version = ?
      AND i.provider = 'samsung' AND i.lifecycle IN ('revoked', 'retired')
      AND op.kind = 'revoke' AND op.state = 'succeeded'
      AND i.credential_keyset_commitment = ? AND op.credential_keyset_commitment = ? AND ${credentialRefKeysetSql}
      AND ${samsungRetirementProjectionSql('i')}
      AND NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations busy
        WHERE busy.instance_id = i.id AND busy.state IN ('pending', 'retry', 'claimed', 'uncertain'))
      AND NOT EXISTS (SELECT 1 FROM wallet_samsung_fetch_refs r WHERE r.instance_id = i.id
        AND NOT EXISTS (SELECT 1 FROM wallet_samsung_tombstones t
          WHERE ${samsungTombstoneBindingSql('i', 'r', 't')}))`,
      [
        p.instanceId,
        p.orgId,
        p.mode,
        p.provider,
        p.version,
        p.credentialKeysetCommitment,
        p.credentialKeysetCommitment,
        p.credentialKeysetCommitment,
      ],
    )) !== null
  );
}

interface WalletRetirementReady extends WalletOperationRef, WalletCredentialKeysetProof {
  passId: string;
  accountId: string;
  identityProjectionReleaseId: string;
  retirementRequestedAt: number | null;
}
export function listRetirementsReady(
  db: D1Database,
  now: number,
  limit: number,
  afterId: string | null,
  credentialKeysetCommitment: string,
): Promise<WalletRetirementReady[]> {
  if (!isCredentialKeysetCommitment(credentialKeysetCommitment)) return Promise.resolve([]);
  return all(
    db,
    `SELECT i.id AS instanceId, i.pass_id AS passId, i.org_id AS orgId, i.mode, i.provider,
      i.account_id AS accountId, i.identity_projection_release_id AS identityProjectionReleaseId,
      i.desired_version AS version, i.retirement_requested_at AS retirementRequestedAt,
      i.credential_keyset_commitment AS credentialKeysetCommitment
      FROM wallet_provider_instances i JOIN wallet_provider_instance_operations op ON op.id = i.desired_operation_id
    WHERE i.lifecycle = 'revoked' AND i.retirement_next_attempt_at <= ?
      AND (i.retirement_requested_at IS NOT NULL OR (i.provider = 'samsung' AND EXISTS (
        SELECT 1 FROM wallet_samsung_fetch_refs ref WHERE ref.instance_id = i.id AND NOT EXISTS (
          SELECT 1 FROM wallet_samsung_tombstones tomb WHERE tomb.ref_hash = ref.ref_hash
            AND ref.credential_keyset_commitment = i.credential_keyset_commitment
            AND tomb.credential_keyset_commitment = i.credential_keyset_commitment
            AND tomb.org_id = i.org_id AND tomb.mode = i.mode AND tomb.account_id = i.account_id
            AND EXISTS (SELECT 1 FROM template_releases identity_release
              JOIN template_candidates original ON original.id = identity_release.candidate_id
              WHERE identity_release.id = i.identity_projection_release_id
                AND tomb.account_revision = original.provider_account_revision
                AND tomb.provider_identity_hash = original.provider_identity_hash)))))
      AND op.instance_id = i.id AND op.version = i.desired_version AND op.kind = 'revoke' AND op.state = 'succeeded'
      AND i.credential_keyset_commitment = ? AND op.credential_keyset_commitment = ? AND ${credentialRefKeysetSql}
      AND ${retirementProjectionSql('i')}
      AND (i.provider != 'samsung' OR ${samsungRetirementProjectionSql('i')})
      AND (? IS NULL OR i.id > ?) ORDER BY i.id LIMIT ?`,
    [
      now,
      credentialKeysetCommitment,
      credentialKeysetCommitment,
      credentialKeysetCommitment,
      afterId,
      afterId,
      limit,
    ],
  );
}

export async function deferRetirement(
  db: D1Database,
  p: WalletOperationRef & WalletCredentialKeysetProof & { nextAttemptAt: number },
): Promise<boolean> {
  if (!isCredentialKeysetCommitment(p.credentialKeysetCommitment)) return false;
  const result = await run(
    db,
    `UPDATE wallet_provider_instances SET retirement_next_attempt_at = ?
    WHERE id = ? AND org_id = ? AND mode = ? AND provider = ? AND desired_version = ?
      AND lifecycle = 'revoked' AND (retirement_requested_at IS NOT NULL OR provider = 'samsung')
      AND credential_keyset_commitment = ? AND ${credentialRefKeysetSql}
      AND ${retirementProjectionSql('wallet_provider_instances')}
      AND (provider != 'samsung' OR ${samsungRetirementProjectionSql('wallet_provider_instances')})
      AND EXISTS (SELECT 1 FROM wallet_provider_instance_operations op
        WHERE op.id = wallet_provider_instances.desired_operation_id AND op.version = wallet_provider_instances.desired_version
          AND op.credential_keyset_commitment = ?)`,
    [
      p.nextAttemptAt,
      p.instanceId,
      p.orgId,
      p.mode,
      p.provider,
      p.version,
      p.credentialKeysetCommitment,
      p.credentialKeysetCommitment,
      p.credentialKeysetCommitment,
    ],
  );
  return result.changes === 1;
}
