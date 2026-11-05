/** Membership, Loyalty and Balance (DM 1.7). */

import { actionsOn, bind, definePreset, firstActionInput } from './presets-kit.ts';
import type { ScanRowDoc } from './schema.ts';
import { actionGoals, inputProps } from './scope.ts';

const slot = (
  name: string,
  accepts: 'text' | 'number' | 'date' | 'history',
  hints: string[],
  optional = true,
) => ({
  name,
  accepts,
  hints,
  optional,
});

export const membership = definePreset({
  id: 'membership',
  v: 1,
  title: 'Membership',
  icon: 'id-card',
  slots: [
    slot('tier', 'text', ['tier', 'level', 'plan', 'membership']),
    slot('since', 'date', ['membersince', 'since', 'joined', 'startdate']),
    slot('expires', 'date', ['expires', 'expiry', 'expirationdate', 'validuntil']),
    slot('visits', 'history', []),
  ],
  make(_manifest, map) {
    const rows: ScanRowDoc[] = [];
    if (map.tier)
      rows.push({
        id: 'r_tier',
        slot: 'tier',
        type: 'chips',
        items: [{ id: 'c_tier', text: bind(map.tier), tone: 'gold' }],
      });
    rows.push({
      id: 'r_dates',
      slot: 'dates',
      type: 'columns',
      items: [
        {
          id: 'i_since',
          label: 'Member since',
          value: map.since ? bind(map.since, 'date') : '{{pass.createdAt|date}}',
        },
        {
          id: 'i_expires',
          label: 'Expires',
          value: map.expires ? bind(map.expires, 'date') : '{{pass.validUntil|date}}',
        },
      ],
    });
    rows.push({
      id: 'r_visits',
      slot: 'visits',
      type: 'columns',
      items: [
        { id: 'i_last', label: 'Last visit', value: '{{history.lastVisit.at|ago}}' },
        {
          id: 'i_month',
          label: 'This month',
          value: { count: '{{history.visits.month}}', one: '# visit', other: '# visits' },
        },
      ],
    });
    return rows;
  },
});

export const loyalty = definePreset({
  id: 'loyalty',
  v: 1,
  title: 'Loyalty',
  icon: 'stamp',
  slots: [
    slot('stamps', 'number', ['stamps', 'stamp', 'punches', 'punch']),
    slot('points', 'number', ['points', 'credits', 'coins']),
    slot('last', 'history', []),
  ],
  make(manifest, map) {
    const props = inputProps(manifest);
    const input =
      map.stamps ?? (map.points ? undefined : (firstActionInput(manifest) ?? undefined));
    const rows: ScanRowDoc[] = [];
    if (input) {
      const taken = actionGoals(manifest)[input];
      rows.push({
        id: 'r_stamps',
        slot: 'stamps',
        type: 'progress',
        value: bind(input),
        // A take action gives the goal; without one the card needs its own.
        ...(taken ? {} : { goal: 10 }),
        ...(taken?.reward ? { reward: taken.reward } : {}),
        icon: 'stamp',
      });
    } else if (map.points) {
      rows.push({
        id: 'r_points',
        slot: 'points',
        type: 'big',
        value: bind(map.points),
        unit: 'points',
      });
    }
    const ledger = input ?? map.points;
    if (ledger && props[ledger] && actionsOn(manifest, ledger, ['add', 'take', 'set']).length > 0)
      rows.push({
        id: 'r_last',
        slot: 'last',
        type: 'history',
        source: 'value',
        input: ledger,
        limit: 2,
        show: ['amount', 'when'],
      });
    if (rows.length === 0)
      rows.push({ id: 'r_stamps', slot: 'stamps', type: 'big', value: '{{pass.statusLabel}}' });
    return rows;
  },
});

export const balance = definePreset({
  id: 'balance',
  v: 1,
  title: 'Balance',
  icon: 'wallet',
  slots: [
    slot('balance', 'number', ['balance', 'credit', 'funds', 'amount']),
    slot('currency', 'text', ['currency', 'currencycode']),
    slot('transactions', 'history', []),
  ],
  make(manifest, map) {
    const input = map.balance ?? firstActionInput(manifest) ?? 'balance';
    const pending = actionsOn(manifest, input, ['take', 'add']).slice(0, 6);
    const rows: ScanRowDoc[] = [
      {
        id: 'r_balance',
        slot: 'balance',
        type: 'money',
        amount: bind(input),
        ...(map.currency ? { currency: bind(map.currency) } : {}),
        ...(pending.length > 0 ? { pending } : {}),
      },
    ];
    if (actionsOn(manifest, input, ['add', 'take', 'set']).length > 0)
      rows.push({
        id: 'r_transactions',
        slot: 'transactions',
        type: 'history',
        source: 'value',
        input,
        limit: 3,
        show: ['amount', 'when', 'where'],
      });
    return rows;
  },
});
