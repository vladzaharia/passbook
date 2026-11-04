import type { ServiceContext } from '../../platform/service-context.ts';
import { countLivePasses, markBrandingDirty } from './repo-branding.ts';

type Look = { name: string; branding: string };

/** Everything on an org that ends up in a built pass. */
export function passLook(row: Look): string {
  const b = JSON.parse(row.branding) as Record<string, unknown>;
  return JSON.stringify([
    row.name,
    b.logoHasName ?? false,
    b.passColors ?? null,
    b.logo ?? null,
    b.icon ?? null,
  ]);
}

/**
 * Flags the org's live passes for a rebuild when the pass look changed. Returns how many will
 * update, or undefined when none will.
 */
export async function markPassesStale(
  ctx: ServiceContext,
  orgId: string,
  before: Look,
  after: Look,
): Promise<number | undefined> {
  if (passLook(before) === passLook(after)) return undefined;
  const passes = await countLivePasses(ctx.env.DB, orgId);
  if (passes === 0) return undefined;
  await markBrandingDirty(ctx.env.DB, orgId, ctx.clock.now());
  ctx.log.info('org.branding_stale', { orgId, passes });
  return passes;
}
