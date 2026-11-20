import type { WalletOperationRef } from './instance-types.ts';
import { walletOpCurrentSql, walletOpReadCurrentSql } from './repo-instance-current.ts';
import { pinnedKeysetSql } from './repo-keyset-pin.ts';

export interface Claim extends WalletOperationRef {
  hash: string;
  now: number;
}
/** Read form: the instance row is named by id and tenant, the operation by the pinned keyset. */
export const SCOPE = `i.id = op.instance_id AND i.id = ? AND i.org_id = ? AND i.mode = ? AND i.provider = ?
  AND i.credential_keyset_commitment = op.credential_keyset_commitment
  AND op.credential_keyset_commitment = ${pinnedKeysetSql}`;
export const scope = (p: WalletOperationRef) =>
  [p.instanceId, p.orgId, p.mode, p.provider] as const;
export const CURRENT = walletOpReadCurrentSql('i', 'op');
/** Grant-part form of SCOPE: the tenant is the grant's ({org}, {mode}); two parameters, see `partScope`. */
export const PART_SCOPE = `i.id = op.instance_id AND i.id = ? AND i.org_id = {org} AND i.mode = {mode} AND i.provider = ?
  AND i.credential_keyset_commitment = op.credential_keyset_commitment
  AND op.credential_keyset_commitment = ${pinnedKeysetSql}`;
export const partScope = (p: WalletOperationRef) => [p.instanceId, p.provider] as const;
/** The tenant-free epoch rule, as a value inside a grant part. */
export const PART_CURRENT = walletOpCurrentSql('i', 'op');
// Keep the scoped candidate and its epoch proof in separate SELECTs. Joining
// the materialized result once prevents SQLite expanding the proof in every CASE.
// The unique (instance_id, version) key and primary-key joins yield at most one row.
// Parameters: instanceId, version, then partScope.
export const PART_CURRENT_OPERATION = `scoped_operation AS MATERIALIZED (
    SELECT op.id FROM wallet_provider_instance_operations op
    JOIN wallet_provider_instances i ON i.id = op.instance_id
    WHERE op.instance_id = ? AND op.version = ? AND ${PART_SCOPE}
  ), current_operation AS MATERIALIZED (
    SELECT op.id, CASE WHEN ${PART_CURRENT} THEN 1 ELSE 0 END AS is_current
    FROM scoped_operation scoped
    JOIN wallet_provider_instance_operations op ON op.id = scoped.id
    JOIN wallet_provider_instances i ON i.id = op.instance_id
  )`;
export const RETRY_DELAY = `MIN(300000, MAX(1000 * (1 << MIN(op.attempts - 1, 8)), ?))`;
