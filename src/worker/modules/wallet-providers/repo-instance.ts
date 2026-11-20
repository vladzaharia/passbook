import { all, first } from '../../platform/db.ts';
import type {
  WalletInstance,
  WalletOperation,
  WalletOperationRef,
  WalletScope,
} from './instance-types.ts';
import { walletOpReadCurrentSql } from './repo-instance-current.ts';
import { pinnedKeysetSql } from './repo-keyset-pin.ts';

export {
  insertDesiredOperation,
  insertInstance,
  offerStatement,
} from './repo-instance-mutations.ts';

const INSTANCE_COLUMNS = `i.id, i.pass_id AS passId, i.org_id AS orgId, i.mode, i.provider,
  i.account_id AS accountId, i.identity_projection_release_id AS identityProjectionReleaseId,
  i.credential_generation AS credentialGeneration, i.channel_epoch AS channelEpoch,
  i.retirement_cause AS retirementCause,
  i.lifecycle, i.desired_version AS desiredVersion, i.desired_operation_id AS desiredOperationId,
  i.installation_state AS installationState, i.installation_observed_at AS installationObservedAt,
  i.revoked_at AS revokedAt, i.retirement_requested_at AS retirementRequestedAt,
  i.retired_at AS retiredAt, i.created_at AS createdAt, i.updated_at AS updatedAt`;
const OPERATION_COLUMNS = `op.id, op.instance_id AS instanceId, i.pass_id AS passId, i.org_id AS orgId,
  i.mode, i.provider, i.account_id AS accountId, i.identity_projection_release_id AS identityProjectionReleaseId,
  i.credential_generation AS credentialGeneration, i.channel_epoch AS channelEpoch, op.version, op.kind, op.pass_version AS passVersion,
  op.pass_revision AS passRevision, op.lifecycle_generation AS lifecycleGeneration,
  op.pass_credential_generation AS passCredentialGeneration,
  op.issuing_release_id AS issuingReleaseId,
  op.projection_release_id AS projectionReleaseId, op.account_revision AS accountRevision,
  op.adapter_revision AS adapterRevision, op.policy_revision AS policyRevision, op.state, op.attempts,
  op.next_attempt_at AS nextAttemptAt, op.claim_expires_at AS claimExpiresAt, op.last_attempt_at AS lastAttemptAt,
  op.last_result_at AS lastResultAt, op.completed_at AS completedAt, op.reason_code AS reasonCode,
  op.http_status AS httpStatus, op.created_at AS createdAt`;
const scopeParams = (s: WalletScope) => [s.orgId, s.mode, s.provider] as const;

export function getInstanceByPass(
  db: D1Database,
  s: WalletScope & { passId: string },
): Promise<WalletInstance | null> {
  return first(
    db,
    `SELECT ${INSTANCE_COLUMNS} FROM wallet_provider_instances i
    JOIN passes p ON p.id = i.pass_id AND p.org_id = i.org_id AND p.mode = i.mode
      AND p.credential_generation = i.credential_generation
    WHERE i.org_id = ? AND i.mode = ? AND i.provider = ? AND i.pass_id = ?
      AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers transfer
        WHERE transfer.pass_id = i.pass_id AND transfer.state = 'pending')
    ORDER BY i.channel_epoch DESC LIMIT 1`,
    [...scopeParams(s), s.passId],
  );
}
export function getInstanceById(
  db: D1Database,
  s: WalletScope & { instanceId: string },
): Promise<WalletInstance | null> {
  return first(
    db,
    `SELECT ${INSTANCE_COLUMNS} FROM wallet_provider_instances i
    WHERE i.org_id = ? AND i.mode = ? AND i.provider = ? AND i.id = ?`,
    [...scopeParams(s), s.instanceId],
  );
}
export function getOperation(
  db: D1Database,
  s: WalletOperationRef,
): Promise<WalletOperation | null> {
  return first(
    db,
    `SELECT ${OPERATION_COLUMNS} FROM wallet_provider_instance_operations op
    JOIN wallet_provider_instances i ON i.id = op.instance_id
    WHERE i.org_id = ? AND i.mode = ? AND i.provider = ? AND i.id = ? AND op.version = ?
      AND op.credential_keyset_commitment = ${pinnedKeysetSql} AND i.credential_keyset_commitment = ${pinnedKeysetSql}`,
    [...scopeParams(s), s.instanceId, s.version],
  );
}
export function getOperationByRequest(
  db: D1Database,
  s: WalletScope & { instanceId: string; requestHash: string },
): Promise<WalletOperation | null> {
  return first(
    db,
    `SELECT ${OPERATION_COLUMNS} FROM wallet_provider_instance_operations op
    JOIN wallet_provider_instances i ON i.id = op.instance_id
    WHERE i.org_id = ? AND i.mode = ? AND i.provider = ? AND i.id = ? AND op.request_hash = ?
      AND op.credential_keyset_commitment = ${pinnedKeysetSql} AND i.credential_keyset_commitment = ${pinnedKeysetSql}`,
    [...scopeParams(s), s.instanceId, s.requestHash],
  );
}

export interface WalletPassSnapshot {
  passId: string;
  passRowVersion: number;
  orgId: string;
  mode: 'live' | 'test';
  templateId: string;
  templateVersion: string;
  passVersion: number;
  passRevision: number;
  lifecycleGeneration: number;
  credentialGeneration: number;
  issuingReleaseId: string | null;
  status: 'active' | 'voided';
  removedAt: number | null;
  deletedAt: number | null;
  quarantined: number;
  transferPending: number;
}
export function readPassSnapshot(
  db: D1Database,
  s: Pick<WalletScope, 'orgId' | 'mode'> & { passId: string },
): Promise<WalletPassSnapshot | null> {
  return first(
    db,
    `SELECT p.id AS passId, p.org_id AS orgId, p.mode, p.template_id AS templateId,
    p.template_version AS templateVersion, p.version AS passVersion, p.row_version AS passRowVersion, p.revision AS passRevision,
    p.lifecycle_generation AS lifecycleGeneration, p.credential_generation AS credentialGeneration, p.release_id AS issuingReleaseId, p.status,
    p.removed_at AS removedAt, p.deleted_at AS deletedAt, p.test_data_quarantined AS quarantined,
    EXISTS (SELECT 1 FROM pass_credential_transfers transfer WHERE transfer.pass_id = p.id AND transfer.state = 'pending') AS transferPending
    FROM passes p WHERE p.id = ? AND p.org_id = ? AND p.mode = ?`,
    [s.passId, s.orgId, s.mode],
  );
}

/** The account's authority epoch, or null when the account is gone. */
export async function readAccountEpoch(db: D1Database, accountId: string): Promise<number | null> {
  const row = await first<{ epoch: number }>(
    db,
    'SELECT authority_epoch AS epoch FROM wallet_provider_accounts WHERE id = ?',
    [accountId],
  );
  return row?.epoch ?? null;
}

export async function listDueOperations(
  db: D1Database,
  now: number,
  limit: number,
  afterId: string | null,
): Promise<WalletOperation[]> {
  return all(
    db,
    // Keep queue eligibility and the live operation proof in the same snapshot, but in
    // separate SELECTs so D1 does not combine their expression depths.
    `WITH due AS MATERIALIZED (
      SELECT op.id FROM wallet_provider_instance_operations op
      JOIN wallet_provider_instances i ON i.id = op.instance_id
        AND i.desired_operation_id = op.id AND i.desired_version = op.version
      WHERE op.state IN ('pending', 'retry') AND op.attempts < 8
        AND (op.next_attempt_at IS NULL OR op.next_attempt_at <= ?) ${afterId === null ? '' : 'AND op.id > ?'}
        AND NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations busy
          WHERE busy.instance_id = i.id AND busy.state IN ('claimed', 'uncertain'))
        AND op.credential_keyset_commitment = ${pinnedKeysetSql}
    )
    SELECT ${OPERATION_COLUMNS} FROM due
    JOIN wallet_provider_instance_operations op ON op.id = due.id
    JOIN wallet_provider_instances i ON i.id = op.instance_id
    WHERE ${walletOpReadCurrentSql('i', 'op')}
    ORDER BY op.id LIMIT ?`,
    [now, ...(afterId === null ? [] : [afterId]), limit],
  );
}
export interface DirtyWalletInstance extends WalletScope {
  instanceId: string;
  passId: string;
  generation: number;
}
export function listDirtyInstances(
  db: D1Database,
  now: number,
  limit: number,
  afterInstanceId: string | null,
): Promise<DirtyWalletInstance[]> {
  return all(
    db,
    `SELECT i.id AS instanceId, i.pass_id AS passId, i.org_id AS orgId, i.mode, i.provider, d.generation
    FROM wallet_provider_instance_dirty d JOIN wallet_provider_instances i ON i.id = d.instance_id
    WHERE d.next_attempt_at <= ? ${afterInstanceId === null ? '' : 'AND i.id > ?'}
      AND i.credential_keyset_commitment = ${pinnedKeysetSql}
      ORDER BY i.id LIMIT ?`,
    [now, ...(afterInstanceId === null ? [] : [afterInstanceId]), limit],
  );
}
export async function ackDirtyInstance(
  db: D1Database,
  s: WalletScope & { instanceId: string; generation: number },
): Promise<boolean> {
  const row = await first(
    db,
    `DELETE FROM wallet_provider_instance_dirty WHERE instance_id = ? AND generation = ?
    AND EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE i.id = instance_id
      AND i.org_id = ? AND i.mode = ? AND i.provider = ? AND i.credential_keyset_commitment = ${pinnedKeysetSql})
    RETURNING instance_id`,
    [s.instanceId, s.generation, ...scopeParams(s)],
  );
  return row !== null;
}

export async function deferDirtyInstance(
  db: D1Database,
  s: WalletScope & {
    instanceId: string;
    generation: number;
    nextAttemptAt: number;
  },
): Promise<boolean> {
  const row = await first(
    db,
    `UPDATE wallet_provider_instance_dirty SET next_attempt_at = ?
    WHERE instance_id = ? AND generation = ?
      AND EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE i.id = instance_id
        AND i.org_id = ? AND i.mode = ? AND i.provider = ? AND i.credential_keyset_commitment = ${pinnedKeysetSql})
    RETURNING instance_id`,
    [s.nextAttemptAt, s.instanceId, s.generation, ...scopeParams(s)],
  );
  return row !== null;
}
