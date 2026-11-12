import { grant } from '../../platform/authority.ts';
import { rawCheck, rowIs } from '../../platform/authority-checks.ts';
import { notExists } from '../../platform/authority-cond.ts';
import { first } from '../../platform/db.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from './http.ts';
import { capabilityChecks, tenantPrincipal } from './repo-authority.ts';
import type { AssetRow } from './repo-history-assets.ts';
import type { ImageMutationResult } from './repo-history-image.ts';
import type { Pass } from './repo-map.ts';
import { noPendingTransfer, PASS_LOST, permitsPassWrite } from './repo-pass-grant.ts';

const LOST: ImageMutationResult = { saved: false, candidateId: null, imageGeneration: null };

/**
 * A tenant asset slot change as one grant: the principal is live, the pass is at the image epoch and
 * generations the caller read (`lineage`), no transfer is pending, the pre-PUT upload reservation is live and
 * the previous slot is unchanged. The link and image generations advance in the same batch.
 */
export async function replaceAssetGranted(
  ctx: ServiceContext,
  name: string,
  next: AssetRow | null,
  previous: AssetRow | null,
  guard: { pass: Pass; imageGeneration: number; authority: TenantPassWrite; uploadKey?: string },
): Promise<ImageMutationResult> {
  const { pass, authority, imageGeneration, uploadKey } = guard;
  if (
    (next && next.name !== name) ||
    (previous && previous.name !== name) ||
    !permitsPassWrite(authority) ||
    (uploadKey !== undefined && next?.r2Key !== uploadKey) ||
    // Without a reservation the key must already be the slot's own.
    (uploadKey === undefined && next && previous?.r2Key !== next.r2Key)
  )
    return LOST;
  const g = grant(ctx, {
    purpose: 'org_mode.pass.image',
    principal: tenantPrincipal(authority),
    target: pass.id,
    checks: [
      ...capabilityChecks(authority),
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
    codes: { lineage: 'PASS_CONFLICT' },
  });
  const old = previous
    ? {
        r2_key: previous.r2Key,
        sha1: previous.sha1,
        size: previous.size,
        width: previous.width,
        height: previous.height,
        crc32: previous.crc32,
        created_at: previous.createdAt,
      }
    : {};
  const slot = { pass_id: pass.id, name };
  const cols = (a: AssetRow) => ({
    r2_key: a.r2Key,
    sha1: a.sha1,
    size: a.size,
    width: a.width,
    height: a.height,
    crc32: a.crc32,
    created_at: a.createdAt,
  });
  const before = await first<{ id: number | null }>(
    ctx.env.DB,
    'SELECT max(id) AS id FROM pass_transfer_asset_candidates WHERE pass_id = ? AND kind = ? AND slot = ?',
    [pass.id, 'asset', name],
  );
  if (next && previous)
    g.joined('pass_assets', {
      where: { ...slot, ...old },
      set: cols(next),
      returning: ['pass_id'],
    });
  else if (next) {
    const c = cols(next);
    g.insertJoined('pass_assets', {
      parents: { pass_id: pass.id },
      columns: ['name', ...Object.keys(c)],
      values: [name, ...Object.values(c)],
      when: [notExists('pass_assets', slot)],
      returning: ['pass_id'],
    });
  } else
    g.joined('pass_assets', { where: { ...slot, ...old }, delete: true, returning: ['pass_id'] });
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
  if (!previous) return { saved: true, candidateId: null, imageGeneration: image.image_generation };
  const candidate = await first<{ id: number }>(
    ctx.env.DB,
    `SELECT min(id) AS id FROM pass_transfer_asset_candidates
     WHERE pass_id = ? AND kind = 'asset' AND slot = ? AND id > ?`,
    [pass.id, name, before?.id ?? 0],
  );
  if (candidate?.id == null) throw new Error('Missing image rollback candidate.');
  return { saved: true, candidateId: candidate.id, imageGeneration: image.image_generation };
}
