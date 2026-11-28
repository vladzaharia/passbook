import type { Catalog, CatalogPlan, EventPassTerms, MeterId, MeterTerms, PlanId } from './types.ts';
import { ADDONS_V1 } from './v1-addons.ts';
import { GROUPS_V1, ROWS_V1_A } from './v1-rows.ts';
import { ROWS_V1_B } from './v1-rows-more.ts';

const hard = (included: number): MeterTerms => ({ kind: 'hard', included });
const blocks = (included: number, blockSize: number, blockMinor: number): MeterTerms => ({
  kind: 'blocks',
  included,
  blockSize,
  blockMinor,
});
const review = (upTo: number): MeterTerms => ({ kind: 'review', upTo });
const AGREED: MeterTerms = { kind: 'agreed' };

const meters = (
  live: MeterTerms,
  issued: MeterTerms,
  emails: MeterTerms,
  soft: [number, number, number, number] | null,
): Record<MeterId, MeterTerms> => ({
  live_passes: live,
  passes_issued: issued,
  emails,
  pass_updates: soft ? review(soft[0]) : AGREED,
  scans: soft ? review(soft[1]) : AGREED,
  api_calls: soft ? review(soft[2]) : AGREED,
  webhook_deliveries: soft ? review(soft[3]) : AGREED,
});

const selfServe = (
  id: PlanId,
  name: string,
  rank: number,
  monthlyMinor: number,
  m: Record<MeterId, MeterTerms>,
): CatalogPlan => ({
  id,
  name,
  rank,
  monthlyMinor,
  annualMinor: monthlyMinor * 10,
  sellable: true,
  quoted: false,
  billable: true,
  quoteFloorMinor: null,
  iconKey: id,
  meters: m,
});

const unbilled = (id: PlanId, name: string, iconKey: string | null): CatalogPlan => ({
  id,
  name,
  rank: null,
  monthlyMinor: null,
  annualMinor: null,
  sellable: false,
  quoted: false,
  billable: false,
  quoteFloorMinor: null,
  iconKey,
  meters: null,
});

export const PLANS_V1: readonly CatalogPlan[] = [
  selfServe(
    'trial',
    'Stub',
    0,
    0,
    meters(hard(50), hard(150), hard(100), [2000, 1000, 5000, 1000]),
  ),
  selfServe(
    'starter',
    'Admit One',
    1,
    3900,
    meters(
      blocks(750, 100, 300),
      blocks(5000, 100, 100),
      blocks(5000, 1000, 150),
      [25000, 50000, 50000, 20000],
    ),
  ),
  selfServe(
    'standard',
    'Season Pass',
    2,
    14900,
    meters(
      blocks(7500, 100, 150),
      blocks(15000, 100, 70),
      blocks(15000, 1000, 125),
      [150000, 250000, 400000, 100000],
    ),
  ),
  selfServe(
    'business',
    'Backstage',
    3,
    34900,
    meters(
      blocks(20000, 100, 100),
      blocks(60000, 100, 60),
      blocks(30000, 1000, 100),
      [500000, 1500000, 2500000, 1000000],
    ),
  ),
  selfServe(
    'premium',
    'All Access',
    4,
    84900,
    meters(
      blocks(50000, 100, 100),
      blocks(150000, 100, 40),
      blocks(150000, 1000, 80),
      [1500000, 3000000, 5000000, 3000000],
    ),
  ),
  {
    id: 'enterprise',
    name: 'Enterprise',
    rank: 5,
    monthlyMinor: null,
    annualMinor: null,
    sellable: false,
    quoted: true,
    billable: true,
    quoteFloorMinor: 250000,
    iconKey: 'enterprise',
    meters: meters(
      blocks(75000, 100, 100),
      blocks(300000, 100, 20),
      blocks(150000, 1000, 80),
      null,
    ),
  },
  unbilled('legacy', 'Unlimited', 'legacy'),
  unbilled('developer', 'Developer sandbox', null),
];

export const EVENT_PASS_V1: EventPassTerms = {
  sizes: [
    {
      id: 'S',
      priceMinor: 19900,
      attendees: 1000,
      scanners: 15,
      staff: 25,
      emails: 4000,
      extraPer100Minor: 1000,
    },
    {
      id: 'M',
      priceMinor: 44900,
      attendees: 5000,
      scanners: 40,
      staff: 100,
      emails: 20000,
      extraPer100Minor: 400,
    },
    {
      id: 'L',
      priceMinor: 84900,
      attendees: 20000,
      scanners: 100,
      staff: 250,
      emails: 80000,
      extraPer100Minor: 400,
    },
    {
      id: 'XL',
      priceMinor: 199900,
      attendees: 50000,
      scanners: 250,
      staff: 500,
      emails: 200000,
      extraPer100Minor: null,
    },
  ],
  doorDays: 10,
  plans: ['starter', 'standard', 'business', 'premium'],
  doorFeaturesOf: 'business',
  discountable: true,
  annual: false,
  iconKey: 'several-events-or-dates-on-one-pass',
};

export const CATALOG_V1: Catalog = {
  version: 1,
  currency: 'USD',
  plans: PLANS_V1,
  addons: ADDONS_V1,
  eventPass: EVENT_PASS_V1,
  groups: GROUPS_V1,
  rows: [...ROWS_V1_A, ...ROWS_V1_B],
  switches: {
    allAccessUptime: {
      on: false,
      uptimePct: 99.5,
      credits: [
        { belowPct: 99.5, creditPct: 10 },
        { belowPct: 99.0, creditPct: 25 },
        { belowPct: 95.0, creditPct: 50 },
      ],
    },
    autoUp: { on: true, listed: false, plans: ['starter', 'standard', 'business'] },
  },
  terms: {
    cheapestPlan: true,
    overageCap: { default: 'next_plan_price', alertsPct: [50, 80, 100] },
    discountClass: { pct: 25, onPlan: true, onAddons: true, onExtras: false, withAnnual: false },
    hold: { months: 3, undoDays: 7, onCheapestPlanMonth: false },
  },
};
