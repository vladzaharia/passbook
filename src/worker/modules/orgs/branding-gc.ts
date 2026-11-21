import type { ServiceContext } from '../../platform/service-context.ts';
import { type BrandingSlot, brandingKey, webLogoKey } from './branding-files.ts';
import {
  claimBrandingKey,
  currentBranding,
  dueBrandingKeys,
  isBrandingKeyQueued,
  queueBrandingKeys,
} from './repo-branding-gc.ts';

type Stored = Partial<Record<BrandingSlot, { storageVersion?: string }>> & {
  web?: { sha?: string };
};

const parse = (json: string): Stored | null => {
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Stored) : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
};

const keysOf = (orgId: string, branding: Stored) => [
  ...(['logo', 'icon'] as const).flatMap((slot) => {
    const image = branding[slot];
    return image
      ? ([3, 2] as const).map((scale) => brandingKey(orgId, slot, scale, image.storageVersion))
      : [];
  }),
  ...(branding.web?.sha ? [webLogoKey(orgId, branding.web.sha)] : []),
];

/** An uploaded web logo whose commit failed: queued, and kept if the org's kit uses it. */
export async function queueWebLogoKey(ctx: ServiceContext, orgId: string, key: string) {
  try {
    await queueBrandingKeys(ctx.env.DB, orgId, [key], ctx.clock.now());
  } catch (error) {
    ctx.log.error('branding.gc_failed', { orgId, code: 'BRANDING_GC_QUEUE', error });
  }
}

/** Superseded objects stay readable this long, for pass builds that started before the commit. */
export const BRANDING_GC_GRACE_MS = 24 * 60 * 60_000;
const SWEEP_BATCH = 100;

/**
 * Queues R2 objects the committed branding no longer references; `sweepBrandingGc` deletes them
 * after the grace period. Call only after the org update committed; a failure leaves an
 * unreferenced object and is logged, never thrown.
 */
export async function collectSupersededBranding(
  ctx: ServiceContext,
  orgId: string,
  previous: string,
  committed: string,
): Promise<void> {
  const [before, after] = [parse(previous), parse(committed)];
  // Unreadable branding on either side could make a live object look stale, so collect nothing.
  if (!before || !after) {
    ctx.log.error('branding.gc_skipped', { orgId, code: 'BRANDING_GC_UNREADABLE' });
    return;
  }
  const live = new Set(keysOf(orgId, after));
  const stale = keysOf(orgId, before).filter((key) => !live.has(key));
  if (stale.length === 0) return;
  try {
    await queueBrandingKeys(ctx.env.DB, orgId, stale, ctx.clock.now());
  } catch (error) {
    ctx.log.error('branding.gc_failed', { orgId, code: 'BRANDING_GC_QUEUE', error });
  }
}

/** Daily cron: deletes queued objects past the grace period that the org's branding still doesn't use. */
export async function sweepBrandingGc(ctx: ServiceContext): Promise<void> {
  const cutoff = ctx.clock.now() - BRANDING_GC_GRACE_MS;
  const due = await dueBrandingKeys(ctx.env.DB, cutoff, SWEEP_BATCH);
  for (const { orgId, key } of due) {
    try {
      // Claimed first, read after: a save that names the key from here on queues it again, and is seen below.
      if (!(await claimBrandingKey(ctx.env.DB, orgId, key, cutoff))) continue;
      const json = await currentBranding(ctx.env.DB, orgId);
      const current = json === null ? {} : parse(json);
      if (!current) {
        // Unreadable current branding: keep the object, and the row for the next sweep.
        ctx.log.error('branding.gc_skipped', { orgId, code: 'BRANDING_GC_UNREADABLE' });
        await queueBrandingKeys(ctx.env.DB, orgId, [key], ctx.clock.now());
        continue;
      }
      if (keysOf(orgId, current).includes(key)) continue;
      if (await isBrandingKeyQueued(ctx.env.DB, orgId, key)) continue;
      try {
        await ctx.env.BUCKET.delete(key);
      } catch (error) {
        // The row was claimed: put it back so the next sweep tries again.
        await queueBrandingKeys(ctx.env.DB, orgId, [key], ctx.clock.now());
        throw error;
      }
    } catch (error) {
      ctx.log.error('branding.gc_failed', { orgId, code: 'BRANDING_GC_FAILED', error });
    }
  }
}
