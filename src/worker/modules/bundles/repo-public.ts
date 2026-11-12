import { first } from '../../platform/db.ts';
import type { Pass } from '../passes/repo.ts';
import type { BundleRow } from './repo.ts';

/** Verify every selected member, its credential incarnation and the bundle capability atomically. */
export async function currentBundleMembers(
  db: D1Database,
  bundle: BundleRow,
  passes: readonly Pass[],
): Promise<boolean> {
  if (
    passes.some(
      (pass) =>
        pass.orgId !== bundle.org_id ||
        pass.mode !== bundle.mode ||
        !Number.isSafeInteger(pass.credentialGeneration) ||
        pass.credentialGeneration < 1 ||
        !Number.isSafeInteger(pass.lifecycleGeneration) ||
        pass.lifecycleGeneration < 0 ||
        typeof pass.identityId !== 'string' ||
        typeof pass.templateId !== 'string' ||
        typeof pass.templateVersion !== 'string' ||
        typeof pass.webServiceUrl !== 'string' ||
        (pass.releaseId !== null && typeof pass.releaseId !== 'string') ||
        pass.deletedAt !== null ||
        pass.testDataQuarantined,
    )
  )
    return false;
  const members = JSON.stringify(
    passes.map((pass) => ({
      id: pass.id,
      orgId: pass.orgId,
      mode: pass.mode,
      holderEmail: pass.holderEmail,
      ownerUserId: pass.ownerUserId,
      identityId: pass.identityId,
      templateId: pass.templateId,
      templateVersion: pass.templateVersion,
      releaseId: pass.releaseId,
      webServiceUrl: pass.webServiceUrl,
      version: pass.version,
      revision: pass.revision,
      linkGeneration: pass.linkGeneration,
      credentialGeneration: pass.credentialGeneration,
      lifecycleGeneration: pass.lifecycleGeneration,
      objectKey: pass.objectKey,
      objectSha256: pass.objectSha256,
      downloadToken: pass.downloadToken,
      status: pass.status,
      removedAt: pass.removedAt,
      scanCode: pass.scanCode,
      barcodeHash: pass.barcodeHash,
    })),
  );
  return (
    (await first(
      db,
      `SELECT 1 FROM bundles b JOIN orgs o ON o.id = b.org_id
    WHERE b.id = ? AND b.org_id = ? AND b.mode = ? AND b.token = ?
      AND b.name = ? AND b.holder_email IS ? AND o.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM bundle_passes qb JOIN passes qp ON qp.id = qb.pass_id
        WHERE qb.bundle_id = b.id AND qp.test_data_quarantined = 1)
      AND NOT EXISTS (SELECT 1 FROM json_each(?) j WHERE NOT EXISTS (
        SELECT 1 FROM bundle_passes bp JOIN passes p ON p.id = bp.pass_id
        WHERE bp.bundle_id = b.id AND p.id = json_extract(j.value, '$.id')
          AND p.org_id = json_extract(j.value, '$.orgId') AND p.mode = json_extract(j.value, '$.mode')
          AND p.holder_email IS json_extract(j.value, '$.holderEmail')
          AND p.owner_user_id IS json_extract(j.value, '$.ownerUserId')
          AND p.identity_id = json_extract(j.value, '$.identityId')
          AND p.template_id = json_extract(j.value, '$.templateId')
          AND p.template_version = json_extract(j.value, '$.templateVersion')
          AND p.release_id IS json_extract(j.value, '$.releaseId')
          AND p.web_service_url = json_extract(j.value, '$.webServiceUrl')
          AND p.version = json_extract(j.value, '$.version') AND p.revision = json_extract(j.value, '$.revision')
          AND p.link_generation = json_extract(j.value, '$.linkGeneration')
          AND p.credential_generation = json_extract(j.value, '$.credentialGeneration')
          AND p.lifecycle_generation = json_extract(j.value, '$.lifecycleGeneration')
          AND p.object_key = json_extract(j.value, '$.objectKey')
          AND p.object_sha256 IS json_extract(j.value, '$.objectSha256')
          AND p.download_token = json_extract(j.value, '$.downloadToken')
          AND p.status = json_extract(j.value, '$.status')
          AND p.removed_at IS json_extract(j.value, '$.removedAt')
          AND p.scan_code IS json_extract(j.value, '$.scanCode')
          AND p.barcode_hash IS json_extract(j.value, '$.barcodeHash')
          AND p.deleted_at IS NULL AND p.test_data_quarantined = 0
          AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
            WHERE t.pass_id = p.id AND t.state = 'pending')))`,
      [
        bundle.id,
        bundle.org_id,
        bundle.mode,
        bundle.token,
        bundle.name,
        bundle.holder_email,
        members,
      ],
    )) !== null
  );
}
