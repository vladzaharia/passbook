import type { EntitlementKey } from '@/shared/contracts/entitlements.ts';
import type { OrgPlanDto, PlanFeatureKey } from '@/shared/contracts/org-plan.ts';
import { ENTITLEMENT_LABEL } from '@/shared/copy/entitlements.ts';
import { CHANNEL_CHIP } from '@/shared/copy/plans.ts';
import type { NfcLevel } from '@/shared/plan-facts.ts';

/** A limit reads as near at this share of its cap. */
export const NEAR = 0.8;

/** Short names for the limits people count; the rest use the feature label. */
const SHORT: Partial<Record<EntitlementKey, string>> = {
  'passes.live': 'Passes',
  'passes.test': 'Test passes',
  'scanning.devices': 'Scanners',
};
export const limitLabel = (key: EntitlementKey): string => SHORT[key] ?? ENTITLEMENT_LABEL[key];

export interface LimitRow {
  key: EntitlementKey;
  label: string;
  /** Null is no limit. */
  limit: number | null;
  /** Null where the plan keeps no count (per-day caps, domains). */
  used: number | null;
  state: 'ok' | 'near' | 'full';
}

export function limitRows(plan: OrgPlanDto): LimitRow[] {
  return plan.limits.map(({ key, limit, used }) => {
    const share = limit !== null && used !== null ? used / limit : 0;
    return {
      key,
      label: limitLabel(key),
      limit,
      used,
      state: share >= 1 ? 'full' : share >= NEAR ? 'near' : 'ok',
    };
  });
}

/** The limits at 80% or more, fullest first. */
export const pressedLimits = (plan: OrgPlanDto): LimitRow[] =>
  limitRows(plan)
    .filter((r) => r.state !== 'ok')
    .sort((a, b) => (b.used ?? 0) / (b.limit ?? 1) - (a.used ?? 0) / (a.limit ?? 1));

const FEATURE_NAME: Record<PlanFeatureKey, string> = {
  apple: 'Apple Wallet',
  'wallet.google': ENTITLEMENT_LABEL['wallet.google'],
  'wallet.samsung': ENTITLEMENT_LABEL['wallet.samsung'],
  print: ENTITLEMENT_LABEL.print,
  nfc: ENTITLEMENT_LABEL.nfc,
  api: ENTITLEMENT_LABEL.api,
  apps: ENTITLEMENT_LABEL.apps,
  webhooks: ENTITLEMENT_LABEL.webhooks,
  'templates.uploads': ENTITLEMENT_LABEL['templates.uploads'],
  'identity.own': ENTITLEMENT_LABEL['identity.own'],
  'identity.managed': ENTITLEMENT_LABEL['identity.managed'],
};

export function featureLabel(f: OrgPlanDto['features'][number]): string {
  if (f.key === 'nfc') return CHANNEL_CHIP.nfc[(f.level ?? 'basic') as NfcLevel];
  if (f.key === 'api' && f.level === 'read') return `${FEATURE_NAME.api}, read only`;
  return FEATURE_NAME[f.key];
}
