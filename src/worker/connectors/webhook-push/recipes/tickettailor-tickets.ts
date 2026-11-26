import { ignored, num, obj, type Recipe, record, ref, str } from './shared.ts';
import { tickettailorTicketsSetup } from './tickettailor-tickets.setup.ts';

// Envelope `{ id, created_at, event, resource_url, payload }`, signature, events:
// https://developers.tickettailor.com/docs/webhook/structure and /security and /configuration
// Issued ticket object: https://developers.tickettailor.com/#issued-tickets
const TOPICS = ['ISSUED_TICKET.CREATED', 'ISSUED_TICKET.UPDATED'];

export const tickettailorTickets: Recipe = {
  id: 'tickettailor-tickets',
  label: 'Ticket Tailor tickets',
  category: 'bookings',
  verifier: 'tickettailor',
  topicHeader: null,
  idPrefix: 'tickettailor',
  // The signature header carries the time, so the verifier bounds the replay.
  windowMs: 0,
  topics: TOPICS,
  pasteSecret: true,
  secretOrigin: 'provider',
  secretScope: 'connection',
  line: 'Issued ticket to pass. Voids when voided or refunded.',
  setup: tickettailorTicketsSetup,
  outputFields: {
    ticketId: { type: 'string' },
    orderId: { type: 'string' },
    email: { type: 'string' },
    name: { type: 'string' },
    eventName: { type: 'string' },
    ticketType: { type: 'string' },
    barcode: { type: 'string' },
    status: { type: 'string' },
  },
  mapping: {
    orderNumber: { from: '/orderId' },
    name: { from: '/name' },
    eventName: { from: '/eventName' },
    ticketType: { from: '/ticketType' },
  },
  holderEmailField: '/email',
  voidWhen: [{ from: '/status', op: 'in', values: ['voided'] }],
  adapt({ body }) {
    const o = obj(body);
    const type = str(o?.event);
    const sent = num(o?.created_at);
    const eventId = ref(o?.id);
    const t = obj(o?.payload);
    if (!o || type === null || sent === null || !eventId || !t)
      return ignored('unrecognized_shape');
    // The help article lists lowercase names; the topic list is uppercase. Either spelling is the same event.
    if (!TOPICS.includes(type.toUpperCase())) return ignored('unknown_type');
    const id = ref(t.id);
    if (!id) return ignored('no_ref');
    const status = str(t.status);
    const version = sent * 1000;
    return {
      eventId: `tickettailor:${eventId}`,
      refs: [id],
      records: {
        [id]: record({
          ticketId: id,
          orderId: str(t.order_id),
          email: str(t.email),
          name:
            str(t.full_name) ??
            ([str(t.first_name), str(t.last_name)].filter(Boolean).join(' ') || null),
          eventName: str(obj(t.event_summary)?.name),
          ticketType: str(t.description),
          barcode: str(t.barcode),
          status,
        }),
      },
      versions: { [id]: version },
      createRefs: status === 'valid' ? [id] : [],
    };
  },
};
