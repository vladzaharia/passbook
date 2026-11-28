import { describe, expect, it } from 'vitest';
import {
  EVENT_PASS_DEFINITION,
  formatCell,
  formatMinor,
  formatOverageCap,
  formatPeriod,
  formatPlanPrice,
  OVERAGE_CAP_LABEL,
} from './format.ts';
import type { LadderPlanId } from './types.ts';
import { LADDER } from './types.ts';
import { CATALOG_V1 } from './v1.ts';

const texts = (label: string): string[] => {
  const r = CATALOG_V1.rows.find((x) => x.label === label);
  if (!r) throw new Error(label);
  return LADDER.map((p: LadderPlanId) => formatCell(CATALOG_V1, p, r.cells[p]));
};
const planOf = (id: string) => {
  const p = CATALOG_V1.plans.find((x) => x.id === id);
  if (!p) throw new Error(id);
  return p;
};

describe('catalog format', () => {
  it('keeps the event pass definition verbatim', () => {
    expect(EVENT_PASS_DEFINITION).toBe(
      'Event pass: a one-time boost for a single event. It adds attendees, scanners, door staff and emails on top of your plan, for up to 10 door days (the days your doors are open for it), then ends on its own.',
    );
  });

  it('names the cap on extras the overage cap', () => {
    expect(OVERAGE_CAP_LABEL).toBe('Overage cap');
    expect(formatOverageCap(14900)).toBe('Overage cap: $149 a month');
  });

  it('formats money', () => {
    expect(formatMinor(3900)).toBe('$39');
    expect(formatMinor(150)).toBe('$1.50');
    expect(formatMinor(250000)).toBe('$2,500');
    expect(formatMinor(300, { cents: true })).toBe('$3.00');
  });

  it('formats periods', () => {
    expect([30, 60, 183, 396, 365, 730, 2555].map(formatPeriod)).toEqual([
      '30 days',
      '60 days',
      '6 months',
      '13 months',
      '1 year',
      '2 years',
      '7 years',
    ]);
  });

  it('formats plan prices', () => {
    expect(formatPlanPrice(planOf('starter'), 'month')).toBe('$39 a month');
    expect(formatPlanPrice(planOf('starter'), 'year')).toBe('$390 a year');
    expect(formatPlanPrice(planOf('trial'), 'month')).toBe('Free');
    expect(formatPlanPrice(planOf('enterprise'), 'month')).toBe('Contact us');
    expect(formatPlanPrice(planOf('legacy'), 'month')).toBeNull();
  });

  it('formats meter rows as the gating table', () => {
    expect(texts('Live passes')).toEqual(['50', '750', '7,500', '20,000', '50,000', '75,000']);
    expect(texts('Extra live passes, per 100')).toEqual([
      'No',
      '$3.00',
      '$1.50',
      '$1.00',
      '$1.00',
      '$1.00',
    ]);
    expect(texts('Extra passes issued, per 100')).toEqual([
      'No',
      '$1.00',
      '$0.70',
      '$0.60',
      '$0.40',
      'About $0.20',
    ]);
    expect(texts('Emails a month')).toEqual([
      '100',
      '5,000',
      '15,000',
      '30,000',
      '150,000',
      'Agreed',
    ]);
    expect(texts('Scans a month, not billed up to').at(-1)).toBe('Agreed');
  });

  it('formats add-on, tier and limit cells', () => {
    expect(texts('NFC tags (cards, fobs, stickers, wristbands)')).toEqual([
      'No',
      'add-on $5 per 50',
      '1,000',
      '5,000',
      '20,000',
      'No limit',
    ]);
    expect(texts('No PassBook footer')).toEqual(['No', 'No', 'add-on $29', 'Yes', 'Yes', 'Yes']);
    expect(texts('Scan history kept').at(-1)).toBe('3 years or as agreed');
    expect(texts('Support')[3]).toBe('Email, 1 day');
    expect(texts('Organizations on one bill, sharing the allowance').at(-1)).toBe(
      'No limit, no fee each',
    );
    expect(texts('Data processing agreement').at(-1)).toBe('Negotiated');
  });
});
