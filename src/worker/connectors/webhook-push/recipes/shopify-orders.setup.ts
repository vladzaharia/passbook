import { CHECKED_AT, defineGuide } from './setup-define.ts';
import {
  SHOPIFY_PROVIDER,
  SHOPIFY_SECRET,
  SHOPIFY_SECRET_STEP,
  SHOPIFY_TEST,
  SHOPIFY_TEST_STEP,
  SHOPIFY_TROUBLE,
} from './shopify.setup-shared.ts';

export const shopifyOrdersSetup = defineGuide({
  direction: 'inbound',
  recipe: 'shopify-orders',
  version: '2026-11-27',
  checkedAt: CHECKED_AT,
  provider: SHOPIFY_PROVIDER,
  secret: SHOPIFY_SECRET,
  subscriptions: {
    perWebhook: 'one',
    topics: [
      { id: 'orders/create', label: 'Order creation', required: true, verified: true },
      { id: 'orders/updated', label: null, required: true, verified: false },
      { id: 'orders/paid', label: null, required: false, verified: false },
      { id: 'orders/cancelled', label: null, required: false, verified: false },
      { id: 'orders/fulfilled', label: null, required: false, verified: false },
    ],
  },
  steps: [
    {
      id: 'connect',
      side: 'provider',
      title: 'Add the webhooks',
      parts: [
        { t: 'path', items: ['Settings', 'Notifications', 'Webhooks', 'Create webhook'] },
        { t: 'text', text: 'Add one webhook for each event. Shopify takes one event per webhook.' },
        { t: 'field', label: 'Event', value: 'One per webhook, from the list below.' },
        { t: 'field', label: 'Format', choose: true, value: 'JSON' },
        { t: 'field', label: 'URL', copy: 'endpointUrl' },
        { t: 'field', label: 'Webhook API version', choose: true, value: 'Latest' },
        { t: 'topics' },
      ],
    },
    SHOPIFY_SECRET_STEP,
    SHOPIFY_TEST_STEP,
  ],
  test: SHOPIFY_TEST,
  troubleshooting: {
    ...SHOPIFY_TROUBLE,
    unknown_type: 'Shopify sent a topic this connection does not read. Remove it or ignore it.',
    unrecognized_shape: "Signed correctly, but it isn't an order. Check the topic.",
  },
});
