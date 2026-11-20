import type { JobOf } from '../../jobs/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { sendShortenNotice } from './notify.ts';
import { anchorMac } from './receipts.ts';
import { chainsWithOld, trimChain, trimTarget } from './repo-receipts.ts';
import { sweepClass } from './sweep.ts';

/** Receipts are kept 6 years, then removed oldest-first behind an anchor. */
export const RECEIPT_KEEP_MS = 6 * 365 * 86_400_000;
const TRIM_CHAINS_PER_RUN = 50;
const TRIM_ROWS_PER_CHAIN = 200;

/** Daily hook `retention.receipts`: drops receipts past 6 years, never a chain's newest. */
export async function dailyReceipts(ctx: ServiceContext): Promise<void> {
  const cutoff = ctx.clock.now() - RECEIPT_KEEP_MS;
  let removed = 0;
  for (const chain of await chainsWithOld(ctx.env.DB, cutoff, TRIM_CHAINS_PER_RUN)) {
    const last = await trimTarget(ctx.env.DB, chain, cutoff, TRIM_ROWS_PER_CHAIN);
    if (!last) continue;
    const anchor = { ...chain, ...last };
    removed += await trimChain(ctx.env.DB, {
      ...anchor,
      anchorMac: await anchorMac(ctx.env, anchor),
    });
  }
  if (removed > 0) ctx.log.info('retention.receipts_trimmed', { removed });
}

/** Daily hook `photos.retention`: photos of voided or removed passes past the photos class days, held ones kept. */
export async function dailyPhotos(ctx: ServiceContext): Promise<void> {
  ctx.log.info('photos.retention', { ...(await sweepClass(ctx, 'photos')) });
}

export async function handleRetentionNotice(
  job: JobOf<'retention.notice'>,
  ctx: ServiceContext,
): Promise<void> {
  await sendShortenNotice(ctx, job);
}
