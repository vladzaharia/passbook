import type { Mode } from '../../../shared/contracts/common.ts';
import {
  ENTITLEMENT_KEYS,
  type EntitlementKey,
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
import { TEST_ORG_CAP } from '../join/caps.ts';
import { emailCeiling } from '../settings/inherit.ts';
import { getPlatformSettings } from '../settings/service.ts';
import { isPersonalOrg } from './repo-personal.ts';
import { orgUsage, plansOf } from './repo-usage.ts';

/** Limits the app does not enforce yet: left off the page until it does. */
const NOT_ENFORCED: readonly EntitlementKey[] = ['domains'];

/**
 * The org's plan as its own admins read it: limits with use, the features it can use now, and the footer
 * rule. Values come from `entitlementsOf`, the channel resolver and the platform settings, the sources the
 * gates use, so the page cannot disagree with what the API allows. A feature PassBook has switched off or
 * the plan lacks is left out, and so is a limit whose feature is off.
 */
export async function readOrgPlan(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
): Promise<OrgPlanDto> {
  const [values, usage, plans, blocked, platform, personal] = await Promise.all([
    entitlementsOf(ctx, orgId),
    orgUsage(ctx.env.DB, orgId, ctx.clock.now()),
    plansOf(ctx.env.DB, [orgId]),
    levels(ctx, orgId, mode),
    getPlatformSettings(ctx),
    isPersonalOrg(ctx.env.DB, orgId),
  ]);
  const plan = plans.get(orgId) ?? null;
  const usageOf = usage as Record<string, number>;
  const off = (channel: 'apple' | 'google' | 'samsung' | 'paper' | 'nfc') =>
    blocked.platform[channel] !== undefined || blocked.entitlement?.[channel] !== undefined;
  // A limit of a feature the plan lacks is not shown.
  const parentOn: Partial<Record<EntitlementKey, boolean>> = {
    'webhooks.endpoints': entitledValue('webhooks', values.webhooks),
    'api.keys': entitledValue('api', values.api, 'read'),
    connections: entitledValue('connectors', values.connectors, 'csv-url'),
  };
  // What the platform lets through: the plan's cap, lowered to the platform's maximum.
  const effective = (key: EntitlementKey, plan: number | null): number | null => {
    if (key === 'email.perDay') return emailCeiling(platform, values);
    if (key === 'join.perDay') {
      const cap = mode === 'test' ? TEST_ORG_CAP : platform['join.orgDailyCap'];
      return plan === null ? cap : Math.min(plan, cap);
    }
    if (key === 'members' && personal) return 1;
    return plan;
  };
  const limits: OrgPlanDto['limits'] = [];
  for (const key of ENTITLEMENT_KEYS) {
    if (entitlementDef(key).kind !== 'limit' || NOT_ENFORCED.includes(key)) continue;
    if (parentOn[key] === false) continue;
    if (key === 'join.perDay' && !platform['join.enabled']) continue;
    const planValue = parseEntitlementValue(key, values[key]);
    // A limit of 0 is a feature the plan does not have, and a missing value denies.
    if (planValue === undefined || typeof planValue === 'string' || Array.isArray(planValue))
      continue;
    const limit = effective(key, planValue);
    if (limit === 0) continue;
    limits.push({ key, limit, used: usageOf[key] ?? null });
  }
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
