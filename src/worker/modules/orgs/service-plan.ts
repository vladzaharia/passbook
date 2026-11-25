import {
  ENTITLEMENT_KEYS,
  entitledValue,
  entitlementDef,
  parseEntitlementValue,
} from '../../../shared/contracts/entitlements.ts';
import {
  type OrgPlanDto,
  PLAN_FEATURE_KEYS,
  type PlanFeatureKey,
} from '../../../shared/contracts/org-plan.ts';
import { entitlementsOf } from '../../platform/entitlements.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { levels } from '../channels/service.ts';
import { orgUsage, plansOf } from './repo-usage.ts';

/**
 * The org's plan as its own admins read it: limits with use, the features it can use now, and the footer
 * rule. Values come from `entitlementsOf` and channels from the channel resolver, the sources the gates
 * use, so the page cannot disagree with what the API allows. A feature PassBook has switched off, or
 * the plan lacks, is left out.
 */
export async function readOrgPlan(ctx: ServiceContext, orgId: string): Promise<OrgPlanDto> {
  const [values, usage, plans, blocked] = await Promise.all([
    entitlementsOf(ctx, orgId),
    orgUsage(ctx.env.DB, orgId, ctx.clock.now()),
    plansOf(ctx.env.DB, [orgId]),
    levels(ctx, orgId, 'live'),
  ]);
  const plan = plans.get(orgId) ?? null;
  const usageOf = usage as Record<string, number>;
  const limits: OrgPlanDto['limits'] = [];
  for (const key of ENTITLEMENT_KEYS) {
    if (entitlementDef(key).kind !== 'limit') continue;
    const limit = parseEntitlementValue(key, values[key]);
    // A limit of 0 is a feature the plan does not have, and a missing value denies.
    if (limit === undefined || limit === 0 || typeof limit === 'string' || Array.isArray(limit))
      continue;
    limits.push({ key, limit, used: usageOf[key] ?? null });
  }
  const off = (channel: 'apple' | 'google' | 'samsung' | 'paper' | 'nfc') =>
    blocked.platform[channel] !== undefined || blocked.entitlement[channel] !== undefined;
  const feature = (key: PlanFeatureKey): boolean => {
    switch (key) {
      case 'apple':
        return !off('apple');
      case 'wallet.google':
        return !off('google') && entitledValue(key, values[key]);
      case 'wallet.samsung':
        return !off('samsung') && entitledValue(key, values[key]);
      case 'print':
        return !off('paper') && entitledValue(key, values[key]);
      case 'nfc':
        return !off('nfc') && entitledValue(key, values[key], 'basic');
      case 'api':
        return entitledValue(key, values[key], 'read');
      default:
        return entitledValue(key, values[key]);
    }
  };
  const levelOf = (key: PlanFeatureKey): string | null => {
    const v = key === 'apple' ? undefined : (values as Record<string, unknown>)[key];
    return (key === 'nfc' || key === 'api') && typeof v === 'string' ? v : null;
  };
  const features = PLAN_FEATURE_KEYS.filter(feature).map((key) => ({ key, level: levelOf(key) }));
  const mark = parseEntitlementValue('brand.mark', values['brand.mark']);
  return {
    orgId,
    preset: plan?.preset ?? null,
    label: plan?.label ?? null,
    limits,
    features,
    footer: mark === 'quiet' || mark === 'none' ? mark : 'full',
  };
}
