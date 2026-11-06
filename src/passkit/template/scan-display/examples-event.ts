/** The event blueprint as shipped and the voided case (DM 8). */

import { CHECK_IN, type ScanExample } from './examples-kit.ts';
import type { ScanDisplayDoc } from './schema.ts';

const ticketPanel = {
  id: 'p_ticket',
  preset: { id: 'ticket' as const, v: 1 },
  title: 'Ticket',
  icon: 'ticket' as const,
  rows: [
    { id: 'r_seat', slot: 'seat', type: 'big' as const, label: 'Seat', value: '{{inputs.seat}}' },
    {
      id: 'r_type',
      slot: 'type',
      type: 'field' as const,
      label: 'Ticket',
      value: '{{inputs.admission}}',
    },
    {
      id: 'r_doors',
      slot: 'doors',
      type: 'field' as const,
      label: 'Doors',
      value: '{{inputs.doorsAt|time}}',
    },
    {
      id: 'r_room',
      slot: 'room',
      type: 'field' as const,
      label: 'Room',
      value: '{{inputs.venueRoom}}',
    },
  ],
};

const eventDisplay: ScanDisplayDoc = {
  v: 1,
  holder: '{{inputs.attendee}}',
  header: {},
  panels: [ticketPanel],
};

export const EVENT_EXAMPLES: ScanExample[] = [
  {
    id: 'event',
    name: 'Event ticket blueprint, as shipped',
    base: 'starter-event-ticket',
    inputs: {},
    fields: [],
    actions: [CHECK_IN],
    sample: { admission: 'General admission', seat: 'Row F, Seat 12' },
    display: eventDisplay,
  },
  {
    id: 'voided',
    name: 'Refused, voided',
    base: 'starter-event-ticket',
    inputs: {},
    fields: [],
    actions: [CHECK_IN],
    sample: { admission: 'General admission', seat: 'Row F, Seat 12' },
    display: {
      ...eventDisplay,
      notes: { refused: 'Send them to the box office, left of the doors.' },
    },
  },
];
