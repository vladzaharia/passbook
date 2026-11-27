import { CHECKED_AT, defineGuide } from './setup-define.ts';
import {
  STRIPE_CONNECT_STEP,
  STRIPE_PROVIDER,
  STRIPE_SECRET,
  STRIPE_SECRET_STEP,
  STRIPE_TEST,
  STRIPE_TEST_STEP,
  STRIPE_TROUBLE,
} from './stripe.setup-shared.ts';

export const stripePaymentsSetup = defineGuide({
  direction: 'inbound',
  recipe: 'stripe-payments',
  version: '2026-11-26',
  checkedAt: CHECKED_AT,
  provider: STRIPE_PROVIDER,
  secret: STRIPE_SECRET,
  subscriptions: {
    perWebhook: 'many',
    topics: [
      { id: 'checkout.session.completed', label: null, required: true, verified: true },
      { id: 'charge.refunded', label: null, required: true, verified: true },
    ],
  },
  steps: [STRIPE_CONNECT_STEP, STRIPE_SECRET_STEP, STRIPE_TEST_STEP],
  test: STRIPE_TEST,
  troubleshooting: {
    ...STRIPE_TROUBLE,
    unknown_type: 'Stripe sent an event this connection does not read. Remove it or ignore it.',
    unrecognized_shape: "Signed correctly, but it isn't a payment. Check the event.",
  },
});
