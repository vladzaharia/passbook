import { batch, first, stmt } from '../../platform/db.ts';
import { type SamsungOperationScope, samsungOperationKeysetSql } from './repo-callbacks.ts';
import { walletInstanceOperationCurrentSql } from './repo-instance-proof.ts';

export type SamsungRefRetirement = 'no_external_card' | 'needs_notification' | 'pending';

const current = walletInstanceOperationCurrentSql('i', 'op', 'clock.now', 'revoke');
const scopeSql = `i.id = ? AND i.org_id = ? AND i.mode = ? AND i.provider = 'samsung'
  AND op.version = ? AND op.kind = 'revoke' AND ${current} AND ${samsungOperationKeysetSql}
  AND NOT EXISTS (SELECT 1 FROM wallet_samsung_fetch_refs stored_ref
    WHERE stored_ref.instance_id = i.id
      AND stored_ref.credential_keyset_commitment IS NOT i.credential_keyset_commitment)`;
const joins = `FROM wallet_provider_instances i JOIN wallet_provider_instance_operations op
  ON op.id = i.desired_operation_id AND op.instance_id = i.id AND op.version = i.desired_version
  LEFT JOIN wallet_samsung_fetch_refs ref ON ref.instance_id = i.id AND ref.retired_at IS NULL
  CROSS JOIN (SELECT ? AS now) clock`;
const disposition = `CASE WHEN ref.id IS NULL THEN 'no_external_card'
  WHEN ref.promoted_at IS NOT NULL THEN 'needs_notification'
  WHEN ref.initial_expires_at <= ? THEN 'no_external_card' ELSE 'pending' END AS disposition`;

/** This is a preflight only. An unpromoted ref still requires the claimed atomic retirement. */
export async function inspectSamsungRetirement(
  db: D1Database,
  scope: SamsungOperationScope,
  now: number,
): Promise<SamsungRefRetirement> {
  const row = await first<{ disposition: SamsungRefRetirement }>(
    db,
    `SELECT ${disposition} ${joins} WHERE ${scopeSql}`,
    [
      now,
      now,
      scope.instanceId,
      scope.orgId,
      scope.mode,
      scope.operationVersion,
      scope.credentialKeysetCommitment,
      scope.credentialKeysetCommitment,
    ],
  );
  return row?.disposition ?? 'pending';
}

/** An expired ref can be closed only while holding the exact current revoke lease. */
export async function retireSamsungUnpromotedRef(
  db: D1Database,
  scope: SamsungOperationScope,
  now: number,
  claimHash: string,
): Promise<SamsungRefRetirement> {
  const values = [
    scope.instanceId,
    scope.orgId,
    scope.mode,
    scope.operationVersion,
    scope.credentialKeysetCommitment,
    scope.credentialKeysetCommitment,
  ] as const;
  const results = await batch(db, [
    stmt(
      db,
      `UPDATE wallet_samsung_fetch_refs AS ref SET retired_at = ?
      WHERE ref.instance_id = ? AND ref.retired_at IS NULL AND ref.promoted_at IS NULL
        AND ref.initial_expires_at <= ? AND EXISTS (
          SELECT 1 FROM wallet_provider_instances i JOIN wallet_provider_instance_operations op
            ON op.id = i.desired_operation_id AND op.instance_id = i.id AND op.version = i.desired_version
          CROSS JOIN (SELECT ? AS now) clock
          WHERE i.id = ref.instance_id AND ${scopeSql} AND op.state = 'claimed'
            AND op.claim_hash = ? AND op.claim_expires_at > ?)`,
      [now, scope.instanceId, now, now, ...values, claimHash, now],
    ),
    stmt(
      db,
      `SELECT ${disposition} ${joins} WHERE ${scopeSql}
      AND op.state = 'claimed' AND op.claim_hash = ? AND op.claim_expires_at > ?`,
      [now, now, ...values, claimHash, now],
    ),
  ]);
  const row = results[1]?.results[0] as { disposition: SamsungRefRetirement } | undefined;
  return row?.disposition ?? 'pending';
}
