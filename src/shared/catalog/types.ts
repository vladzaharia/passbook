/** The billing catalog: plans, meters, add-ons, event passes and pricing-page rows. Money is integer cents (USD). */

/** Catalog plan ids, in ladder order. Kept apart from contracts/entitlements on purpose (C2 checks parity). */
export const PLAN_IDS = [
  'trial',
  'starter',
  'standard',
  'business',
  'premium',
  'enterprise',
  'legacy',
  'developer',
] as const;
export type PlanId = (typeof PLAN_IDS)[number];

/** The plans the pricing page compares, lowest first. */
export const LADDER = [
  'trial',
  'starter',
  'standard',
  'business',
  'premium',
  'enterprise',
] as const;
export type LadderPlanId = (typeof LADDER)[number];

export interface CatalogPlan {
  id: PlanId;
  name: string;
  /** Position on the ladder; null for plans off it (Unlimited, Developer sandbox). */
  rank: number | null;
  /** Null when the price is quoted or the plan is never billed. */
  monthlyMinor: number | null;
  annualMinor: number | null;
  /** Bought without a quote. */
  sellable: boolean;
  /** Sold only through a quote and an overlay (Enterprise). */
  quoted: boolean;
  billable: boolean;
  /** Lowest monthly price a quote may reach; internal, never shown publicly. */
  quoteFloorMinor: number | null;
  /** Key into PLAN_ICONS; null when the plan has no icon. */
  iconKey: string | null;
  /** Null when the plan is never billed. */
  meters: Record<MeterId, MeterTerms> | null;
}

/** Billed meters. */
export const BILLED_METERS = ['live_passes', 'passes_issued', 'emails'] as const;
export type BilledMeterId = (typeof BILLED_METERS)[number];
/** Not billed: a review point past which PassBook gets in touch. */
export const SOFT_METERS = ['pass_updates', 'scans', 'api_calls', 'webhook_deliveries'] as const;
export type SoftMeterId = (typeof SOFT_METERS)[number];
export type MeterId = BilledMeterId | SoftMeterId;

export type MeterTerms =
  /** Nothing past `included` (Stub). */
  | { kind: 'hard'; included: number }
  /** Each started block past `included` costs `blockMinor`. */
  | { kind: 'blocks'; included: number; blockSize: number; blockMinor: number }
  /** Soft meter: not billed up to `upTo`. */
  | { kind: 'review'; upTo: number }
  /** Set in the overlay. */
  | { kind: 'agreed' };

export type AddonKind = 'pack' | 'feature' | 'timeboxed' | 'one_off';

/** What an add-on grants: `add` raises a count, `set` raises a level or switch to this value. */
export type AddonGrant = { key: string; add: number } | { key: string; set: number | string };

export interface Addon {
  id: string;
  name: string;
  kind: AddonKind;
  /** Null when nothing gates it (a process such as priority support). */
  grant: AddonGrant | null;
  /** The discount class applies. */
  discountable: boolean;
  /** Sold now; an unsellable add-on is shown but not sold until its feature exists. */
  sellable: boolean;
  /** Shown on the pricing page. */
  listed: boolean;
  /** Priced per unit (each), so it may be bought more than once. */
  perUnit: boolean;
  /** Key into ROW_ICONS. */
  iconKey: string;
  /** Monthly price where it is offered. */
  plans: Partial<Record<PlanId, { priceMinor: number }>>;
}

export const EVENT_PASS_SIZES = ['S', 'M', 'L', 'XL'] as const;
export type EventPassSizeId = (typeof EVENT_PASS_SIZES)[number];

export interface EventPassSize {
  id: EventPassSizeId;
  priceMinor: number;
  attendees: number;
  scanners: number;
  staff: number;
  emails: number;
  /** Per 100 attendees past the size; null when quoted. */
  extraPer100Minor: number | null;
}

export interface EventPassTerms {
  sizes: readonly EventPassSize[];
  doorDays: number;
  plans: readonly PlanId[];
  /** The plan whose door features apply on door days. */
  doorFeaturesOf: PlanId;
  discountable: boolean;
  /** Annual billing never applies to a one-off. */
  annual: false;
  iconKey: string;
}

/** A pricing-page cell. Classes, lowest first: no, add-on, a limited amount, full. */
export type Cell =
  | { kind: 'no' }
  | { kind: 'yes' }
  | { kind: 'addon'; addonId: string }
  | { kind: 'count'; value: number }
  /** A retention or history length. */
  | { kind: 'period'; days: number; orAgreed?: true }
  /** An ordered level with its own words ("Overview", "Email, 1 day"). */
  | { kind: 'tier'; level: number; text: string }
  /** A plan's meter: what it includes, or the price of a block past it. */
  | { kind: 'meter'; meter: MeterId; show: 'included' | 'block'; about?: true }
  | { kind: 'unlimited'; text?: string }
  | { kind: 'agreed'; text?: string };

export interface RowGroup {
  id: string;
  label: string;
  /** Key into ROW_ICONS. */
  iconKey: string;
}

export interface PricingRow {
  group: string;
  label: string;
  /** Key into ROW_ICONS. */
  iconKey: string;
  cells: Record<LadderPlanId, Cell>;
  /** Shown once its feature ships. There is no other state. */
  listed: boolean;
}

export interface UptimeCredit {
  /** Applies when monthly uptime falls below this percentage. */
  belowPct: number;
  /** Credit as a percentage of the month's plan fee. */
  creditPct: number;
}

export interface CatalogSwitches {
  /** An uptime commitment on All Access. */
  allAccessUptime: { on: boolean; uptimePct: number; credits: readonly UptimeCredit[] };
  /** Moves an org that opted in up one plan when usage makes it cheaper (12-autoup.md). */
  autoUp: { on: boolean; listed: boolean; plans: readonly PlanId[] };
}

export interface CatalogTerms {
  /** The overage cap always clamps: new passes pause at it and extras past it are never billed. */
  overageCap: { default: 'next_plan_price'; alertsPct: readonly number[] };
  discountClass: { pct: number; onPlan: true; onAddons: true; onExtras: false; withAnnual: false };
  hold: { months: number; undoDays: number };
}

export interface Catalog {
  version: number;
  currency: 'USD';
  /** In PLAN_IDS order. */
  plans: readonly CatalogPlan[];
  addons: readonly Addon[];
  eventPass: EventPassTerms;
  groups: readonly RowGroup[];
  rows: readonly PricingRow[];
  switches: CatalogSwitches;
  terms: CatalogTerms;
}

/** An entitlement value: a number, a level, or null for no limit. */
export type EntitlementValue = number | string | null;

/** An Enterprise custom plan for one org, based on the catalog's `enterprise` plan (AD7). Immutable once accepted. */
export interface Overlay {
  id: string;
  orgId: string;
  catalogVersion: number;
  basePlan: 'enterprise';
  interval: 'month' | 'year';
  /** Price per interval. */
  priceMinor: number;
  termMonths: number;
  netDays: number;
  meters: Record<MeterId, MeterTerms>;
  includedAddons: readonly { addonId: string; quantity: number }[];
  /** Raises over the enterprise preset, by entitlement key. */
  values: Readonly<Record<string, EntitlementValue>>;
  contract: { uptimePct: number | null; credits: readonly UptimeCredit[]; namedContact: boolean };
  acceptedAt: number | null;
}
