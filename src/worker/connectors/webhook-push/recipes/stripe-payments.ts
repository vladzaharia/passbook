import { ignored, num, obj, type Recipe, record, str } from './shared.ts';
import { idOf, isEvent, one, stripeEvent } from './stripe-shared.ts';

export const stripePayments: Recipe = {
  id: 'stripe-payments',
  label: 'Stripe payments',
  category: 'commerce',
  verifier: 'stripe',
  topicHeader: null,
  idPrefix: 'stripe',
  windowMs: 0,
  topics: ['checkout.session.completed', 'charge.refunded'],
  pasteSecret: true,
  outputFields: {
    email: { type: 'string' },
    name: { type: 'string' },
    amountTotal: { type: 'number', description: 'Minor units.' },
    currency: { type: 'string' },
    refunded: { type: 'boolean', description: 'True on a full refund only.' },
  },
  mapping: {
    name: { from: '/name' },
    amount: { from: '/amountTotal' },
    currency: { from: '/currency' },
  },
  holderEmailField: '/email',
  voidWhen: [{ from: '/refunded', op: 'in', values: [true] }],
  adapt({ body, config }) {
    const ev = stripeEvent(body, config.acceptTestEvents);
    if (!isEvent(ev)) return ev;
    if (ev.type === 'checkout.session.completed') {
      if (ev.object.mode !== 'payment' || ev.object.payment_status !== 'paid')
        return ignored('unknown_type');
      const details = obj(ev.object.customer_details);
      return one(
        ev,
        idOf(ev.object.payment_intent),
        record({
          email: str(details?.email),
          name: str(details?.name),
          amountTotal: num(ev.object.amount_total),
          currency: str(ev.object.currency),
          refunded: false,
        }),
        true,
      );
    }
    if (ev.type !== 'charge.refunded') return ignored('unknown_type');
    // `refunded` is true only when the whole charge is refunded: a partial refund does not void.
    return one(
      ev,
      idOf(ev.object.payment_intent),
      record({ refunded: ev.object.refunded === true }),
      false,
    );
  },
};
