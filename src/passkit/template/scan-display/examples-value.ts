/** The coffee, prepaid and coupon examples (DM 8). */
import { type ScanExample, text } from './examples-kit.ts';

export const VALUE_EXAMPLES: ScanExample[] = [
  {
    id: 'coffee',
    name: 'Coffee loyalty stamp',
    base: 'starter-stamp-card',
    standIn: 'starter-store-card',
    inputs: {
      stamps: { type: 'integer', minimum: 0, maximum: 10, default: 0, 'x-label': 'Stamps' },
      reward: text({ 'x-label': 'Reward', default: 'Free coffee' }),
    },
    fields: [],
    actions: [
      {
        id: 'add_stamp',
        label: 'Add stamp',
        kind: 'add',
        input: 'stamps',
        amount: { max: 5, default: 1 },
      },
      {
        id: 'redeem_reward',
        label: 'Redeem reward',
        kind: 'take',
        input: 'stamps',
        amount: 10,
        rewardLabel: 'Free coffee',
      },
    ],
    sample: { holder: 'Maya Lopez', stamps: 9, reward: 'Free coffee' },
    display: {
      v: 1,
      holder: '{{inputs.holder}}',
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
              slot: 'stamps',
              type: 'progress',
              value: '{{inputs.stamps}}',
              reward: '{{inputs.reward}}',
              icon: 'coffee',
            },
          ],
        },
      ],
    },
  },
  {
    id: 'prepaid',
    name: 'Prepaid credit redeem',
    base: 'starter-store-card',
    inputs: {},
    fields: [],
    actions: [
      {
        id: 'charge',
        label: 'Charge',
        kind: 'take',
        input: 'balance',
        amount: { max: 500, presets: [5, 10, 20] },
      },
      {
        id: 'top_up',
        label: 'Top up',
        kind: 'add',
        input: 'balance',
        amount: { max: 500, presets: [10, 25, 50] },
      },
      {
        id: 'set_balance',
        label: 'Set balance',
        kind: 'set',
        input: 'balance',
        minRole: 'manager',
      },
    ],
    sample: { holder: 'Alex Morgan', balance: 42.5, currency: 'USD' },
    display: {
      v: 1,
      holder: '{{inputs.holder}}',
      currency: '{{inputs.currency}}',
      header: {},
      panels: [
        {
          id: 'p_balance',
          preset: { id: 'balance', v: 1 },
          title: 'Balance',
          icon: 'wallet',
          rows: [
            {
              id: 'r_balance',
              slot: 'balance',
              type: 'money',
              amount: '{{inputs.balance}}',
              currency: '{{inputs.currency}}',
              lowBelow: 5,
              pending: ['charge', 'top_up'],
            },
            {
              id: 'r_transactions',
              slot: 'transactions',
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
  },
  {
    id: 'coupon',
    name: 'Coupon redeem',
    base: 'starter-coupon',
    inputs: {
      appliesTo: text({ 'x-label': 'Applies to' }),
      usesLeft: { type: 'integer', minimum: 0, 'x-label': 'Uses left' },
    },
    fields: [],
    actions: [{ id: 'use', label: 'Redeem', kind: 'use_up' }],
    sample: {
      offer: '20% off',
      code: 'SAVE-0001',
      validFor: 'Weekdays',
      appliesTo: 'Any drink',
      usesLeft: 2,
    },
    display: {
      v: 1,
      header: { subtitle: '{{inputs.offer}}' },
      panels: [
        {
          id: 'p_offer',
          preset: { id: 'offer', v: 1 },
          title: 'Offer',
          icon: 'percent',
          rows: [
            { id: 'r_offer', slot: 'offer', type: 'big', value: '{{inputs.offer}}' },
            {
              id: 'r_terms',
              slot: 'terms',
              type: 'columns',
              items: [
                { id: 'i_on', label: 'On', value: '{{inputs.appliesTo}}' },
                { id: 'i_when', label: 'When', value: '{{inputs.validFor}}' },
              ],
            },
            {
              id: 'r_uses',
              slot: 'uses',
              type: 'columns',
              items: [
                { id: 'i_left', label: 'Uses left', value: '{{inputs.usesLeft}}' },
                { id: 'i_by', label: 'Use by', value: '{{pass.validUntil|day}}' },
              ],
            },
          ],
        },
      ],
    },
  },
];
