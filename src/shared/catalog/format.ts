import type { Catalog, CatalogPlan, Cell, PlanId } from './types.ts';

/** Owner's wording (event-pass-copy.md), shown with the name everywhere. C8 moves it to src/shared/copy/billing.ts. */
export const EVENT_PASS_DEFINITION =
  'Event pass: a one-time boost for a single event. It adds attendees, scanners, door staff and emails on top of your plan, for up to 10 door days (the days your doors are open for it), then ends on its own.';

export const OVERAGE_CAP_LABEL = 'Overage cap';

const num = (n: number): string => n.toLocaleString('en-US');

/** "$39", "$1.50", "$2,500"; `cents` always shows them ("$3.00"). */
export const formatMinor = (minor: number, opts: { cents?: boolean } = {}): string => {
  const whole = minor % 100 === 0 && !opts.cents;
  return `$${(minor / 100).toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  })}`;
};

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** "30 days", "6 months", "1 year". */
export const formatPeriod = (days: number): string => {
  if (days % 365 === 0) return plural(days / 365, 'year');
  if (days < 90) return plural(days, 'day');
  return plural(Math.round((days * 12) / 365), 'month');
};

export const formatOverageCap = (capMinor: number): string =>
  `${OVERAGE_CAP_LABEL}: ${formatMinor(capMinor)} a month`;

export const formatPlanPrice = (p: CatalogPlan, interval: 'month' | 'year'): string | null => {
  if (p.quoted) return 'Contact us';
  const minor = interval === 'month' ? p.monthlyMinor : p.annualMinor;
  if (minor === null) return null;
  return minor === 0 ? 'Free' : `${formatMinor(minor)} a ${interval}`;
};

/** A pricing-page cell as text on one plan's column. */
export const formatCell = (c: Catalog, plan: PlanId, cell: Cell): string => {
  switch (cell.kind) {
    case 'no':
      return 'No';
    case 'yes':
      return 'Yes';
    case 'count':
      return num(cell.value);
    case 'period':
      return `${formatPeriod(cell.days)}${cell.orAgreed ? ' or as agreed' : ''}`;
    case 'tier':
      return cell.text;
    case 'unlimited':
      return cell.text ?? 'No limit';
    case 'agreed':
      return cell.text ?? 'Agreed';
    case 'addon': {
      const a = c.addons.find((x) => x.id === cell.addonId);
      const price = a?.plans[plan]?.priceMinor;
      if (!a || price === undefined) return 'No';
      const g = a.grant;
      const per = a.kind === 'pack' && g && 'add' in g && g.add > 1 ? ` per ${num(g.add)}` : '';
      return `add-on ${formatMinor(price)}${per}`;
    }
    case 'meter': {
      const t = c.plans.find((p) => p.id === plan)?.meters?.[cell.meter];
      if (!t || t.kind === 'agreed') return 'Agreed';
      if (cell.show === 'included') return num(t.kind === 'review' ? t.upTo : t.included);
      if (t.kind !== 'blocks') return 'No';
      const price = formatMinor(t.blockMinor, { cents: true });
      return cell.about ? `About ${price}` : price;
    }
  }
};
