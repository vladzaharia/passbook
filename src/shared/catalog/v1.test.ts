import { describe, expect, it } from 'vitest';
import { PLAN_ICONS, ROW_ICONS } from '../../generated/plan-icons.ts';
import { formatCell } from './format.ts';
import { LADDER, PLAN_IDS, type PlanId } from './types.ts';
import { CATALOG_V1 } from './v1.ts';

const c = CATALOG_V1;
const plan = (id: PlanId) => c.plans.find((p) => p.id === id);
const row = (label: string) => c.rows.find((r) => r.label === label);
const offers = (id: string) => {
  const a = c.addons.find((x) => x.id === id);
  return a && Object.fromEntries(Object.entries(a.plans).map(([p, o]) => [p, o?.priceMinor]));
};

describe('catalog v1', () => {
  it('lists every plan once, in order', () => {
    expect(c.plans.map((p) => p.id)).toEqual([...PLAN_IDS]);
    expect(c.plans.map((p) => p.name)).toEqual([
      'Stub',
      'Admit One',
      'Season Pass',
      'Backstage',
      'All Access',
      'Enterprise',
      'Unlimited',
      'Developer sandbox',
    ]);
  });

  it('prices plans as 42-gating-final.md, Enterprise by quote', () => {
    expect(c.plans.map((p) => p.monthlyMinor)).toEqual([
      0,
      3900,
      14900,
      34900,
      84900,
      null,
      null,
      null,
    ]);
    expect(plan('enterprise')).toMatchObject({
      quoted: true,
      sellable: false,
      quoteFloorMinor: 250000,
    });
    expect(plan('legacy')).toMatchObject({ billable: false, sellable: false, meters: null });
    expect(plan('developer')).toMatchObject({ billable: false, sellable: false, meters: null });
  });

  it('meters live passes, issued passes and emails per plan', () => {
    expect(plan('trial')?.meters?.live_passes).toEqual({ kind: 'hard', included: 50 });
    expect(plan('starter')?.meters?.live_passes).toEqual({
      kind: 'blocks',
      included: 750,
      blockSize: 100,
      blockMinor: 300,
    });
    expect(plan('premium')?.meters?.passes_issued).toMatchObject({
      included: 150000,
      blockMinor: 40,
    });
    expect(plan('business')?.meters?.emails).toMatchObject({
      included: 30000,
      blockSize: 1000,
      blockMinor: 100,
    });
    expect(plan('enterprise')?.meters?.passes_issued).toMatchObject({
      included: 300000,
      blockMinor: 20,
    });
    expect(plan('standard')?.meters?.scans).toEqual({ kind: 'review', upTo: 250000 });
    expect(plan('enterprise')?.meters?.api_calls).toEqual({ kind: 'agreed' });
  });

  it('prices add-ons per plan as gating and §10', () => {
    expect(offers('scanners-5')).toEqual({ starter: 2500, standard: 2500 });
    expect(offers('scanners-50')).toEqual({ business: 2500, premium: 2500 });
    expect(offers('webhook-endpoints-5')).toEqual({
      starter: 1000,
      standard: 1000,
      business: 1000,
      premium: 1000,
    });
    expect(offers('zones-5')).toMatchObject({ starter: 1000 });
    expect(offers('developer-seat')).toEqual({ standard: 1500, business: 1500, premium: 1500 });
    expect(offers('nfc-tags-50')).toEqual({ starter: 500 });
    expect(offers('audit-7y')).toEqual({ business: 9900, premium: 9900 });
    expect(offers('remove-footer')).toEqual({ standard: 2900 });
    expect(c.addons.find((a) => a.id === 'locations-10')).toMatchObject({
      sellable: false,
      listed: false,
    });
    expect(c.addons.every((a) => a.discountable)).toBe(true);
    expect(c.addons.some((a) => /event scanners/i.test(a.name))).toBe(false);
  });

  it('sizes the event pass as §10', () => {
    expect(
      c.eventPass.sizes.map((s) => [s.id, s.priceMinor, s.attendees, s.extraPer100Minor]),
    ).toEqual([
      ['S', 19900, 1000, 1000],
      ['M', 44900, 5000, 400],
      ['L', 84900, 20000, 400],
      ['XL', 199900, 50000, null],
    ]);
    expect(c.eventPass).toMatchObject({
      doorDays: 10,
      doorFeaturesOf: 'business',
      discountable: true,
    });
    expect(c.eventPass.plans).toEqual(['starter', 'standard', 'business', 'premium']);
  });

  it('sets the switches and terms', () => {
    expect(c.switches.autoUp).toEqual({
      on: true,
      listed: false,
      plans: ['starter', 'standard', 'business'],
    });
    expect(c.switches.allAccessUptime.on).toBe(false);
    expect(c.terms.overageCap).toEqual({ default: 'next_plan_price', alertsPct: [50, 80, 100] });
    expect(c.terms.discountClass.pct).toBe(25);
    expect(c.terms.hold).toEqual({ months: 3, undoDays: 7 });
  });

  it('uses only generated icons', () => {
    const keys = [
      ...c.groups.map((g) => g.iconKey),
      ...c.rows.map((r) => r.iconKey),
      ...c.addons.map((a) => a.iconKey),
      c.eventPass.iconKey,
    ];
    expect(keys.filter((k) => !ROW_ICONS[k])).toEqual([]);
    const planKeys = c.plans.flatMap((p) => (p.iconKey ? [p.iconKey] : []));
    expect(planKeys.filter((k) => !PLAN_ICONS[k])).toEqual([]);
  });

  it('maps add-ons to the row icons in pricing/icons/rows/addons.json', () => {
    expect(Object.fromEntries(c.addons.map((a) => [a.id, a.iconKey]))).toEqual({
      'scanners-5': 'scanners',
      'scanners-50': 'scanners',
      'staff-25': 'door-staff-with-pins',
      'members-5': 'team-members',
      'developer-seat': 'developer-seats',
      'templates-5': 'templates',
      'templates-50': 'templates',
      connection: 'connections',
      'webhook-endpoints-5': 'webhook-endpoints',
      'zones-5': 'zones-and-gates',
      'nfc-tags-50': 'nfc-tags-cards-fobs-stickers-wristbands',
      'nfc-tags-1000': 'nfc-tags-cards-fobs-stickers-wristbands',
      'audit-7y': 'audit-log',
      'own-pass-type-id': 'bring-your-own-pass-type-id',
      'managed-pass-type-id': 'managed-pass-type-id-in-your-name',
      'remove-footer': 'no-passbook-footer',
      'capacity-rules': 'entry-rules-capacity-and-auto-tap-out',
      'advanced-roles': 'author-reviewer-publisher-and-integration-roles',
      'copy-proof-nfc': 'copy-proof-nfc-tags',
      'wallet-tap': 'tap-with-the-phone-s-wallet',
      'priority-support': 'priority-support',
      'team-sync': 'add-and-remove-team-members-automatically',
      'extra-org': 'organizations-on-one-bill-sharing-the-allowance',
      'staging-org': 'a-staging-organization',
      'web-address': 'your-own-web-address-for-pass-pages',
      'locations-10': 'locations-with-their-own-staff-and-counts',
    });
  });

  it('has 102 rows in 10 groups, each row in a known group', () => {
    expect(c.rows).toHaveLength(102);
    const groups = new Set(c.groups.map((g) => g.id));
    expect(groups.size).toBe(10);
    expect(c.rows.filter((r) => !groups.has(r.group))).toEqual([]);
    expect(new Set(c.rows.map((r) => r.label)).size).toBe(102);
  });

  it('points add-on cells at add-ons offered on that plan', () => {
    const bad = c.rows.flatMap((r) =>
      LADDER.flatMap((p) => {
        const cell = r.cells[p];
        if (cell.kind !== 'addon') return [];
        return c.addons.find((a) => a.id === cell.addonId)?.plans[p] ? [] : [`${r.label} ${p}`];
      }),
    );
    expect(bad).toEqual([]);
  });

  it('has no coming or arriving states', () => {
    expect(JSON.stringify(c)).not.toMatch(/coming|arriving/i);
    expect(row('Google Wallet')?.listed).toBe(false);
    expect(row('Apple Wallet')?.listed).toBe(true);
  });

  it('shows Stub retention at the platform floors', () => {
    const history = row('Scan history kept')?.cells.trial;
    const audit = row('Audit log')?.cells.trial;
    expect(history && formatCell(c, 'trial', history)).toBe('30 days');
    expect(audit && formatCell(c, 'trial', audit)).toBe('1 year');
  });
});
