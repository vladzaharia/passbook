import { describe, expect, it } from 'vitest';
import {
  type ScanDisplay,
  type ScanDisplayRow,
  ScanDisplaySchema,
} from '../../../shared/contracts/scan-display.ts';
import { display, panel } from './display.test-support.ts';

/**
 * The fit test (DM 1.6, plan UI.6). Heights come from BF's measured specs at the compact
 * width, in CSS px; the card has 443 px between its top limit (117) and the dock (560) at
 * 390 x 844. Calibrated on BF's cards: VIP ok = 434, gym ok = 436. DS's `density.ts` is not
 * merged yet; when it is, the header costs below come from it and a failure lowers its
 * capacity, never the type size.
 */
const CARD_MAX = 443;
const GAP = 12;
const BAND = { row: 104, custom: 158, customTwo: 202, headsUp: 160 };

function rowHeight(row: ScanDisplayRow): number {
  switch (row.type) {
    case 'heading':
      return 16;
    case 'field':
      return 22;
    case 'big':
      return (row.label ? 16 : 0) + 32;
    case 'columns': {
      const line = 16 + 2 + (row.size === 'big' ? 32 : 22);
      return row.oneLine ? line : 2 * line + GAP;
    }
    case 'progress':
      return row.style === 'stamps' ? 32 + 10 + 98 + 10 + 20 : 32 + 10 + 12 + 10 + 20;
    case 'money':
      return (row.label ? 16 : 0) + 32 + (row.low ? 16 : 0);
    case 'history':
      return row.items.length * 44;
    case 'image':
      return row.source === 'strip' ? 130 : 56;
    case 'chips':
      return 28;
    case 'list': {
      const lines = row.pair && row.oneLine ? Math.ceil(row.items.length / 2) : row.items.length;
      return lines * 42 + (lines - 1) * GAP;
    }
    case 'note':
      return 20 * (row.text.length > 40 ? 2 : 1) + 16;
    case 'divider':
      return 1;
  }
}

const panelHeight = (rows: ScanDisplayRow[]) =>
  24 + 16 + GAP + rows.reduce((n, r) => n + rowHeight(r), 0) + (rows.length - 1) * GAP;

function cardHeight(d: ScanDisplay, opts: { band: number; chips: boolean; photo?: boolean }) {
  const identity = opts.photo ? 96 : 48 + (opts.chips ? 8 + 28 : 0);
  const panels = d.panels.map((p) => panelHeight(p.rows));
  return opts.band + 14 + 12 + identity + panels.reduce((n, h) => n + GAP + h, 0);
}

const col = (label: string, value: string) => ({ label, value });
const columns = (
  id: string,
  size: 'big' | 'normal',
  oneLine: boolean,
  ...items: [string, string][]
): ScanDisplayRow => ({
  type: 'columns',
  id,
  size,
  oneLine,
  items: items.map(([l, v]) => col(l, v)),
});
const field = (id: string, label: string, value: string): ScanDisplayRow => ({
  type: 'field',
  id,
  label,
  value,
  icon: null,
  strong: false,
});

describe('the six owner examples fit the card at 390 x 844 without scrolling', () => {
  const cases: [string, ScanDisplay, Parameters<typeof cardHeight>[1]][] = [
    [
      'VIP event check-in',
      display([
        panel(
          [
            columns(
              'seat',
              'big',
              true,
              ['Section', '104'],
              ['Row', 'F'],
              ['Seat', '12'],
              ['Gate', 'C'],
            ),
          ],
          {
            title: 'Ticket',
            icon: 'ticket',
          },
        ),
        panel(
          [
            {
              type: 'list',
              id: 'perks',
              pair: true,
              oneLine: true,
              items: [
                { id: 'a', icon: 'armchair', text: 'Lounge', detail: 'Level 2' },
                { id: 'b', icon: 'utensils', text: 'Dinner', detail: 'Vegetarian' },
              ],
            },
          ],
          { title: 'Access', icon: 'key' },
        ),
      ]),
      { band: BAND.row, chips: true },
    ],
    [
      'Gym member (custom title, photo, 3 units)',
      display([
        panel(
          [
            columns('a', 'normal', true, ['Member since', 'Mar 2024'], ['Expires', 'Mar 2027']),
            columns('b', 'normal', true, ['Last visit', '2 days ago'], ['This month', '9']),
          ],
          { title: 'Membership', icon: 'dumbbell' },
        ),
      ]),
      { band: BAND.custom, chips: false, photo: true },
    ],
    [
      'Coffee loyalty stamp',
      display([
        panel(
          [
            {
              type: 'progress',
              id: 's',
              value: 9,
              goal: 10,
              before: 7,
              style: 'stamps',
              icon: 'coffee',
              rewards: 0,
              caption: '1 more for Free coffee',
            },
          ],
          { title: 'Loyalty', icon: 'coffee' },
        ),
      ]),
      { band: BAND.row, chips: false },
    ],
    [
      'Prepaid credit redeem',
      display([
        panel(
          [
            {
              type: 'money',
              id: 'm',
              label: null,
              amount: 30.5,
              currency: 'USD',
              text: '$30.50',
              before: 42.5,
              change: -12,
              low: false,
              pending: [],
            },
            {
              type: 'history',
              id: 'h',
              items: [1, 2, 3].map((n) => ({
                at: n,
                when: 'Today',
                amount: '$5.00',
                delta: null,
                where: 'Desk',
                label: 'Charge',
                elsewhere: false,
              })),
              empty: null,
            },
          ],
          { title: 'Balance', icon: 'wallet' },
        ),
      ]),
      { band: BAND.row, chips: false },
    ],
    [
      'Coupon redeem',
      display([
        panel(
          [
            { type: 'big', id: 'o', label: null, value: '20% off', unit: null, tone: null },
            columns('c1', 'normal', true, ['On', 'Coffee'], ['When', 'Weekdays']),
            columns('c2', 'normal', true, ['Uses left', '3'], ['Use by', 'Dec 31']),
          ],
          { title: 'Offer', icon: 'percent' },
        ),
      ]),
      { band: BAND.row, chips: false },
    ],
    [
      'Event ticket blueprint',
      display([
        panel(
          [
            {
              type: 'big',
              id: 'seat',
              label: null,
              value: 'F · 12',
              unit: null,
              tone: null,
            },
            field('t', 'Ticket', 'General admission'),
            field('d', 'Doors', '7:00 PM'),
            field('r', 'Room', 'Main hall'),
          ],
          { title: 'Ticket', icon: 'ticket' },
        ),
      ]),
      { band: BAND.row, chips: false },
    ],
  ];

  for (const [name, d, opts] of cases) {
    it(name, () => {
      expect(ScanDisplaySchema.safeParse(d).error).toBeUndefined();
      expect(cardHeight(d, opts)).toBeLessThanOrEqual(CARD_MAX);
    });
  }

  it('the model reproduces BF within 2 px (VIP 434, gym 436)', () => {
    const [vip, gym] = cases;
    expect(
      Math.abs(cardHeight(vip?.[1] as ScanDisplay, vip?.[2] as never) - 434),
    ).toBeLessThanOrEqual(2);
    expect(
      Math.abs(cardHeight(gym?.[1] as ScanDisplay, gym?.[2] as never) - 436),
    ).toBeLessThanOrEqual(2);
  });
});
