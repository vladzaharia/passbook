import { all, first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { retirePassImageObject } from '../passes/asset-service-image-write.ts';

/** The R2 keys of the chosen photo rows, read before the rows go. */
export async function photoKeys(
  db: D1Database,
  passIds: readonly string[],
): Promise<{ passId: string; key: string }[]> {
  const rows = await all<{ pass_id: string; r2_key: string }>(
    db,
    'SELECT pass_id, r2_key FROM member_photos WHERE pass_id IN (SELECT value FROM json_each(?))',
    [JSON.stringify(passIds)],
  );
  return rows.map((r) => ({ passId: r.pass_id, key: r.r2_key }));
}

/**
 * After the rows and their receipt committed: queue each object for deletion and try it now. A failure is
 * logged and the durable tombstone retries it, so a photo never outlives its row unseen.
 */
export async function retirePhotoObjects(
  ctx: ServiceContext,
  keys: readonly { passId: string; key: string }[],
): Promise<void> {
  for (const { passId, key } of keys) {
    try {
      // The row's delete trigger staged a rollback candidate; retiring it queues the object for deletion.
      const candidate = await first<{ id: number }>(
        ctx.env.DB,
        'SELECT id FROM pass_transfer_asset_candidates WHERE pass_id = ? AND r2_key = ? ORDER BY id DESC LIMIT 1',
        [passId, key],
      );
      await retirePassImageObject(ctx, key, passId, candidate?.id);
    } catch (error) {
      ctx.log.error('retention.photo_object_failed', { code: 'RETENTION_PHOTO_OBJECT', error });
    }
  }
}
