import { grant } from '../../platform/authority.ts';
import { passRow, rawCheck, rowIs } from '../../platform/authority-checks.ts';
import { notExists } from '../../platform/authority-cond.ts';
import { first } from '../../platform/db.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from './http.ts';
import { capabilityChecks, tenantPrincipal } from './repo-authority.ts';
import type { ImageMutationResult } from './repo-history-image.ts';
import type { Pass } from './repo-map.ts';
import type { MemberPhotoRow } from './repo-member-photo.ts';
import { noPendingTransfer, PASS_LOST, permitsPassWrite } from './repo-pass-grant.ts';

const LOST: ImageMutationResult = { saved: false, candidateId: null, imageGeneration: null };

/**
 * A tenant member photo change as one grant: the principal is live and holds the capability, the pass is the
 * row read (`stale`) at the image epoch and generations the caller captured (`lineage`), no transfer is
 * pending, the pre-PUT upload reservation is live and the previous photo is unchanged. The link and image
 * generations advance in the same batch.
 */
export async function replaceMemberPhotoGranted(
  ctx: ServiceContext,
  next: MemberPhotoRow | null,
  previousVersion: string | null,
  guard: { pass: Pass; imageGeneration: number; authority: TenantPassWrite; uploadKey?: string },
): Promise<ImageMutationResult> {
  const { pass, authority, imageGeneration, uploadKey } = guard;
  if (
    (next && (next.pass_id !== pass.id || next.org_id !== pass.orgId)) ||
    authority.orgId !== pass.orgId ||
    authority.mode !== pass.mode ||
    !permitsPassWrite(authority) ||
    (uploadKey !== undefined && next?.r2_key !== uploadKey) ||
    (!next && previousVersion === null)
  )
    return LOST;
  const g = grant(ctx, {
    purpose: 'org_mode.pass.member_photo',
    principal: tenantPrincipal(authority),
    target: pass.id,
    tables: ['passes', 'member_photos'],
    checks: [
      ...capabilityChecks(authority),
      ...passRow(pass.id, pass.rowVersion),
      rowIs(
        'passes',
        pass.id,
        {
          version: pass.version,
          revision: pass.revision,
          image_generation: imageGeneration,
          credential_generation: pass.credentialGeneration,
          lifecycle_generation: pass.lifecycleGeneration,
          link_generation: pass.linkGeneration,
          status: pass.status,
          removed_at: pass.removedAt,
          test_data_quarantined: 0,
          deleted_at: null,
        },
        'lineage',
      ),
      noPendingTransfer(pass.id),
      ...(uploadKey === undefined
        ? []
        : [
            rawCheck(
              'lineage',
              `EXISTS (SELECT 1 FROM pass_transfer_asset_uploads u
                WHERE u.r2_key = ? AND u.pass_id = ? AND u.credential_generation = ?
                  AND u.lifecycle_generation = ? AND u.link_generation = ? AND u.pass_version = ?
                  AND u.pass_revision = ?)`,
              [
                uploadKey,
                pass.id,
                pass.credentialGeneration,
                pass.lifecycleGeneration,
                pass.linkGeneration,
                pass.version,
                pass.revision,
              ],
            ),
          ]),
    ],
    codes: { lineage: PASS_LOST },
  });
  const before =
    previousVersion === null
      ? null
      : await first<{ id: number | null }>(
          ctx.env.DB,
          'SELECT max(id) AS id FROM pass_transfer_asset_candidates WHERE pass_id = ? AND kind = ? AND slot = ?',
          [pass.id, 'photo', ''],
        );
  const cols = (p: MemberPhotoRow) => ({
    r2_key: p.r2_key,
    sha1: p.sha1,
    size: p.size,
    crc32: p.crc32,
    include_in_pass: p.include_in_pass,
    version: p.version,
    updated_at: p.updated_at,
  });
  if (!next && previousVersion !== null)
    g.delete('member_photos', {
      where: { pass_id: pass.id, version: previousVersion },
      returning: ['pass_id'],
    });
  else if (next && previousVersion !== null)
    g.update('member_photos', {
      where: {
        pass_id: pass.id,
        version: previousVersion,
        // Without a reservation the key must already be the photo's own.
        ...(uploadKey === undefined ? { r2_key: next.r2_key } : {}),
      },
      set: cols(next),
      returning: ['pass_id'],
    });
  else if (next) {
    if (uploadKey === undefined) return LOST;
    const c = cols(next);
    g.insertSelect('member_photos', Object.keys(c), Object.values(c), {
      from: { table: 'passes', where: { id: pass.id }, copy: { pass_id: 'id' } },
      when: [notExists('member_photos', { pass_id: pass.id })],
      returning: ['pass_id'],
    });
  }
  const advance = g.update('passes', {
    inc: ['link_generation'],
    where: {
      id: pass.id,
      link_generation: pass.linkGeneration,
      version: pass.version,
      image_generation: imageGeneration + 1,
    },
    returning: ['image_generation'],
  });
  let results: D1Result[];
  try {
    results = await g.commit();
  } catch (error) {
    if (error instanceof AppError && error.code === PASS_LOST) return LOST;
    throw error;
  }
  const mutated = results[0]?.results?.length === 1;
  const image = (results[g.indexOf(advance)]?.results?.[0] ?? null) as {
    image_generation: number;
  } | null;
  if (!mutated || !image) return LOST;
  if (previousVersion === null)
    return { saved: true, candidateId: null, imageGeneration: image.image_generation };
  const candidate = await first<{ id: number }>(
    ctx.env.DB,
    `SELECT min(id) AS id FROM pass_transfer_asset_candidates
     WHERE pass_id = ? AND kind = 'photo' AND slot = '' AND id > ?`,
    [pass.id, before?.id ?? 0],
  );
  if (candidate?.id == null) throw new Error('Missing image rollback candidate.');
  return { saved: true, candidateId: candidate.id, imageGeneration: image.image_generation };
}
