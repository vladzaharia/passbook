import type { SqlValue } from '../../platform/db.ts';
import { safeEqual } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { assetSnapshotInput, assetSnapshotProofFromInput } from './asset-secrets.ts';
import type { AssetPassSnapshot } from './asset-types.ts';
import type { VerifiedAssetGrant } from './assets.ts';
import { snapshotCredentialEnv } from './credential-input.ts';

/**
 * Prepare the row/photo part of a larger live fence, without retaining the original pass in the
 * verified grant: the pass, its photo and the grant's own expiry. The closure is request-local only.
 */
export async function prepareAssetGrantFence(
  ctx: ServiceContext,
  input: VerifiedAssetGrant,
  snapshot: AssetPassSnapshot,
): Promise<((now: number) => { sql: string; params: SqlValue[] }) | null> {
  const pinnedEnv = snapshotCredentialEnv(ctx.env);
  if (!input?.actor || !snapshot?.pass || snapshot.pass.id !== input.passId) return null;
  const expiresAt = input.expiresAt;
  const orgId = input.actor.orgId;
  const mode = input.actor.mode;
  const snapshotProof = input.snapshotProof;
  let capturedInput: string;
  try {
    capturedInput = assetSnapshotInput(snapshot);
    if (
      !(await safeEqual(await assetSnapshotProofFromInput(pinnedEnv, capturedInput), snapshotProof))
    )
      return null;
  } catch {
    return null;
  }
  return (now) => {
    try {
      if (assetSnapshotInput(snapshot) !== capturedInput) return { sql: '0', params: [] };
    } catch {
      return { sql: '0', params: [] };
    }
    const pass = snapshot.pass;
    if (
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now ||
      orgId !== pass.orgId ||
      mode !== pass.mode ||
      !Number.isSafeInteger(pass.imageGeneration) ||
      pass.imageGeneration < 0
    )
      return { sql: '0', params: [] };
    const photo = snapshot.assetPhoto;
    const photoSql = photo
      ? `EXISTS (SELECT 1 FROM member_photos m WHERE m.pass_id=p.id AND m.org_id=p.org_id
          AND m.version IS ? AND m.r2_key IS ?/* scan-ephemeral-asset-photo-key */
          AND m.sha1 IS ? AND m.include_in_pass IS ?)`
      : `NOT EXISTS (SELECT 1 FROM member_photos m WHERE m.pass_id=p.id AND m.org_id=p.org_id)`;
    return {
      sql: `p.id=?/* scan-ephemeral-pass-id */ AND p.org_id=? AND p.mode=?
        AND p.image_generation IS ? AND (${photoSql}) AND ?>?`,
      params: [
        pass.id,
        pass.orgId,
        pass.mode,
        pass.imageGeneration,
        ...(photo ? [photo.version, photo.key, photo.sha1, photo.includeInPass] : []),
        expiresAt,
        now,
      ],
    };
  };
}
