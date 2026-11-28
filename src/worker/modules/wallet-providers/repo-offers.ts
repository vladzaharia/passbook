import { first } from '../../platform/db.ts';
import type { Pass } from '../passes/repo.ts';
import type { NativeProvider } from './projection-contract.ts';
import { walletEnrolmentIssuesSql, walletProviderEnabledSql } from './provider-policy.ts';
import { walletInstanceOperationCurrentSql } from './repo-instance-proof.ts';
import { walletRetiredInstanceSettledSql } from './repo-instance-retirement.ts';
import { pinnedKeysetSql } from './repo-keyset-pin.ts';
import { projectionReleaseBindingPredicateSql } from './repo-projection.ts';

export interface WalletOfferFence {
  refHash: string;
  instanceId: string;
  version: number;
  now: number;
  consumed: boolean;
  deliver?: boolean;
}

/** One D1 read fences the bearer, materialized version, source, account and native release. */
export async function walletOfferSnapshotCurrent(
  db: D1Database,
  pass: Pass,
  lifecycleGeneration: number,
  credentialGeneration: number,
  rawPassJson: string,
  provider: NativeProvider,
  projectionReleaseId: string,
  now: number,
  offer?: WalletOfferFence,
): Promise<boolean> {
  if (offer?.deliver && (!offer.consumed || provider !== 'samsung')) return false;
  const projection = projectionReleaseBindingPredicateSql({
    releaseIdSql: 'p.req_projection_id',
    orgIdSql: 'p.org_id',
    modeSql: 'p.mode',
    providerSql: 'p.req_provider',
    templateIdSql: 'p.template_id',
    versionSql: 'p.template_version',
    sourceReleaseIdSql: 'p.release_id',
    nowSql: 'p.req_now',
    credentialKeysetCommitmentSql: 'p.req_keyset',
  });
  // Every authority proof stays in the one statement. SQLite counts a cursor per CTE reference, so
  // each CTE is read once, in a chain, and the proofs after the snapshot are correlated on `p`.
  const sql = `WITH requested AS MATERIALIZED (
      SELECT ? AS projection_id, ? AS provider, ? AS now, ${pinnedKeysetSql} AS credential_keyset_commitment
    ),
    offer_snapshot AS MATERIALIZED (
    SELECT p.id, p.org_id, p.mode, p.template_id, p.template_version, p.release_id,
      p.credential_generation, requested.projection_id AS req_projection_id,
      requested.provider AS req_provider, requested.now AS req_now,
      requested.credential_keyset_commitment AS req_keyset
    FROM passes p JOIN orgs o ON o.id = p.org_id CROSS JOIN requested
    WHERE p.id = ? AND p.org_id = ? AND p.mode = ? AND p.template_id = ?
      AND p.template_version = ? AND p.release_id IS ? AND p.version = ? AND p.revision = ?
      AND p.lifecycle_generation = ? AND p.credential_generation = ?
      AND p.link_generation = ? AND p.download_token = ?
      AND p.owner_user_id IS ? AND p.holder_email IS ? AND p.object_key = ?
      AND p.object_sha256 IS ? AND p.scan_code IS ? AND p.barcode_hash IS ?
      AND p.status = 'active' AND p.removed_at IS NULL AND p.deleted_at IS NULL
      AND p.test_data_quarantined = 0 AND o.status = 'active'
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
          AND (current_instance.credential_keyset_commitment IS NOT ${pinnedKeysetSql}
            OR (current_instance.desired_version > 0 AND NOT EXISTS (
              SELECT 1 FROM wallet_provider_instance_operations current_op
              WHERE current_op.id = current_instance.desired_operation_id
                AND current_op.instance_id = current_instance.id
                AND current_op.version = current_instance.desired_version
                AND current_op.credential_keyset_commitment = current_instance.credential_keyset_commitment))))
      -- Single SQL form of the provider policy gate (provider-policy.ts).
      AND ${walletProviderEnabledSql('requested.provider', 'p.mode')}
      AND ${walletEnrolmentIssuesSql('p.org_id', 'p.mode', 'requested.provider')}
    ),
    projection_binding AS MATERIALIZED (
      SELECT p.* FROM offer_snapshot p WHERE ${projection}
    ),
    unblocked AS MATERIALIZED (
      SELECT p.* FROM projection_binding p
      WHERE NOT EXISTS (SELECT 1 FROM wallet_provider_instances prior
        WHERE prior.pass_id = p.id AND prior.credential_generation != p.credential_generation
          AND (prior.org_id IS NOT p.org_id OR prior.mode IS NOT p.mode
            OR NOT ${walletRetiredInstanceSettledSql('prior')}))
    )
    ${
      offer
        ? `, offer_operation AS MATERIALIZED (
      SELECT 1 AS ok FROM unblocked p
      JOIN wallet_provider_offer_refs ref
      JOIN wallet_provider_instances i ON i.id = ref.instance_id
      JOIN wallet_provider_instance_operations op ON op.instance_id = i.id
        AND op.version = ref.operation_version
      WHERE ref.ref_hash = ? AND i.id = ? AND i.pass_id = p.id
        AND i.org_id = p.org_id AND i.mode = p.mode AND i.provider = p.req_provider
        AND i.credential_generation = p.credential_generation
        AND i.credential_keyset_commitment = ${pinnedKeysetSql}
        AND op.credential_keyset_commitment = i.credential_keyset_commitment
        AND op.version = ? AND op.kind = 'upsert'
        AND op.state IN ('pending', 'retry', 'claimed', 'succeeded') AND ref.expires_at > ?
        AND ref.pass_authority_generation = COALESCE((SELECT generation
          FROM wallet_provider_pass_authority authority WHERE authority.pass_id = p.id), 0)
        AND ref.consumed_at IS ${offer.consumed ? 'NOT NULL' : 'NULL'}
        AND ${walletInstanceOperationCurrentSql('i', 'op', 'p.req_now')}
    )
    SELECT ok FROM offer_operation`
        : 'SELECT 1 AS ok FROM unblocked'
    }`;
  const params = [
    projectionReleaseId,
    provider,
    now,
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
    rawPassJson,
    ...(offer ? [offer.refHash, offer.instanceId, offer.version, offer.now] : []),
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
