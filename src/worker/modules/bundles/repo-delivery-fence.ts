import { type Check, rawCheck, rowIs } from '../../platform/authority-checks.ts';
import type { BundleEmailSnapshot } from './email-binding.ts';

/**
 * What a bundle email still needs at queue time and when it goes out: the bundle is in the actor's
 * tenant and every ordered member is still in it, in the lineage the email names (recipient, owner,
 * identity, generations, status). A transfer START deletes the pass from the bundle, which fails the
 * member count. Members' content (version, object key, token) is read at send time.
 */
export function bundleChecks(snapshot: BundleEmailSnapshot): Check[] {
  const bundle = snapshot?.bundle;
  const passes = snapshot?.passes;
  const positions = snapshot?.positions;
  if (
    !bundle ||
    !passes ||
    !positions ||
    passes.length === 0 ||
    passes.length !== positions.length ||
    passes.some((p) => p.testDataQuarantined || p.deletedAt !== null)
  )
    return [rawCheck('lineage', '0')];
  const members = JSON.stringify(
    passes.map((p, i) => ({
      id: p.id,
      position: positions[i],
      holderEmail: p.holderEmail,
      ownerUserId: p.ownerUserId,
      identityId: p.identityId,
      templateId: p.templateId,
      credentialGeneration: p.credentialGeneration,
      lifecycleGeneration: p.lifecycleGeneration,
      linkGeneration: p.linkGeneration,
      status: p.status,
      removedAt: p.removedAt,
    })),
  );
  return [
    rowIs('bundles', bundle.id, { token: bundle.token, holder_email: bundle.holder_email }),
    rawCheck(
      'lineage',
      `(SELECT count(*) FROM bundle_passes bp JOIN passes p ON p.id = bp.pass_id
        WHERE bp.bundle_id = ? AND p.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
            WHERE t.pass_id = p.id AND t.state = 'pending')) = json_array_length(?)
      AND NOT EXISTS (SELECT 1 FROM json_each(?) j WHERE NOT EXISTS (
        SELECT 1 FROM bundle_passes bp JOIN passes p ON p.id = bp.pass_id
        WHERE bp.bundle_id = ? AND bp.position = json_extract(j.value, '$.position')
          AND p.id = json_extract(j.value, '$.id')
          AND p.holder_email IS json_extract(j.value, '$.holderEmail')
          AND p.owner_user_id IS json_extract(j.value, '$.ownerUserId')
          AND p.identity_id = json_extract(j.value, '$.identityId')
          AND p.template_id = json_extract(j.value, '$.templateId')
          AND p.credential_generation = json_extract(j.value, '$.credentialGeneration')
          AND p.lifecycle_generation = json_extract(j.value, '$.lifecycleGeneration')
          AND p.link_generation = json_extract(j.value, '$.linkGeneration')
          AND p.status = json_extract(j.value, '$.status')
          AND p.removed_at IS json_extract(j.value, '$.removedAt')
          AND p.deleted_at IS NULL AND p.test_data_quarantined = 0
          AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
            WHERE t.pass_id = p.id AND t.state = 'pending')))`,
      [bundle.id, members, members, bundle.id],
    ),
  ];
}
