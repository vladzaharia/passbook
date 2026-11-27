import { CHECKED_AT, defineGuide } from './setup-define.ts';

export const woocommerceOrdersSetup = defineGuide({
  direction: 'inbound',
  recipe: 'woocommerce-orders',
  version: '2026-11-26',
  checkedAt: CHECKED_AT,
  provider: {
    name: 'WooCommerce',
    consoleUrl: null,
    docs: [
      { label: 'WooCommerce: webhooks', url: 'https://woocommerce.com/document/webhooks/' },
      {
        label: 'WooCommerce: webhooks API',
        url: 'https://developer.woocommerce.com/docs/apis/rest-api/v3/webhooks/',
      },
    ],
  },
  secret: { origin: 'passbook', allowPaste: true, prefix: null, minLength: 16, whereStep: null },
  subscriptions: {
    perWebhook: 'one',
    topics: [
      { id: 'order.created', label: 'Order created', required: true, verified: true },
      { id: 'order.updated', label: 'Order updated', required: true, verified: true },
    ],
  },
  steps: [
    {
      id: 'connect',
      side: 'provider',
      title: 'Add the webhooks',
      parts: [
        {
          t: 'path',
          items: [
            'WordPress admin',
            'WooCommerce',
            'Settings',
            'Advanced',
            'Webhooks',
            'Add webhook',
          ],
        },
        { t: 'text', text: 'Add one webhook for each topic. Paste the same secret into both.' },
        { t: 'field', label: 'Name', value: 'Anything you will recognise.' },
        { t: 'field', label: 'Status', choose: true, value: 'Active' },
        { t: 'field', label: 'Topic', value: 'One of the topics below.' },
        { t: 'topics' },
        { t: 'field', label: 'Delivery URL', copy: 'endpointUrl' },
        { t: 'field', label: 'Secret', copy: 'secret' },
        { t: 'field', label: 'API Version', choose: true, value: 'Default' },
      ],
    },
    {
      id: 'test',
      side: 'provider',
      title: 'Send a test',
      verified: false,
      parts: [
        { t: 'text', text: 'Saving an **Active** webhook sends a ping.' },
        { t: 'note', text: 'For a real test, place a test order.' },
      ],
    },
  ],
  test: {
    kind: 'ping-on-save',
    text: 'Save an **Active** webhook and WooCommerce pings. The ping is not an order, so no pass is issued. Place a test order to issue one.',
    command: null,
    issues: false,
  },
  troubleshooting: {
    none: 'Check both webhooks say **Active**.',
    signature_missing: 'WooCommerce sent no signature. Check the webhook has a secret.',
    signature_mismatch:
      'Paste the secret into **Secret** on both webhooks again, whole, with no spaces.',
    unknown_type: 'WooCommerce sent a topic this connection does not read. Remove it or ignore it.',
    unrecognized_shape: "Signed correctly, but it isn't an order. Check the topic.",
    ping: 'WooCommerce pinged and the signature held. Place a test order to issue a pass.',
  },
});
