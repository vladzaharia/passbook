import type { z } from 'zod';
import type { OrgOwnEntitlementsSchema } from '../../../shared/contracts/entitlement-admin.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { orgUsage } from './repo-usage.ts';
import { readOrgEntitlements } from './service-entitlements.ts';

type Own = z.infer<typeof OrgOwnEntitlementsSchema>;

/** The org's own admins: what the org has and whether it is the preset's or a custom value. No notes. */
export async function readOwnEntitlements(ctx: ServiceContext, orgId: string): Promise<Own> {
  const full = await readOrgEntitlements(ctx, orgId);
  return {
    orgId,
    preset: full.preset,
    label: full.presetLabel,
    items: full.items.map(({ key, value, source }) => ({ key, value, source })),
    usage: await orgUsage(ctx.env.DB, orgId, ctx.clock.now()),
  };
}
