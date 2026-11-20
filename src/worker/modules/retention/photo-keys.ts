import type { ServiceContext } from '../../platform/service-context.ts';
import { sweepOneTransferAssetGc } from '../passes/transfer-asset-gc.ts';

/**
 * After the rows, receipt and queued deletes committed together: try each object now. A failure is logged;
 * the queue entry stays, so the daily transfer-asset job removes the object.
 */
export async function settlePhotoObjects(
  ctx: ServiceContext,
  keys: readonly { passId: string; key: string }[],
): Promise<void> {
  for (const { key } of keys) {
    try {
      await sweepOneTransferAssetGc(ctx, key);
    } catch (error) {
      ctx.log.error('retention.photo_object_failed', { code: 'RETENTION_PHOTO_OBJECT', error });
    }
  }
}
