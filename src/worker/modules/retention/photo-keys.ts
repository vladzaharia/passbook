import type { ServiceContext } from '../../platform/service-context.ts';
import { retirePassImageObject } from '../passes/asset-service-image-write.ts';
import { stagedCandidateId } from './repo-photo-keys.ts';

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
      const candidate = await stagedCandidateId(ctx.env.DB, passId, key);
      await retirePassImageObject(ctx, key, passId, candidate);
    } catch (error) {
      ctx.log.error('retention.photo_object_failed', { code: 'RETENTION_PHOTO_OBJECT', error });
    }
  }
}
