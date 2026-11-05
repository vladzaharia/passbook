import { describe, expect, it } from 'vitest';
import { ScanDisplaySchema } from '../../../shared/contracts/scan-display.ts';
import { SCAN_ICONS } from './icons.ts';
import { ScanDisplayDocSchema } from './schema.ts';

const ids = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

/** DM section 8, the six tiles as data. */
const EXAMPLES: Record<string, unknown> = {
  vip: {
    v: 1,
    holder: '{{inputs.attendee}}',
    variants: [
      {
        id: 'vip',
        name: 'VIP',
        when: { path: 'inputs.tier', eq: 'VIP' },
        header: {
          icon: 'crown',
          chips: [
            { id: 'c_vip', text: 'VIP', tone: 'gold', icon: 'crown' },
            { id: 'c_table', text: 'Table {{inputs.table}}', tone: 'violet' },
          ],
        },
      },
    ],
    header: { subtitle: '{{inputs.admission}}' },
    panels: [
      {
        id: 'p_ticket',
        preset: { id: 'ticket', v: 1 },
        title: 'Ticket',
        icon: 'ticket',
        rows: [
          {
            id: 'r_seat',
            type: 'columns',
            size: 'big',
            items: [
              { id: 'i_sec', label: 'Section', value: '{{inputs.section}}' },
              { id: 'i_row', label: 'Row', value: '{{inputs.row}}' },
              { id: 'i_seat', label: 'Seat', value: '{{inputs.seat}}' },
              { id: 'i_gate', label: 'Gate', value: '{{inputs.gate}}' },
            ],
          },
        ],
      },
      {
        id: 'p_access',
        preset: { id: 'access', v: 1 },
        title: 'Access',
        icon: 'key',
        on: ['ok', 'ready'],
        when: { path: 'inputs.tier', eq: 'VIP' },
        rows: [
          {
            id: 'r_perks',
            type: 'list',
            pair: true,
            items: [
              { id: 'i_lounge', icon: 'armchair', text: 'Lounge', detail: 'Level 2' },
              { id: 'i_dinner', icon: 'utensils', text: 'Dinner', detail: '{{inputs.dietary}}' },
            ],
          },
        ],
      },
    ],
  },
  gym: {
    v: 1,
    photo: { minRole: 'desk' },
    header: {},
    variants: [
      {
        id: 'gold',
        name: 'Gold',
        when: { path: 'inputs.tier', eq: 'Gold' },
        header: { chips: [{ id: 'c_gold', text: 'Gold', tone: 'gold' }] },
      },
      {
        id: 'back',
        name: 'Back',
        when: { path: 'history.visits.total', gte: 1 },
        header: { title: 'Welcome back' },
      },
    ],
    panels: [
      {
        id: 'p_member',
        preset: { id: 'membership', v: 1 },
        rows: [
          {
            id: 'r_dates',
            type: 'columns',
            items: [
              { id: 'i_since', label: 'Member since', value: '{{inputs.since|day}}' },
              { id: 'i_exp', label: 'Expires', value: '{{pass.validUntil|day}}' },
            ],
          },
          {
            id: 'r_visits',
            type: 'columns',
            items: [
              { id: 'i_last', label: 'Last visit', value: '{{history.lastVisit.at|ago}}' },
              { id: 'i_month', label: 'This month', value: '{{history.visits.month}}' },
            ],
          },
        ],
      },
      {
        id: 'p_renew',
        preset: { id: 'note', v: 1 },
        on: ['ready'],
        when: { path: 'pass.validUntil', daysFromNow: { lte: 14 } },
        rows: [
          {
            id: 'r_note',
            type: 'note',
            text: 'Renewal due. Offer the annual plan.',
            tone: 'attention',
          },
        ],
      },
    ],
  },
  coffee: {
    v: 1,
    header: {},
    panels: [
      {
        id: 'p_loyalty',
        preset: { id: 'loyalty', v: 1 },
        title: 'Loyalty',
        icon: 'coffee',
        rows: [
          {
            id: 'r_stamps',
            type: 'progress',
            value: '{{inputs.stamps}}',
            goal: 10,
            reward: 'Free coffee',
            icon: 'coffee',
          },
        ],
      },
    ],
  },
  balance: {
    v: 1,
    currency: '{{inputs.currency}}',
    header: {},
    panels: [
      {
        id: 'p_balance',
        preset: { id: 'balance', v: 1 },
        rows: [
          {
            id: 'r_money',
            type: 'money',
            amount: '{{inputs.balance}}',
            currency: '{{inputs.currency}}',
            lowBelow: 5,
            pending: ['charge', 'top_up'],
          },
          {
            id: 'r_hist',
            type: 'history',
            source: 'value',
            input: 'balance',
            limit: 3,
            show: ['amount', 'when', 'where'],
          },
        ],
      },
    ],
  },
  coupon: {
    v: 1,
    header: { subtitle: '{{inputs.offer}}' },
    panels: [
      {
        id: 'p_offer',
        preset: { id: 'offer', v: 1 },
        rows: [
          { id: 'r_big', type: 'big', value: '{{inputs.offer}}' },
          {
            id: 'r_on',
            type: 'columns',
            items: [
              { id: 'i_on', label: 'On', value: '{{inputs.item}}' },
              { id: 'i_when', label: 'When', value: '{{inputs.when}}' },
            ],
          },
          {
            id: 'r_use',
            type: 'columns',
            items: [
              { id: 'i_left', label: 'Uses left', value: '{{inputs.uses}}' },
              { id: 'i_by', label: 'Use by', value: '{{pass.validUntil|day}}' },
            ],
          },
        ],
      },
    ],
  },
  event: {
    v: 1,
    holder: '{{inputs.attendee}}',
    header: {},
    panels: [
      {
        id: 'p_ticket',
        preset: { id: 'ticket', v: 1 },
        rows: [
          {
            id: 'r_seat',
            type: 'big',
            label: 'Seat',
            value: 'Row {{inputs.row}}, Seat {{inputs.seat}}',
          },
          { id: 'r_admission', type: 'field', label: 'Ticket', value: '{{inputs.admission}}' },
          { id: 'r_doors', type: 'field', label: 'Doors', value: '{{inputs.doors}}' },
          { id: 'r_room', type: 'field', label: 'Room', value: '{{inputs.room}}' },
        ],
      },
    ],
  },
};

const withRow = (row: unknown) => ({
  v: 1,
  header: {},
  panels: [{ id: 'p', rows: [row] }],
});

describe('ScanDisplayDocSchema', () => {
  it.each(Object.keys(EXAMPLES))('parses the %s example', (name) => {
    const result = ScanDisplayDocSchema.safeParse(EXAMPLES[name]);
    expect(result.error?.issues ?? []).toEqual([]);
  });

  it('refuses a columns row with 5 items at its path', () => {
    const items = ids(5, 'i').map((id) => ({ id, label: 'A', value: 'B' }));
    const result = ScanDisplayDocSchema.safeParse(withRow({ id: 'r', type: 'columns', items }));
    expect(result.error?.issues[0]?.path).toEqual(['panels', 0, 'rows', 0, 'items']);
  });

  it('refuses an image with source photo', () => {
    const result = ScanDisplayDocSchema.safeParse(
      withRow({ id: 'r', type: 'image', source: 'photo' }),
    );
    expect(result.success).toBe(false);
  });

  it('refuses an unknown key anywhere', () => {
    const top = ScanDisplayDocSchema.safeParse({ v: 1, header: {}, color: 'red' });
    expect(top.error?.issues[0]?.code).toBe('unrecognized_keys');
    const nested = ScanDisplayDocSchema.safeParse(
      withRow({ id: 'r', type: 'divider', style: 'x' }),
    );
    expect(nested.success).toBe(false);
  });

  it('refuses a verdict icon outside the curated set', () => {
    expect(SCAN_ICONS).toHaveLength(40);
    expect(SCAN_ICONS).not.toContain('check');
    const result = ScanDisplayDocSchema.safeParse({ v: 1, header: { icon: 'check' } });
    expect(result.success).toBe(false);
  });
});

const chip = { id: 'c', text: 'VIP', tone: 'gold', icon: 'crown' } as const;
const base = {
  v: 1,
  templateVersion: 'v7',
  variant: null,
  identity: { holder: 'Anna Meyer', initials: 'AM', photo: null },
  header: { icon: null, title: null, titleLines: 1, meta: 'General admission', chips: [chip] },
  panels: [
    {
      id: 'p_ticket',
      kind: 'ticket',
      title: 'Ticket',
      icon: 'ticket',
      tone: null,
      rows: [
        {
          type: 'columns',
          id: 'r_seat',
          size: 'big',
          oneLine: true,
          items: [
            { label: 'Section', value: '104' },
            { label: 'Row', value: 'F' },
          ],
        },
        { type: 'field', id: 'r_a', label: 'Ticket', value: 'GA', icon: null, strong: false },
        {
          type: 'progress',
          id: 'r_p',
          value: 9,
          goal: 10,
          before: 7,
          style: 'stamps',
          icon: 'coffee',
          rewards: 0,
          caption: '1 more for Free coffee',
        },
        {
          type: 'money',
          id: 'r_m',
          label: null,
          amount: 30.5,
          currency: 'USD',
          text: '$30.50',
          before: 42.5,
          change: -12,
          low: false,
          pending: [],
        },
        { type: 'history', id: 'r_h', items: [], empty: 'No visits yet.' },
        { type: 'note', id: 'r_n', text: 'Hi', tone: 'info', icon: null },
      ],
    },
  ],
  notes: { staff: null, refused: null },
};

describe('ScanDisplaySchema', () => {
  it.each(['ready', 'ok', 'heads_up', 'refused'] as const)(
    'parses a fixture for screen %s',
    (screen) => {
      const fixture =
        screen === 'refused'
          ? { ...base, panels: [], header: { ...base.header, meta: null, chips: [] } }
          : base;
      expect(ScanDisplaySchema.safeParse({ ...fixture, screen }).error?.issues ?? []).toEqual([]);
    },
  );

  it('refuses an icon outside the curated set', () => {
    const bad = { ...base, screen: 'ok', header: { ...base.header, icon: 'check' } };
    expect(ScanDisplaySchema.safeParse(bad).success).toBe(false);
  });
});
