import {
  BILLED_METERS,
  type Catalog,
  type CatalogPlan,
  type Cell,
  LADDER,
  type PlanId,
  type PricingRow,
} from './types.ts';

export const RULE_IDS = [
  'extras-never-rise',
  'no-footer-removal-on-admit-one',
  'packs-on-paid-plans',
  'addon-below-next-step',
  'annual-ten-times',
  'features-add-up',
  'auto-up-plans',
] as const;
export type RuleId = (typeof RULE_IDS)[number];

export interface RuleViolation {
  rule: RuleId;
  message: string;
}

/** Limits every paid self-serve plan can raise with a pack. */
export const COUNTABLE_LIMITS = [
  'scanning.devices',
  'scanning.staff',
  'members',
  'members.developers',
  'templates',
  'connections',
  'webhooks.endpoints',
  'scanning.zones',
  'nfc.tags',
] as const;

const PACK_EXEMPT: Partial<Record<PlanId, readonly string[]>> = {
  starter: ['members.developers'],
};

const planOf = (c: Catalog, id: PlanId): CatalogPlan | undefined =>
  c.plans.find((p) => p.id === id);

const ladderPlans = (c: Catalog): CatalogPlan[] =>
  c.plans
    .filter((p): p is CatalogPlan & { rank: number } => p.rank !== null)
    .sort((a, b) => a.rank - b.rank);

const isSelfServe = (p: CatalogPlan): boolean => p.billable && p.sellable && !p.quoted;

const above = (c: Catalog, id: PlanId): CatalogPlan | null => {
  const rank = planOf(c, id)?.rank;
  if (rank === null || rank === undefined) return null;
  return ladderPlans(c).find((p) => (p.rank ?? -1) > rank) ?? null;
};

/** The plan one step up, when it is bought without a quote. */
export const nextPlan = (c: Catalog, id: PlanId): CatalogPlan | null => {
  const next = above(c, id);
  return next && isSelfServe(next) ? next : null;
};

/** The default overage cap: the next plan's monthly price, or the plan's own at the top. */
export const defaultOverageCapMinor = (c: Catalog, id: PlanId): number | null => {
  const p = planOf(c, id);
  if (!p || !isSelfServe(p) || !p.monthlyMinor) return null;
  return nextPlan(c, id)?.monthlyMinor ?? p.monthlyMinor;
};

/** Plans AutoUp may be offered on: paid, self-serve, with a self-serve plan above. */
const autoUpEligible = (c: Catalog): PlanId[] =>
  c.plans
    .filter((p) => isSelfServe(p) && (p.monthlyMinor ?? 0) > 0 && nextPlan(c, p.id))
    .map((p) => p.id);

export const autoUpOffered = (c: Catalog, id: PlanId): boolean =>
  c.switches.autoUp.on && c.switches.autoUp.plans.includes(id);

/** Room below the step up: the next plan's price, or the quote floor above the top plan. */
const stepMinor = (c: Catalog, p: CatalogPlan): number | null => {
  if (p.monthlyMinor === null) return null;
  const next = above(c, p.id);
  const ceiling = next ? (next.quoted ? next.quoteFloorMinor : next.monthlyMinor) : null;
  return ceiling === null ? null : ceiling - p.monthlyMinor;
};

type Rule = (c: Catalog) => string[];

const extrasNeverRise: Rule = (c) =>
  BILLED_METERS.flatMap((m) => {
    const out: string[] = [];
    let prev: { id: PlanId; minor: number; size: number } | null = null;
    for (const p of ladderPlans(c)) {
      const t = p.meters?.[m];
      if (t?.kind !== 'blocks') continue;
      if (prev && t.blockMinor * prev.size > prev.minor * t.blockSize) {
        out.push(`${m}: ${p.id} charges more per unit than ${prev.id}`);
      }
      prev = { id: p.id, minor: t.blockMinor, size: t.blockSize };
    }
    return out;
  });

const noFooterRemovalOnAdmitOne: Rule = (c) =>
  c.addons
    .filter((a) => a.grant?.key === 'brand.mark' && a.plans.starter)
    .map((a) => `${a.id} is offered on starter`);

const packsOnPaidPlans: Rule = (c) =>
  c.plans
    .filter((p) => isSelfServe(p) && (p.monthlyMinor ?? 0) > 0)
    .flatMap((p) =>
      COUNTABLE_LIMITS.filter((key) => !PACK_EXEMPT[p.id]?.includes(key))
        .filter(
          (key) =>
            !c.addons.some(
              (a) => a.kind === 'pack' && a.grant?.key === key && 'add' in a.grant && a.plans[p.id],
            ),
        )
        .map((key) => `${p.id} has no pack for ${key}`),
    );

const addonBelowNextStep: Rule = (c) =>
  c.addons.flatMap((a) =>
    Object.entries(a.plans).flatMap(([id, offer]) => {
      const p = planOf(c, id as PlanId);
      const step = p ? stepMinor(c, p) : null;
      return step !== null && offer && offer.priceMinor >= step
        ? [`${a.id} on ${id} costs as much as the step up`]
        : [];
    }),
  );

const annualTenTimes: Rule = (c) =>
  c.plans
    .filter((p) => p.monthlyMinor !== null && p.annualMinor !== p.monthlyMinor * 10)
    .map((p) => `${p.id} annual is not 10 times monthly`);

/** A cell's class (0 no, 1 add-on, 2 limited, 3 full) and, when limited, what it measures. */
const rank = (
  c: Catalog,
  plan: PlanId,
  cell: Cell,
): { cls: number; kind?: string; v?: number } | null => {
  switch (cell.kind) {
    case 'no':
      return { cls: 0 };
    case 'addon':
      return { cls: 1 };
    case 'yes':
    case 'unlimited':
    case 'agreed':
      return { cls: 3 };
    case 'count':
      return { cls: 2, kind: 'count', v: cell.value };
    case 'period':
      return { cls: 2, kind: 'period', v: cell.days };
    case 'tier':
      return { cls: 2, kind: 'tier', v: cell.level };
    case 'meter': {
      if (cell.show === 'block') return null;
      const t = planOf(c, plan)?.meters?.[cell.meter];
      if (!t || t.kind === 'agreed') return { cls: 3 };
      return { cls: 2, kind: 'meter', v: t.kind === 'review' ? t.upTo : t.included };
    }
  }
};

const rowAddsUp = (c: Catalog, row: PricingRow): string[] => {
  const out: string[] = [];
  let prev: { id: PlanId; cls: number; kind?: string; v?: number } | null = null;
  for (const id of LADDER) {
    const r = rank(c, id, row.cells[id]);
    if (!r) continue;
    const fewer =
      prev &&
      (r.cls < prev.cls ||
        (r.cls === 2 && prev.cls === 2 && (r.kind !== prev.kind || (r.v ?? 0) < (prev.v ?? 0))));
    if (prev && fewer) out.push(`${row.label}: ${id} gives less than ${prev.id}`);
    prev = { id, ...r };
  }
  return out;
};

const featuresAddUp: Rule = (c) => c.rows.flatMap((row) => rowAddsUp(c, row));

const autoUpPlans: Rule = (c) => {
  const want = autoUpEligible(c);
  const have = c.switches.autoUp.plans;
  const same = want.length === have.length && want.every((id) => have.includes(id));
  return same ? [] : [`autoUp is on ${have.join(', ')}; it belongs on ${want.join(', ')}`];
};

export const RULES: Record<RuleId, Rule> = {
  'extras-never-rise': extrasNeverRise,
  'no-footer-removal-on-admit-one': noFooterRemovalOnAdmitOne,
  'packs-on-paid-plans': packsOnPaidPlans,
  'addon-below-next-step': addonBelowNextStep,
  'annual-ten-times': annualTenTimes,
  'features-add-up': featuresAddUp,
  'auto-up-plans': autoUpPlans,
};

export const checkCatalog = (c: Catalog): RuleViolation[] =>
  RULE_IDS.flatMap((rule) => RULES[rule](c).map((message) => ({ rule, message })));
