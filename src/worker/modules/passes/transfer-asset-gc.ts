import type { ServiceContext } from '../../platform/service-context.ts';
import {
  acknowledgeRetiredPassAssetKey,
  claimRetiredPassAssetKey,
  deferRetiredPassAssetKey,
  listDueRetiredPassAssetKeys,
  listExpiredPassAssetCandidates,
  recoverExpiredPassAssetCandidate,
} from './repo-transfer-asset-gc.ts';
import {
  listExpiredPassAssetUploads,
  retireExpiredPassAssetUpload,
} from './repo-transfer-asset-upload-gc.ts';

export const TRANSFER_ASSET_GC_BATCH_SIZE = 20;
export const TRANSFER_ASSET_GC_LEASE_MS = 5 * 60_000;
export const TRANSFER_ASSET_GC_RETRY_MS = 60_000;
export const TRANSFER_ASSET_GC_RECHECK_MS = 24 * 60 * 60_000;
/** A deleted key is looked at again this many times, a day apart, before its tombstone settles. */
export const TRANSFER_ASSET_GC_MAX_RECHECKS = 3;
export const TRANSFER_ASSET_UPLOAD_LEASE_MS = 5 * 60_000;
export const TRANSFER_ASSET_STAGE_LEASE_MS = 5 * 60_000;

/** Claim the immutable tombstone before touching R2; never delete on an uncertain D1 claim. */
export async function sweepOneTransferAssetGc(ctx: ServiceContext, key: string): Promise<void> {
  const now = ctx.clock.now();
  const token = ctx.ids.token(16);
  if (
    !(await claimRetiredPassAssetKey(ctx.env.DB, {
      key,
      token,
      now,
      until: now + TRANSFER_ASSET_GC_LEASE_MS,
    }))
  )
    return;
  try {
    await ctx.env.BUCKET.delete(key);
  } catch (error) {
    const failedAt = ctx.clock.now();
    // An R2 timeout can mean either outcome. Both are safe to retry after the lease.
    await deferRetiredPassAssetKey(ctx.env.DB, {
      key,
      token,
      now: failedAt,
      nextAttemptAt: failedAt + TRANSFER_ASSET_GC_RETRY_MS,
    });
    ctx.log.warn('pass.transfer_asset_gc_failed', { code: 'TRANSFER_ASSET_GC_R2', error });
    return;
  }
  const deletedAt = ctx.clock.now();
  await acknowledgeRetiredPassAssetKey(ctx.env.DB, {
    key,
    token,
    now: deletedAt,
    nextAttemptAt: deletedAt + TRANSFER_ASSET_GC_RECHECK_MS,
    maxRechecks: TRANSFER_ASSET_GC_MAX_RECHECKS,
  });
}

/**
 * Bounded, retryable cleanup. A tombstone is revisited a bounded number of times after each deletion because
 * a writer that started before retirement can complete its R2 PUT after a successful deletion or a crash;
 * it then settles.
 */
export async function sweepTransferAssetGc(ctx: ServiceContext): Promise<void> {
  const now = ctx.clock.now();
  const stageCutoff = now - TRANSFER_ASSET_STAGE_LEASE_MS;
  const staleStages = await listExpiredPassAssetCandidates(
    ctx.env.DB,
    stageCutoff,
    TRANSFER_ASSET_GC_BATCH_SIZE,
  );
  for (const candidate of staleStages) {
    try {
      await recoverExpiredPassAssetCandidate(ctx.env.DB, {
        id: candidate.id,
        createdAt: candidate.created_at,
        cutoff: stageCutoff,
        now,
      });
    } catch (error) {
      ctx.log.warn('pass.transfer_asset_gc_failed', { code: 'TRANSFER_ASSET_RECOVERY_D1', error });
    }
  }
  const cutoff = now - TRANSFER_ASSET_UPLOAD_LEASE_MS;
  const abandoned = await listExpiredPassAssetUploads(
    ctx.env.DB,
    cutoff,
    TRANSFER_ASSET_GC_BATCH_SIZE,
  );
  for (const upload of abandoned) {
    try {
      await retireExpiredPassAssetUpload(ctx.env.DB, {
        key: upload.r2_key,
        passId: upload.pass_id,
        createdAt: upload.created_at,
        cutoff,
        now,
      });
    } catch (error) {
      ctx.log.warn('pass.transfer_asset_gc_failed', { code: 'TRANSFER_ASSET_UPLOAD_D1', error });
    }
  }
  const due = await listDueRetiredPassAssetKeys(
    ctx.env.DB,
    ctx.clock.now(),
    TRANSFER_ASSET_GC_BATCH_SIZE,
  );
  for (const { r2_key: key } of due) {
    try {
      await sweepOneTransferAssetGc(ctx, key);
    } catch (error) {
      // A failed/ambiguous claim or acknowledgement leaves the durable row and lease intact.
      ctx.log.warn('pass.transfer_asset_gc_failed', { code: 'TRANSFER_ASSET_GC_D1', error });
    }
  }
}
