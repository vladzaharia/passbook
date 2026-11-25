import { first, ignored, num, obj, type Recipe, record, str } from './shared.ts';
import { idOf, isEvent, one, stripeEvent } from './stripe-shared.ts';

const TYPES = [
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
];

export const stripeSubscriptions: Recipe = {
  id: 'stripe-subscriptions',
  label: 'Stripe subscriptions',
  category: 'commerce',
  verifier: 'stripe',
  topicHeader: null,
  idPrefix: 'stripe',
  windowMs: 0,
  topics: ['checkout.session.completed', ...TYPES.slice(1, 3)],
  pasteSecret: true,
  outputFields: {
    status: { type: 'string' },
    currentPeriodEnd: { type: 'number', description: 'Epoch seconds.' },
    cancelAtPeriodEnd: { type: 'boolean' },
    plan: { type: 'string' },
    customerId: { type: 'string' },
    email: { type: 'string' },
    name: { type: 'string' },
  },
  mapping: {
    status: {
      from: '/status',
      transform: {
        kind: 'enum',
        options: {
          map: {
            active: 'active',
            trialing: 'active',
            past_due: 'overdue',
            unpaid: 'overdue',
            paused: 'paused',
          },
          default: 'inactive',
        },
      },
    },
    expires: {
      from: '/currentPeriodEnd',
      transform: { kind: 'date', options: { input: 'epoch-s', output: 'iso' } },
    },
    tier: { from: '/plan' },
  },
  holderEmailField: '/email',
  voidWhen: [{ from: '/status', op: 'in', values: ['canceled', 'incomplete_expired'] }],
  adapt({ body, config }) {
    const ev = stripeEvent(body, config.acceptTestEvents);
    if (!isEvent(ev)) return ev;
    if (ev.type === 'checkout.session.completed') {
      if (ev.object.mode !== 'subscription') return ignored('unknown_type');
      return one(
        ev,
        idOf(ev.object.subscription),
        record({
          email: str(obj(ev.object.customer_details)?.email),
          name: str(obj(ev.object.customer_details)?.name),
          status: 'active',
          customerId: idOf(ev.object.customer),
        }),
        true,
      );
    }
    if (!TYPES.includes(ev.type)) return ignored('unknown_type');
    const item = first(obj(ev.object.items)?.data);
    const price = obj(item?.price);
    return one(
      ev,
      idOf(ev.object.id),
      record({
        status: str(ev.object.status),
        currentPeriodEnd: num(item?.current_period_end) ?? num(ev.object.current_period_end),
        cancelAtPeriodEnd:
          typeof ev.object.cancel_at_period_end === 'boolean'
            ? ev.object.cancel_at_period_end
            : undefined,
        plan: str(price?.nickname) ?? str(price?.lookup_key) ?? idOf(price?.product),
        customerId: idOf(ev.object.customer),
      }),
      false,
    );
  },
};
