import { batch, stmt } from '../../platform/db.ts';
import type {
  WalletInstanceProof,
  WalletOfferAuthority,
  WalletOperationKind,
} from './instance-types.ts';
import { sourcePinSql } from './repo-account-source.ts';
import {
  walletInstanceOperationCurrentSql,
  walletInstanceProofSql,
} from './repo-instance-proof.ts';
import { walletNoProviderArtifactsSql } from './repo-instance-retirement.ts';
import { slotFreeSql, successorGuardSql } from './repo-instance-slot-sql.ts';
import { pinnedKeysetSql } from './repo-keyset-pin.ts';

type Insert = WalletInstanceProof & {
  instanceId: string;
  operationId: string;
  requestHash: string;
  now: number;
  /** A successor of a channel-off predecessor is its epoch + 1; absent means a first instance. */
  channelEpoch?: number;
};
const proofValues = (p: Insert) =>
  [
    p.instanceId,
    p.operationId,
    p.passId,
    p.orgId,
    p.mode,
    p.provider,
    p.accountId,
    p.passVersion,
    p.passRevision,
    p.lifecycleGeneration,
    p.passCredentialGeneration,
    p.issuingReleaseId,
    p.projectionReleaseId,
    p.accountRevision,
    p.adapterRevision,
    p.policyRevision,
  ] as const;
const PROOF_CTE = `proof AS (SELECT ? AS instance_id, ? AS operation_id, ? AS pass_id, ? AS org_id,
  ? AS mode, ? AS provider, ? AS account_id, ? AS pass_version, ? AS pass_revision,
  ? AS lifecycle_generation, ? AS pass_credential_generation, ? AS issuing_release_id, ? AS projection_release_id,
  ? AS account_revision, ? AS adapter_revision, ? AS policy_revision, ${pinnedKeysetSql} AS credential_keyset_commitment)`;
const NEW_OP_CTE = `op AS (SELECT operation_id AS id, instance_id, 1 AS version, 'upsert' AS kind,
  pass_version, pass_revision, lifecycle_generation, pass_credential_generation, issuing_release_id, projection_release_id,
  account_revision, adapter_revision, policy_revision, credential_keyset_commitment FROM proof)`;

const offerAuthoritySql = `EXISTS (SELECT 1 FROM passes bearer WHERE bearer.id = i.pass_id
  AND ((? = 'download' AND bearer.download_token = ?) OR (? = 'holder' AND bearer.owner_user_id = ?)))`;
function offerAuthorityValues(offer: { authority: WalletOfferAuthority } | undefined): string[] {
  if (!offer) return [];
  const value =
    offer.authority.kind === 'download' ? offer.authority.token : offer.authority.ownerUserId;
  return [offer.authority.kind, value, offer.authority.kind, value];
}

export function offerStatement(
  db: D1Database,
  instanceId: string,
  operationId: string,
  offer: { hash: string; expiresAt: number; authority: WalletOfferAuthority },
  now: number,
): D1PreparedStatement {
  const authority =
    offer.authority.kind === 'download' ? offer.authority.token : offer.authority.ownerUserId;
  return stmt(
    db,
    `INSERT INTO wallet_provider_offer_refs
      (ref_hash, instance_id, operation_version, created_at, expires_at, pass_authority_generation)
    SELECT ?, i.id, op.version, ?, ?, COALESCE((SELECT generation FROM wallet_provider_pass_authority
      WHERE pass_id = i.pass_id), 0) FROM wallet_provider_instances i
    JOIN wallet_provider_instance_operations op ON op.instance_id = i.id
    JOIN passes holder ON holder.id = i.pass_id
    WHERE i.id = ? AND op.id = ? AND op.kind = 'upsert'
      AND op.state IN ('pending', 'retry', 'claimed', 'succeeded')
      AND ((? = 'download' AND holder.download_token = ?) OR (? = 'holder' AND holder.owner_user_id = ?))
      AND ${walletInstanceOperationCurrentSql('i', 'op', '?')}
      AND i.credential_keyset_commitment = ${pinnedKeysetSql} AND op.credential_keyset_commitment = ${pinnedKeysetSql}
    RETURNING ref_hash`,
    [
      offer.hash,
      now,
      offer.expiresAt,
      instanceId,
      operationId,
      offer.authority.kind,
      authority,
      offer.authority.kind,
      authority,
      now,
    ],
  );
}

/** Instance, initial operation, and optionally an offer are inserted in a single D1 transaction. */
export async function insertInstance(
  db: D1Database,
  p: Insert,
  offer?: { hash: string; expiresAt: number; authority: WalletOfferAuthority },
): Promise<void> {
  const channelEpoch = p.channelEpoch ?? 1;
  if (!Number.isSafeInteger(channelEpoch) || channelEpoch < 1 || channelEpoch > 16) return;
  const statements = [
    stmt(
      db,
      `WITH ${PROOF_CTE},
      i AS (SELECT instance_id AS id, pass_id, org_id, mode, provider, account_id,
        projection_release_id AS identity_projection_release_id, pass_credential_generation AS credential_generation,
        credential_keyset_commitment,
        'active' AS lifecycle, NULL AS retirement_requested_at,
        1 AS desired_version, operation_id AS desired_operation_id, ${channelEpoch} AS channel_epoch FROM proof), ${NEW_OP_CTE}
      INSERT OR IGNORE INTO wallet_provider_instances
        (id, pass_id, org_id, mode, provider, account_id, identity_projection_release_id,
         credential_generation, channel_epoch, credential_keyset_commitment, desired_version, desired_operation_id, created_at, updated_at, card_type)
      SELECT i.id, i.pass_id, i.org_id, i.mode, i.provider, i.account_id, i.identity_projection_release_id,
        i.credential_generation, i.channel_epoch, i.credential_keyset_commitment, 1, i.desired_operation_id, ?, ?, (SELECT json_extract(c.projection_json, '$.cardType') FROM template_releases r JOIN template_candidates c ON c.id = r.candidate_id WHERE r.id = i.identity_projection_release_id) FROM i, op
      WHERE ${walletInstanceOperationCurrentSql('i', 'op', '?')}
        AND ${slotFreeSql}
        ${channelEpoch === 1 ? '' : successorGuardSql}
        ${offer ? `AND ${offerAuthoritySql}` : ''}`,
      [...proofValues(p), p.now, p.now, p.now, ...offerAuthorityValues(offer)],
    ),
    stmt(
      db,
      `WITH ${PROOF_CTE},
      i AS (SELECT instance_id AS id, pass_id, org_id, mode, provider, account_id,
        projection_release_id AS identity_projection_release_id, pass_credential_generation AS credential_generation,
        credential_keyset_commitment,
        'active' AS lifecycle, NULL AS retirement_requested_at,
        1 AS desired_version, operation_id AS desired_operation_id FROM proof), ${NEW_OP_CTE}
      INSERT INTO wallet_provider_instance_operations
        (id, instance_id, version, kind, request_hash, pass_version, pass_revision, lifecycle_generation,
         pass_credential_generation, issuing_release_id, projection_release_id, account_revision, adapter_revision, policy_revision,
         credential_keyset_commitment, created_at, credential_version_id, pass_row_version, account_epoch)
      SELECT op.id, actual.id, 1, 'upsert', ?, op.pass_version, op.pass_revision, op.lifecycle_generation,
        op.pass_credential_generation, op.issuing_release_id, op.projection_release_id, op.account_revision,
        op.adapter_revision, op.policy_revision, op.credential_keyset_commitment, ?, ${sourcePinSql('?')},
        (SELECT p.row_version FROM passes p WHERE p.id = i.pass_id),
        (SELECT a.authority_epoch FROM wallet_provider_accounts a WHERE a.id = i.account_id) FROM i, op, wallet_provider_instances actual
      WHERE actual.id = i.id AND actual.pass_id = i.pass_id AND actual.org_id = i.org_id AND actual.mode = i.mode
        AND actual.provider = i.provider AND actual.credential_generation = i.credential_generation
        AND actual.credential_keyset_commitment = ${pinnedKeysetSql}
        AND ((actual.lifecycle = 'active' AND actual.desired_operation_id = op.id)
          OR (actual.lifecycle = 'ready' AND ${walletNoProviderArtifactsSql('actual')}))
        AND ${walletInstanceOperationCurrentSql('i', 'op', '?')}
        ${offer ? `AND ${offerAuthoritySql}` : ''}`,
      [...proofValues(p), p.requestHash, p.now, p.accountId, p.now, ...offerAuthorityValues(offer)],
    ),
    // card_type is set once, here, from the first approved projection; 0116 refuses any later change.
    stmt(
      db,
      `UPDATE wallet_provider_instances AS target SET lifecycle = 'active', account_id = ?,
        identity_projection_release_id = ?, desired_version = 1, desired_operation_id = ?, updated_at = ?,
        card_type = (SELECT json_extract(c.projection_json, '$.cardType') FROM template_releases r JOIN template_candidates c ON c.id = r.candidate_id WHERE r.id = ?)
      WHERE target.id = ? AND target.lifecycle = 'ready' AND target.credential_keyset_commitment = ${pinnedKeysetSql}
        AND EXISTS (
        SELECT 1 FROM wallet_provider_instance_operations op WHERE op.id = ? AND op.instance_id = target.id
          AND op.version = 1 AND op.kind = 'upsert' AND op.pass_credential_generation = target.credential_generation
          AND op.credential_keyset_commitment = ${pinnedKeysetSql})`,
      [
        p.accountId,
        p.projectionReleaseId,
        p.operationId,
        p.now,
        p.projectionReleaseId,
        p.instanceId,
        p.operationId,
      ],
    ),
  ];
  if (offer) statements.push(offerStatement(db, p.instanceId, p.operationId, offer, p.now));
  await batch(db, statements);
}

export async function insertDesiredOperation(
  db: D1Database,
  p: Insert & { expectedVersion: number; kind: WalletOperationKind },
  offer?: { hash: string; expiresAt: number; authority: WalletOfferAuthority },
): Promise<void> {
  const next = p.expectedVersion + 1;
  const statements = [
    stmt(
      db,
      `WITH ${PROOF_CTE}, op AS (SELECT operation_id AS id, instance_id, ? AS version, ? AS kind,
        pass_version, pass_revision, lifecycle_generation, pass_credential_generation, issuing_release_id, projection_release_id,
        account_revision, adapter_revision, policy_revision, credential_keyset_commitment FROM proof)
      UPDATE wallet_provider_instances AS i SET desired_version = ?, desired_operation_id = ?,
        lifecycle = CASE WHEN ? = 'revoke' THEN 'revoking' ELSE 'active' END,
        revoked_at = CASE WHEN ? = 'upsert' THEN NULL ELSE revoked_at END, updated_at = ?
      WHERE i.id = ? AND i.pass_id = ? AND i.org_id = ? AND i.mode = ? AND i.provider = ?
        AND i.account_id = ? AND i.desired_version = ?
        AND EXISTS (SELECT 1 FROM wallet_provider_instance_operations previous
          WHERE previous.id = i.desired_operation_id AND previous.instance_id = i.id
            AND previous.version = i.desired_version
            AND previous.credential_keyset_commitment = i.credential_keyset_commitment)
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
                OR (last.kind = 'revoke' AND last.pass_credential_generation < ?)))))))
        AND NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations duplicate
          WHERE duplicate.instance_id = i.id AND duplicate.request_hash = ?)
        AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers reservation
          JOIN passes reserved ON reserved.id = reservation.pass_id
          WHERE reservation.pass_id = i.pass_id AND reservation.state = 'pending'
            AND reserved.credential_generation = reservation.source_generation)
        AND EXISTS (SELECT 1 FROM op WHERE ${walletInstanceProofSql('i', 'op', '?', true)})
        AND i.credential_keyset_commitment = ${pinnedKeysetSql}
        ${offer ? `AND ${offerAuthoritySql}` : ''}`,
      [
        ...proofValues(p),
        next,
        p.kind,
        next,
        p.operationId,
        p.kind,
        p.kind,
        p.now,
        p.instanceId,
        p.passId,
        p.orgId,
        p.mode,
        p.provider,
        p.accountId,
        p.expectedVersion,
        p.kind,
        p.lifecycleGeneration,
        p.kind,
        p.passCredentialGeneration,
        p.requestHash,
        p.now,
        ...offerAuthorityValues(offer),
      ],
    ),
    stmt(
      db,
      `UPDATE wallet_provider_instance_operations SET state = 'superseded', completed_at = ?
      WHERE instance_id = ? AND version < ? AND state IN ('pending', 'retry')
        AND credential_keyset_commitment = ${pinnedKeysetSql}
        AND EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE i.id = ? AND i.desired_operation_id = ?
          AND i.credential_keyset_commitment = ${pinnedKeysetSql})`,
      [p.now, p.instanceId, next, p.instanceId, p.operationId],
    ),
    stmt(
      db,
      `INSERT INTO wallet_provider_instance_operations
        (id, instance_id, version, kind, request_hash, pass_version, pass_revision, lifecycle_generation,
         pass_credential_generation, issuing_release_id, projection_release_id, account_revision, adapter_revision, policy_revision,
         credential_keyset_commitment, created_at, credential_version_id, pass_row_version, account_epoch)
      SELECT ?, i.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${pinnedKeysetSql}, ?, ${sourcePinSql('i.account_id')},
        (SELECT p.row_version FROM passes p WHERE p.id = i.pass_id),
        (SELECT a.authority_epoch FROM wallet_provider_accounts a WHERE a.id = i.account_id) FROM wallet_provider_instances i
      WHERE i.id = ? AND i.desired_operation_id = ? AND i.credential_keyset_commitment = ${pinnedKeysetSql}`,
      [
        p.operationId,
        next,
        p.kind,
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
        p.instanceId,
        p.operationId,
      ],
    ),
  ];
  if (offer) statements.push(offerStatement(db, p.instanceId, p.operationId, offer, p.now));
  await batch(db, statements);
}
