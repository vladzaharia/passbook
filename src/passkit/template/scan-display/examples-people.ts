/** The VIP and gym examples (DM 8). */
import { CHECK_IN, type ScanExample, text } from './examples-kit.ts';

export const PEOPLE_EXAMPLES: ScanExample[] = [
  {
    id: 'vip',
    name: 'VIP event check-in',
    base: 'starter-event-ticket',
    inputs: {
      section: text({ 'x-label': 'Section' }),
      row: text({ 'x-label': 'Row' }),
      gate: text({ 'x-label': 'Gate' }),
      tier: text({ 'x-label': 'Tier' }),
      table: text({ 'x-label': 'Table' }),
      dietary: text({ 'x-label': 'Dietary' }),
    },
    fields: [],
    actions: [CHECK_IN],
    sample: {
      attendee: 'Anna Meyer',
      admission: 'General admission',
      tier: 'VIP',
      table: '12',
      section: '104',
      row: 'F',
      seat: '12',
      gate: 'C',
      dietary: 'Vegetarian',
    },
    display: {
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
  },
  {
    id: 'gym',
    name: 'Gym member at the desk',
    base: 'starter-generic',
    inputs: { plan: text({ 'x-label': 'Plan' }) },
    fields: [{ group: 'secondaryFields', key: 'plan', label: 'Plan', input: 'plan' }],
    actions: [CHECK_IN],
    sample: { holder: 'Leo Park', tier: 'Standard', plan: 'Annual', since: '2024-03-01T00:00:00Z' },
    scope: { history: { visits: { total: 12, month: 6 }, lastVisit: { at: 1_700_000_000_000 } } },
    display: {
      v: 1,
      holder: '{{inputs.holder}}',
      photo: { minRole: 'desk' },
      header: {},
      variants: [
        {
          id: 'gold',
          name: 'Gold',
          when: { path: 'inputs.tier', eq: 'Plus' },
          header: { chips: [{ id: 'c_gold', text: 'Plus', tone: 'gold' }] },
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
                { id: 'i_since', label: 'Member since', value: '{{inputs.since|date}}' },
                { id: 'i_exp', label: 'Expires', value: '{{pass.validUntil|date}}' },
              ],
            },
            {
              id: 'r_visits',
              type: 'columns',
              items: [
                { id: 'i_last', label: 'Last visit', value: '{{history.lastVisit.at|ago}}' },
                {
                  id: 'i_month',
                  label: 'This month',
                  value: { count: '{{history.visits.month}}', one: '# visit', other: '# visits' },
                },
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
  },
];
