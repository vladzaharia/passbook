// PE5b: the reconcile write. The desired operation moves the instance, supersedes the older queued ones and inserts
// the new row in one grant batch. The upsert grant pins what reconcile read (the pass row_version, the account epoch,
// the desired version, the projection head), so a pass that moved after the read refuses `stale` and nothing is
// written. A revoke pins no pass content and no account epoch (D6); it runs under the retire grant, which also runs
// for a suspended or closed org.

import { passRow } from '../../platform/authority-checks.ts';
import { writePart } from '../../platform/authority-include.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { WalletOperationKind, WalletQueueProof } from './instance-types.ts';
import { sourcePinSql } from './repo-account-source.ts';
import {
  accountEpochCheck,
  instanceCheck,
  projectionHeadCheck,
  revokeIdentitySql,
} from './repo-instance-current.ts';
import { pinnedKeysetSql } from './repo-keyset-pin.ts';
import { commitWalletGrant, walletQueueGrant } from './repo-queue-grant.ts';

// The extra equalities in the instance UPDATE keep the op row coherent with the pass and account rows the caller read
// (the data columns it stores); the authority is still the grant's row_version and epoch checks.
export type DesiredOperationInput = WalletQueueProof & {
  instanceId: string;
  operationId: string;
  requestHash: string;
  expectedVersion: number;
  kind: WalletOperationKind;
  now: number;
};

/** The refusal reason, or `queued` (the rows may still not exist: the caller reads the request back). */
export async function grantDesiredOperation(
  ctx: ServiceContext,
  p: DesiredOperationInput,
): Promise<'queued' | 'stale' | 'refused'> {
  const next = p.expectedVersion + 1;
  const upsert = p.kind === 'upsert';
  const g = walletQueueGrant(
    ctx,
    upsert ? 'reconcile' : 'retire',
    p,
    upsert
      ? [
          ...passRow(p.passId, p.passRowVersion),
          accountEpochCheck(p.accountId, p.accountEpoch),
          projectionHeadCheck(p.instanceId, p.projectionReleaseId),
          instanceCheck(p.instanceId, p.expectedVersion),
        ]
      : [...passRow(p.passId), instanceCheck(p.instanceId, p.expectedVersion)],
  );
  g.include(
    writePart(
      `UPDATE wallet_provider_instances AS i SET desired_version = ?, desired_operation_id = ?,
        lifecycle = CASE WHEN ? = 'revoke' THEN 'revoking' ELSE 'active' END,
        revoked_at = CASE WHEN ? = 'upsert' THEN NULL ELSE revoked_at END, updated_at = ?
      WHERE i.id = ? AND i.pass_id = ? AND org_id = {org} AND mode = {mode} AND i.provider = ?
        AND pass_id IN (SELECT pass.id FROM passes pass WHERE pass.org_id = {org} AND pass.mode = {mode})
        AND i.account_id = ? AND i.desired_version = ?
        AND EXISTS (SELECT 1 FROM wallet_provider_instance_operations previous
          WHERE previous.id = i.desired_operation_id AND previous.instance_id = i.id
            AND previous.version = i.desired_version
            AND previous.credential_keyset_commitment = i.credential_keyset_commitment)
        AND (? = 'revoke' OR i.retirement_requested_at IS NULL)
        AND ((? = 'upsert' AND (i.lifecycle = 'active' OR (i.lifecycle IN ('revoking', 'revoked')
          AND EXISTS (SELECT 1 FROM wallet_provider_instance_operations last
            WHERE last.id = i.desired_operation_id AND last.kind = 'revoke'
              AND last.state IN ('pending', 'retry', 'failed', 'superseded', 'succeeded')
              AND last.lifecycle_generation < ?)
          AND NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations busy
            WHERE busy.instance_id = i.id AND busy.state IN ('claimed', 'uncertain')))))
          OR (? = 'revoke' AND (i.lifecycle = 'active' OR (i.lifecycle = 'revoking' AND EXISTS (
            SELECT 1 FROM wallet_provider_instance_operations last WHERE last.id = i.desired_operation_id
              AND (last.state IN ('failed', 'superseded')
                OR (last.kind = 'revoke' AND last.pass_credential_generation < ?)))))
            AND ${revokeIdentitySql('i')}))
        AND (? = 'revoke' OR EXISTS (SELECT 1 FROM passes pass WHERE pass.id = i.pass_id
          AND pass.version = ? AND pass.revision = ? AND pass.lifecycle_generation = ?
          AND pass.credential_generation = ? AND pass.release_id IS ?))
        AND (? = 'revoke' OR EXISTS (SELECT 1 FROM wallet_provider_accounts account
          JOIN template_releases rel ON rel.id = ?
          WHERE account.id = i.account_id
            AND CASE WHEN account.credential_id IS NULL THEN account.enrolment_revision ELSE account.revision END = ?
            AND rel.adapter_revision = ? AND rel.audience_policy_revision = ?))
        AND NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations duplicate
          WHERE duplicate.instance_id = i.id AND duplicate.request_hash = ?)
        AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers reservation
          JOIN passes reserved ON reserved.id = reservation.pass_id
          WHERE reservation.pass_id = i.pass_id AND reservation.state = 'pending'
            AND reserved.credential_generation = reservation.source_generation)
        AND i.credential_keyset_commitment = ${pinnedKeysetSql} AND {grant}`,
      [
        next,
        p.operationId,
        p.kind,
        p.kind,
        p.now,
        p.instanceId,
        p.passId,
        p.provider,
        p.accountId,
        p.expectedVersion,
        p.kind,
        p.kind,
        p.lifecycleGeneration,
        p.kind,
        p.passCredentialGeneration,
        p.kind,
        p.passVersion,
        p.passRevision,
        p.lifecycleGeneration,
        p.passCredentialGeneration,
        p.issuingReleaseId,
        p.kind,
        p.projectionReleaseId,
        p.accountRevision,
        p.adapterRevision,
        p.policyRevision,
        p.requestHash,
      ],
    ),
    writePart(
      `UPDATE wallet_provider_instance_operations SET state = 'superseded', completed_at = ?
      WHERE instance_id = ? AND version < ? AND state IN ('pending', 'retry')
        AND credential_keyset_commitment = ${pinnedKeysetSql}
        AND EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE i.id = ? AND i.desired_operation_id = ?
          AND i.org_id = {org} AND i.mode = {mode} AND i.credential_keyset_commitment = ${pinnedKeysetSql})
        AND {grant}`,
      [p.now, p.instanceId, next, p.instanceId, p.operationId],
    ),
    writePart(
      `INSERT INTO wallet_provider_instance_operations
        (id, instance_id, version, kind, request_hash, pass_version, pass_revision, lifecycle_generation,
         pass_credential_generation, issuing_release_id, projection_release_id, account_revision, adapter_revision, policy_revision,
         credential_keyset_commitment, created_at, credential_version_id, pass_row_version, account_epoch)
      SELECT ?, i.id, ?, '${p.kind}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${pinnedKeysetSql}, ?, ${sourcePinSql('i.account_id')}, ?, ?
      FROM wallet_provider_instances i
      WHERE i.id = ? AND i.desired_operation_id = ? AND i.org_id = {org} AND i.mode = {mode}
        AND i.credential_keyset_commitment = ${pinnedKeysetSql} AND {grant}`,
      [
        p.operationId,
        next,
        p.requestHash,
        p.passVersion,
        p.passRevision,
        p.lifecycleGeneration,
        p.passCredentialGeneration,
        p.issuingReleaseId,
        p.projectionReleaseId,
        p.accountRevision,
        p.adapterRevision,
        p.policyRevision,
        p.now,
        p.passRowVersion,
        p.accountEpoch,
        p.instanceId,
        p.operationId,
      ],
    ),
  );
  const committed = await commitWalletGrant(g);
  if ('results' in committed) return 'queued';
  return committed.refused === 'stale' ? 'stale' : 'refused';
}
