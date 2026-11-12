import type { SqlValue } from '../../platform/db.ts';
import type { CaptureSnapshot } from './binding.ts';

/**
 * Forwarding only: the pass (or every ordered bundle member) is still the recipient's, in the
 * lineage the capture named. Version, object key, token and release are content and not compared.
 */
export function snapshotFence(snapshot: CaptureSnapshot): { sql: string; params: SqlValue[] } {
  if (snapshot.kind === 'pass') {
    const p = snapshot.pass;
    return {
      sql: `EXISTS (SELECT 1 FROM orgs WHERE id = ? AND status = 'active')
        AND EXISTS (SELECT 1 FROM passes p WHERE p.id = ? AND p.org_id = ? AND p.mode = 'test'
          AND p.holder_email IS ? AND p.owner_user_id IS ?
          AND p.identity_id = ? AND p.credential_generation = ? AND p.lifecycle_generation = ?
          AND p.template_id = ? AND p.link_generation = ?
          AND p.status = ? AND p.removed_at IS ? AND p.deleted_at IS NULL
          AND p.test_data_quarantined = 0
          AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = p.id AND t.state = 'pending'))`,
      params: [
        p.orgId,
        p.id,
        p.orgId,
        p.holderEmail,
        p.ownerUserId,
        p.identityId,
        p.credentialGeneration,
        p.lifecycleGeneration,
        p.templateId,
        p.linkGeneration,
        p.status,
        p.removedAt,
      ],
    };
  }
  const { bundle, passes, positions } = snapshot.snapshot;
  const members = JSON.stringify(
    passes.map((p, i) => ({
      id: p.id,
      holderEmail: p.holderEmail,
      ownerUserId: p.ownerUserId,
      identityId: p.identityId,
      credentialGeneration: p.credentialGeneration,
      lifecycleGeneration: p.lifecycleGeneration,
      templateId: p.templateId,
      linkGeneration: p.linkGeneration,
      status: p.status,
      removedAt: p.removedAt,
      position: positions[i],
    })),
  );
  return {
    sql: `EXISTS (SELECT 1 FROM orgs WHERE id = ? AND status = 'active')
      AND EXISTS (SELECT 1 FROM bundles b WHERE b.id = ? AND b.org_id = ? AND b.mode = 'test'
        AND b.name = ? AND b.token = ? AND b.holder_email IS ?)
      AND (SELECT count(*) FROM bundle_passes bp WHERE bp.bundle_id = ?) = json_array_length(?)
      AND NOT EXISTS (SELECT 1 FROM json_each(?) j WHERE NOT EXISTS (
        SELECT 1 FROM bundle_passes bp JOIN passes p ON p.id = bp.pass_id
        WHERE bp.bundle_id = ? AND bp.position = json_extract(j.value, '$.position')
          AND p.id = json_extract(j.value, '$.id') AND p.mode = 'test'
          AND p.holder_email IS json_extract(j.value, '$.holderEmail')
          AND p.owner_user_id IS json_extract(j.value, '$.ownerUserId')
          AND p.identity_id = json_extract(j.value, '$.identityId')
          AND p.credential_generation = json_extract(j.value, '$.credentialGeneration')
          AND p.lifecycle_generation = json_extract(j.value, '$.lifecycleGeneration')
          AND p.template_id = json_extract(j.value, '$.templateId')
          AND p.link_generation = json_extract(j.value, '$.linkGeneration')
          AND p.status = json_extract(j.value, '$.status')
          AND p.removed_at IS json_extract(j.value, '$.removedAt') AND p.deleted_at IS NULL
          AND p.test_data_quarantined = 0
          AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = p.id AND t.state = 'pending')))`,
    params: [
      bundle.org_id,
      bundle.id,
      bundle.org_id,
      bundle.name,
      bundle.token,
      bundle.holder_email,
      bundle.id,
      members,
      members,
      bundle.id,
    ],
  };
}
