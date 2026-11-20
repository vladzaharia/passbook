import { all, first } from '../../platform/db.ts';
import type { WalletOperationRef } from './instance-types.ts';
import {
  retirementProjectionSql,
  samsungRetirementProjectionSql,
  samsungTombstoneBindingSql,
  walletNoProviderArtifactsSql,
} from './repo-instance-retirement-sql.ts';
import { pinnedKeysetSql } from './repo-keyset-pin.ts';

export {
  requestRetirement,
  retireUnissuedPlaceholder,
  walletRetirementIntentStatements,
} from './repo-instance-retirement-staging.ts';
export { walletNoProviderArtifactsSql };

/**
 * Set once by the wallet_provider_instances_settle trigger (0148) when the retirement evidence holds.
 * An issued Google object cannot retire until an independent replay guarantee exists, so it stays NULL.
 */
export function walletRetiredInstanceSettledSql(instanceAlias: string): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(instanceAlias)) throw new Error('Invalid trusted SQL alias');
  return `${instanceAlias}.retirement_settled_at IS NOT NULL`;
}

export async function retireInstance(
  db: D1Database,
  p: WalletOperationRef & { now: number },
): Promise<boolean> {
  const row = await first(
    db,
    `UPDATE wallet_provider_instances AS i SET lifecycle = 'retired', retired_at = ?, updated_at = ?
    WHERE i.id = ? AND i.org_id = ? AND i.mode = ? AND i.provider = ? AND i.desired_version = ?
      AND i.provider = 'samsung' AND i.lifecycle = 'revoked' AND i.retirement_requested_at IS NOT NULL
      AND i.credential_keyset_commitment = ${pinnedKeysetSql}
      AND ${samsungRetirementProjectionSql('i')}
      AND EXISTS (SELECT 1 FROM wallet_provider_instance_operations op
        WHERE op.id = i.desired_operation_id AND op.instance_id = i.id AND op.version = i.desired_version
          AND op.kind = 'revoke' AND op.state = 'succeeded' AND op.credential_keyset_commitment = ${pinnedKeysetSql})
      AND NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations busy
        WHERE busy.instance_id = i.id AND busy.state IN ('pending', 'retry', 'claimed', 'uncertain'))
      AND NOT EXISTS (SELECT 1 FROM wallet_samsung_fetch_refs r WHERE r.instance_id = i.id
        AND NOT EXISTS (SELECT 1 FROM wallet_samsung_tombstones t
          WHERE ${samsungTombstoneBindingSql('i', 'r', 't')}))
    RETURNING id`,
    [p.now, p.now, p.instanceId, p.orgId, p.mode, p.provider, p.version],
  );
  return row !== null;
}

/** Fence idempotent retirement acknowledgements, including the no-reference case. */
export async function retirementReconciled(
  db: D1Database,
  p: WalletOperationRef,
): Promise<boolean> {
  return (
    (await first(
      db,
      `SELECT 1 FROM wallet_provider_instances i
    JOIN wallet_provider_instance_operations op ON op.id = i.desired_operation_id
      AND op.instance_id = i.id AND op.version = i.desired_version
    WHERE i.id = ? AND i.org_id = ? AND i.mode = ? AND i.provider = ? AND i.desired_version = ?
      AND i.provider = 'samsung' AND i.lifecycle IN ('revoked', 'retired')
      AND op.kind = 'revoke' AND op.state = 'succeeded'
      AND i.credential_keyset_commitment = ${pinnedKeysetSql} AND op.credential_keyset_commitment = ${pinnedKeysetSql}
      AND ${samsungRetirementProjectionSql('i')}
      AND NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations busy
        WHERE busy.instance_id = i.id AND busy.state IN ('pending', 'retry', 'claimed', 'uncertain'))
      AND NOT EXISTS (SELECT 1 FROM wallet_samsung_fetch_refs r WHERE r.instance_id = i.id
        AND NOT EXISTS (SELECT 1 FROM wallet_samsung_tombstones t
          WHERE ${samsungTombstoneBindingSql('i', 'r', 't')}))`,
      [p.instanceId, p.orgId, p.mode, p.provider, p.version],
    )) !== null
  );
}

interface WalletRetirementReady extends WalletOperationRef {
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
): Promise<WalletRetirementReady[]> {
  return all(
    db,
    `SELECT i.id AS instanceId, i.pass_id AS passId, i.org_id AS orgId, i.mode, i.provider,
      i.account_id AS accountId, i.identity_projection_release_id AS identityProjectionReleaseId,
      i.desired_version AS version, i.retirement_requested_at AS retirementRequestedAt
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
      AND i.credential_keyset_commitment = ${pinnedKeysetSql} AND op.credential_keyset_commitment = ${pinnedKeysetSql}
      AND ${retirementProjectionSql('i')}
      AND (i.provider != 'samsung' OR ${samsungRetirementProjectionSql('i')})
      ${afterId === null ? '' : 'AND i.id > ?'} ORDER BY i.id LIMIT ?`,
    [now, ...(afterId === null ? [] : [afterId]), limit],
  );
}

export async function deferRetirement(
  db: D1Database,
  p: WalletOperationRef & { nextAttemptAt: number },
): Promise<boolean> {
  const row = await first(
    db,
    `UPDATE wallet_provider_instances SET retirement_next_attempt_at = ?
    WHERE id = ? AND org_id = ? AND mode = ? AND provider = ? AND desired_version = ?
      AND lifecycle = 'revoked' AND (retirement_requested_at IS NOT NULL OR provider = 'samsung')
      AND credential_keyset_commitment = ${pinnedKeysetSql}
      AND ${retirementProjectionSql('wallet_provider_instances')}
      AND (provider != 'samsung' OR ${samsungRetirementProjectionSql('wallet_provider_instances')})
      AND EXISTS (SELECT 1 FROM wallet_provider_instance_operations op
        WHERE op.id = wallet_provider_instances.desired_operation_id AND op.version = wallet_provider_instances.desired_version
          AND op.credential_keyset_commitment = ${pinnedKeysetSql})
    RETURNING id`,
    [p.nextAttemptAt, p.instanceId, p.orgId, p.mode, p.provider, p.version],
  );
  return row !== null;
}
