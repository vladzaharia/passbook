import { first } from '../../platform/db.ts';
import type { Pass } from '../passes/repo.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import type { NativeProvider } from './projection-contract.ts';
import { walletProviderEnabledSql } from './provider-policy.ts';
import { walletInstanceOperationCurrentSql } from './repo-instance-proof.ts';
import { walletRetiredInstanceSettledSql } from './repo-instance-retirement.ts';
import { projectionReleaseBindingPredicateSql } from './repo-projection.ts';

export interface WalletOfferFence {
  refHash: string;
  instanceId: string;
  version: number;
  now: number;
  consumed: boolean;
  deliver?: boolean;
}

/** Final keyset-only output fence when multiple eligible links were assembled. */
export async function walletOfferKeysetCurrent(
  db: D1Database,
  credentialKeysetCommitment: string,
): Promise<boolean> {
  if (
    typeof credentialKeysetCommitment !== 'string' ||
    !/^[0-9a-f]{64}$/.test(credentialKeysetCommitment)
  )
    return false;
  return (
    (await first(db, `SELECT 1 WHERE ${credentialRefKeysetSql}`, [credentialKeysetCommitment])) !==
    null
  );
}

/** One D1 read fences the bearer, materialized version, source, account and native release. */
export async function walletOfferSnapshotCurrent(
  db: D1Database,
  pass: Pass,
  lifecycleGeneration: number,
  credentialGeneration: number,
  credentialKeysetCommitment: string,
  rawPassJson: string,
  provider: NativeProvider,
  projectionReleaseId: string,
  now: number,
  offer?: WalletOfferFence,
): Promise<boolean> {
  if (
    typeof credentialKeysetCommitment !== 'string' ||
    !/^[0-9a-f]{64}$/.test(credentialKeysetCommitment)
  )
    return false;
  if (offer?.deliver && (!offer.consumed || provider !== 'samsung')) return false;
  const projection = projectionReleaseBindingPredicateSql({
    releaseIdSql: 'requested.projection_id',
    orgIdSql: 'p.org_id',
    modeSql: 'p.mode',
    providerSql: 'requested.provider',
    templateIdSql: 'p.template_id',
    versionSql: 'p.template_version',
    sourceReleaseIdSql: 'p.release_id',
    nowSql: 'requested.now',
    credentialKeysetCommitmentSql: 'requested.credential_keyset_commitment',
  });
  // Keep each authority proof in the same statement while preventing the nested
  // projection and operation predicates from accumulating expression depth.
  const sql = `WITH requested AS MATERIALIZED (
      SELECT ? AS projection_id, ? AS provider, ? AS now, ? AS credential_keyset_commitment
    ),
    offer_snapshot AS MATERIALIZED (
    SELECT p.id, p.org_id, p.mode, p.template_id, p.template_version, p.release_id,
      p.credential_generation
    FROM passes p JOIN orgs o ON o.id = p.org_id CROSS JOIN requested
    WHERE p.id = ? AND p.org_id = ? AND p.mode = ? AND p.template_id = ?
      AND p.template_version = ? AND p.release_id IS ? AND p.version = ? AND p.revision = ?
      AND p.lifecycle_generation = ? AND p.credential_generation = ?
      AND p.link_generation = ? AND p.download_token = ?
      AND p.owner_user_id IS ? AND p.holder_email IS ? AND p.object_key = ?
      AND p.object_sha256 IS ? AND p.scan_code IS ? AND p.barcode_hash IS ?
      AND p.status = 'active' AND p.removed_at IS NULL AND p.deleted_at IS NULL
      AND p.test_data_quarantined = 0 AND o.status = 'active'
      AND ${credentialRefKeysetSql}
      AND COALESCE(json_type(o.branding, '$.logo'), 'null') = 'null'
      AND COALESCE(json_type(o.branding, '$.icon'), 'null') = 'null'
      AND (SELECT pv.pass_json FROM pass_versions pv WHERE pv.pass_id = p.id
        AND pv.version <= p.version ORDER BY pv.version DESC LIMIT 1) = ?
      AND NOT EXISTS (SELECT 1 FROM pass_assets asset WHERE asset.pass_id = p.id)
      AND NOT EXISTS (SELECT 1 FROM member_photos photo WHERE photo.pass_id = p.id
        AND photo.include_in_pass = 1)
      AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers transfer
        WHERE transfer.pass_id = p.id AND transfer.state = 'pending')
      AND NOT EXISTS (SELECT 1 FROM wallet_provider_instances current_instance
        WHERE current_instance.pass_id = p.id AND current_instance.provider = requested.provider
          AND current_instance.credential_generation = p.credential_generation
          AND (current_instance.credential_keyset_commitment IS NOT ?
            OR (current_instance.desired_version > 0 AND NOT EXISTS (
              SELECT 1 FROM wallet_provider_instance_operations current_op
              WHERE current_op.id = current_instance.desired_operation_id
                AND current_op.instance_id = current_instance.id
                AND current_op.version = current_instance.desired_version
                AND current_op.credential_keyset_commitment = current_instance.credential_keyset_commitment))))
      -- Single SQL form of the provider policy gate (provider-policy.ts).
      AND ${walletProviderEnabledSql('requested.provider')}
    ),
    retirement_blocker AS MATERIALIZED (
      SELECT 1 FROM offer_snapshot p
      JOIN wallet_provider_instances prior ON prior.pass_id = p.id
      WHERE prior.credential_generation != p.credential_generation
        AND (prior.org_id IS NOT p.org_id OR prior.mode IS NOT p.mode
          OR NOT ${walletRetiredInstanceSettledSql('prior')})
      LIMIT 1
    ),
    projection_binding AS MATERIALIZED (
      SELECT 1 FROM offer_snapshot p CROSS JOIN requested WHERE ${projection}
    )
    ${
      offer
        ? `,
    offer_candidates AS MATERIALIZED (
      SELECT i.id AS instance_id, op.id AS operation_id
      FROM offer_snapshot p CROSS JOIN requested
      JOIN wallet_provider_offer_refs ref
      JOIN wallet_provider_instances i ON i.id = ref.instance_id
      JOIN wallet_provider_instance_operations op ON op.instance_id = i.id
        AND op.version = ref.operation_version
      WHERE ref.ref_hash = ? AND i.id = ? AND i.pass_id = p.id
        AND i.org_id = p.org_id AND i.mode = p.mode AND i.provider = requested.provider
        AND i.credential_generation = p.credential_generation
        AND i.credential_keyset_commitment = ?
        AND op.credential_keyset_commitment = i.credential_keyset_commitment
        AND op.version = ? AND op.kind = 'upsert'
        AND op.state IN ('pending', 'retry', 'claimed', 'succeeded') AND ref.expires_at > ?
        AND ref.pass_authority_generation = COALESCE((SELECT generation
          FROM wallet_provider_pass_authority authority WHERE authority.pass_id = p.id), 0)
        AND ref.consumed_at IS ${offer.consumed ? 'NOT NULL' : 'NULL'}
    ),
    offer_operation AS MATERIALIZED (
      SELECT 1
      FROM offer_candidates candidate
      JOIN wallet_provider_instances i ON i.id = candidate.instance_id
      JOIN wallet_provider_instance_operations op ON op.id = candidate.operation_id
      CROSS JOIN requested
      WHERE ${walletInstanceOperationCurrentSql('i', 'op', 'requested.now')}
    )`
        : ''
    }
    SELECT 1 AS ok FROM offer_snapshot
    WHERE EXISTS (SELECT 1 FROM projection_binding)
      AND NOT EXISTS (SELECT 1 FROM retirement_blocker)
      ${offer ? 'AND EXISTS (SELECT 1 FROM offer_operation)' : ''}`;
  const params = [
    projectionReleaseId,
    provider,
    now,
    credentialKeysetCommitment,
    pass.id,
    pass.orgId,
    pass.mode,
    pass.templateId,
    pass.templateVersion,
    pass.releaseId,
    pass.version,
    pass.revision,
    lifecycleGeneration,
    credentialGeneration,
    pass.linkGeneration,
    pass.downloadToken,
    pass.ownerUserId,
    pass.holderEmail,
    pass.objectKey,
    pass.objectSha256,
    pass.scanCode,
    pass.barcodeHash,
    credentialKeysetCommitment,
    rawPassJson,
    credentialKeysetCommitment,
    ...(offer
      ? [offer.refHash, offer.instanceId, credentialKeysetCommitment, offer.version, offer.now]
      : []),
  ];
  const row = offer?.deliver
    ? await first<{ ok: number }>(
        db,
        `UPDATE wallet_provider_offer_refs SET delivered_at = ?
        WHERE ref_hash = ? AND delivered_at IS NULL AND EXISTS (${sql}) RETURNING 1 AS ok`,
        [offer.now, offer.refHash, ...params],
      )
    : await first<{ ok: number }>(db, sql, params);
  return row !== null;
}
