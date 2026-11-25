import type { EntitlementKey } from '@/shared/contracts/entitlements.ts';
import { parseEntitlementValue } from '@/shared/contracts/entitlements.ts';
import type { OrgPlanDto, PlanFeatureKey } from '@/shared/contracts/org-plan.ts';
import { ENTITLEMENT_LABEL } from '@/shared/copy/entitlements.ts';
import { CHANNEL_CHIP } from '@/shared/copy/plans.ts';
import { type FooterLevel, type NfcLevel, planFacts } from '@/shared/plan-facts.ts';

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
  /** Null is no limit; 0 is none. */
  limit: number | null;
  /** Null where nothing is counted: a plan tile, or a cap with no counter. */
  used: number | null;
  state: 'ok' | 'near' | 'full';
}

/** What a plan shows, whoever's it is: limits, the features it has (named), and the footer rule. */
export interface PlanView {
  limits: LimitRow[];
  features: string[];
  footer: FooterLevel;
}

const stateOf = (limit: number | null, used: number | null): LimitRow['state'] => {
  const share = limit !== null && limit > 0 && used !== null ? used / limit : 0;
  return share >= 1 ? 'full' : share >= NEAR ? 'near' : 'ok';
};

/** The limits a plan tile lists, in this order. */
const TILE_LIMITS = [
  'passes.live',
  'templates',
  'scanning.devices',
  'members',
  'api.keys',
] as const satisfies readonly EntitlementKey[];

/** A channel's name wherever it is listed. Copy-proof NFC is a level above NFC tags, and lists after it. */
function channelNames(f: {
  google: boolean;
  samsung: boolean;
  print: boolean;
  nfc: NfcLevel;
}): string[] {
  return [
    CHANNEL_CHIP.apple,
    ...(f.google ? [CHANNEL_CHIP.google] : []),
    ...(f.samsung ? [CHANNEL_CHIP.samsung] : []),
    ...(f.print ? [CHANNEL_CHIP.print] : []),
    ...(f.nfc === 'off' ? [] : [CHANNEL_CHIP.nfc.basic]),
    ...(f.nfc === 'secure' ? [CHANNEL_CHIP.nfc.secure] : []),
  ];
}

/** A plan from its values (a picker tile): the limits people count, and the channels it includes. */
export function viewOfValues(values: Record<string, unknown>): PlanView {
  const facts = planFacts(values);
  return {
    limits: TILE_LIMITS.map((key) => {
      const v = parseEntitlementValue(key, values[key]);
      const limit = v === null || typeof v === 'number' ? v : 0;
      return { key, label: limitLabel(key), limit, used: null, state: 'ok' as const };
    }),
    features: channelNames(facts),
    footer: facts.footer,
  };
}

const OTHER_FEATURE: Partial<Record<PlanFeatureKey, string>> = {
  api: ENTITLEMENT_LABEL.api,
  apps: ENTITLEMENT_LABEL.apps,
  webhooks: ENTITLEMENT_LABEL.webhooks,
  'templates.uploads': ENTITLEMENT_LABEL['templates.uploads'],
  'identity.own': ENTITLEMENT_LABEL['identity.own'],
  'identity.managed': ENTITLEMENT_LABEL['identity.managed'],
};

/** An organization's plan as the API reports it: every limit with use, and every feature it can use now. */
export function viewOfOrgPlan(plan: OrgPlanDto): PlanView {
  const has = (k: PlanFeatureKey) => plan.features.find((f) => f.key === k);
  const nfc = has('nfc')?.level;
  const channels = channelNames({
    google: has('wallet.google') !== undefined,
    samsung: has('wallet.samsung') !== undefined,
    print: has('print') !== undefined,
    nfc: nfc === 'secure' ? 'secure' : nfc ? 'basic' : 'off',
  }).filter((n) => n !== CHANNEL_CHIP.apple || has('apple') !== undefined);
  const others = plan.features.flatMap((f) => {
    const name = OTHER_FEATURE[f.key];
    if (name === undefined) return [];
    return [f.key === 'api' && f.level === 'read' ? `${name}, read only` : name];
  });
  return {
    limits: plan.limits.map(({ key, limit, used }) => ({
      key,
      label: limitLabel(key),
      limit,
      used,
      state: stateOf(limit, used),
    })),
    features: [...channels, ...others],
    footer: plan.footer,
  };
}

/** The limits at 80% or more, fullest first. */
export const pressedLimits = (view: PlanView): LimitRow[] =>
  view.limits
    .filter((r) => r.state !== 'ok')
    .sort((a, b) => (b.used ?? 0) / (b.limit ?? 1) - (a.used ?? 0) / (a.limit ?? 1));
