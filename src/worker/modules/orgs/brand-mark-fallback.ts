import type { EntitlementValue } from '../../../shared/contracts/entitlements.ts';
import { OrgBrandingSchema } from '../../../shared/contracts/orgs.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { effectiveMark, marksOf } from './brand-mark.ts';
import { requireOrg } from './service.ts';

/**
 * The org's branding JSON with its footer choice moved to the plan's nearest allowed one, or null when the
 * choice still fits. Runs with the plan change (`after` is the plan it becomes), in the same batch.
 */
export async function brandingAfterPlan(
  ctx: ServiceContext,
  orgId: string,
  after: Partial<Record<string, EntitlementValue>>,
): Promise<string | null> {
  const row = await requireOrg(ctx, orgId);
  const parsed = OrgBrandingSchema.safeParse(JSON.parse(row.branding));
  const chosen = parsed.success ? parsed.data.mark : undefined;
  if (!chosen) return null;
  const fits = effectiveMark(chosen, marksOf(after['brand.mark']));
  return fits === chosen ? null : JSON.stringify({ ...JSON.parse(row.branding), mark: fits });
}
