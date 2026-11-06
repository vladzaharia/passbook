/** Ticket, Offer and Access (DM 1.7). */
import { DENSITY, rowUnits } from './density.ts';
import { bind, definePreset, titleCase } from './presets-kit.ts';
import type { ScanRowDoc } from './schema.ts';
import { inputProps } from './scope.ts';

const slot = (name: string, accepts: 'text' | 'number' | 'date', hints: string[]) => ({
  name,
  accepts,
  hints,
  optional: true,
});

const SEAT_PARTS = ['section', 'row', 'seat', 'gate'] as const;

export const ticket = definePreset({
  id: 'ticket',
  v: 1,
  title: 'Ticket',
  icon: 'ticket',
  slots: [
    slot('section', 'text', ['section', 'block', 'zone']),
    slot('row', 'text', ['row']),
    slot('seat', 'text', ['seat']),
    slot('gate', 'text', ['gate', 'entrance', 'door']),
    slot('type', 'text', ['admission', 'tickettype', 'ticket', 'tier']),
    slot('doors', 'date', ['doorsat', 'doors', 'doortime']),
    slot('when', 'date', ['startsat', 'starts', 'start', 'datetime']),
    slot('room', 'text', ['venueroom', 'room', 'hall']),
    slot('admits', 'number', ['admits', 'guests', 'quantity']),
  ],
  make(_manifest, map) {
    const rows: ScanRowDoc[] = [];
    const parts = SEAT_PARTS.filter((name) => map[name]);
    if (parts.length >= 2)
      rows.push({
        id: 'r_seat',
        slot: 'seat',
        type: 'columns',
        size: 'big',
        items: parts.map((name) => ({
          id: `i_${name}`,
          label: titleCase(name),
          value: bind(map[name] as string),
        })),
      });
    else if (parts[0])
      rows.push({
        id: 'r_seat',
        slot: 'seat',
        type: 'big',
        label: titleCase(parts[0]),
        value: bind(map[parts[0]] as string),
      });
    const more: ScanRowDoc[] = [];
    const field = (
      id: string,
      label: string,
      value: string | { count: string; one: string; other: string },
    ) => more.push({ id: `r_${id}`, slot: id, type: 'field', label, value });
    if (map.type) field('type', 'Ticket', bind(map.type));
    if (map.doors) field('doors', 'Doors', bind(map.doors, 'time'));
    else if (map.when) field('when', 'Starts', bind(map.when, 'datetime'));
    if (map.room) field('room', 'Room', bind(map.room));
    if (map.admits)
      field('admits', 'Admits', { count: bind(map.admits), one: 'Admits #', other: 'Admits #' });
    // The factory stops adding fields at the card's row budget.
    for (const row of more) {
      if (rows.reduce((sum, r) => sum + rowUnits(r), 0) + rowUnits(row) > DENSITY.panelRows) break;
      rows.push(row);
    }
    if (rows.length === 0)
      rows.push({
        id: 'r_ticket',
        slot: 'type',
        type: 'field',
        label: 'Ticket',
        value: '{{pass.title}}',
      });
    return rows;
  },
});

export const offer = definePreset({
  id: 'offer',
  v: 1,
  title: 'Offer',
  icon: 'percent',
  slots: [
    slot('offer', 'text', ['offer', 'discount', 'deal']),
    slot('appliesTo', 'text', ['appliesto', 'item', 'product']),
    slot('terms', 'text', ['terms', 'conditions', 'validfor']),
    slot('uses', 'number', ['usesleft', 'uses', 'remaining']),
  ],
  make(_manifest, map) {
    const rows: ScanRowDoc[] = [
      {
        id: 'r_offer',
        slot: 'offer',
        type: 'big',
        value: map.offer ? bind(map.offer) : '{{pass.title}}',
      },
    ];
    if (map.appliesTo && map.terms)
      rows.push({
        id: 'r_terms',
        slot: 'terms',
        type: 'columns',
        items: [
          { id: 'i_on', label: 'On', value: bind(map.appliesTo) },
          { id: 'i_when', label: 'When', value: bind(map.terms) },
        ],
      });
    else if (map.terms)
      rows.push({
        id: 'r_terms',
        slot: 'terms',
        type: 'field',
        label: 'Conditions',
        value: bind(map.terms),
      });
    if (map.uses)
      rows.push({
        id: 'r_uses',
        slot: 'uses',
        type: 'columns',
        items: [
          { id: 'i_left', label: 'Uses left', value: bind(map.uses) },
          { id: 'i_by', label: 'Use by', value: '{{pass.validUntil|day}}' },
        ],
      });
    else
      rows.push({
        id: 'r_uses',
        slot: 'uses',
        type: 'field',
        label: 'Use by',
        value: '{{pass.validUntil|day}}',
      });
    return rows;
  },
});

const PERK_ICONS: [RegExp, 'armchair' | 'utensils' | 'parking' | 'cloakroom' | 'star'][] = [
  [/lounge|vip/i, 'armchair'],
  [/dinner|meal|food/i, 'utensils'],
  [/park/i, 'parking'],
  [/cloak|coat/i, 'cloakroom'],
];

export const access = definePreset({
  id: 'access',
  v: 1,
  title: 'Access',
  icon: 'key',
  slots: [slot('zones', 'text', []), slot('table', 'text', ['table'])],
  make(manifest, map) {
    const perks = Object.entries(inputProps(manifest))
      .filter(([, schema]) => schema.type === 'boolean')
      .slice(0, 4);
    const rows: ScanRowDoc[] = [];
    if (perks.length > 0)
      rows.push({
        id: 'r_zones',
        slot: 'zones',
        type: 'list',
        pair: true,
        items: perks.map(([name, schema]) => ({
          id: `i_${name.toLowerCase().slice(0, 20)}`,
          icon: PERK_ICONS.find(([pattern]) => pattern.test(name))?.[1] ?? 'star',
          text: String(schema['x-label'] ?? titleCase(name)).slice(0, 32),
          when: { path: `inputs.${name}`, eq: true },
        })),
      });
    if (map.table)
      rows.push({
        id: 'r_table',
        slot: 'table',
        type: 'field',
        label: 'Table',
        value: bind(map.table),
      });
    if (rows.length === 0)
      rows.push({
        id: 'r_zones',
        slot: 'zones',
        type: 'list',
        items: [{ id: 'i_access', icon: 'key', text: 'Access' }],
      });
    return rows;
  },
});
