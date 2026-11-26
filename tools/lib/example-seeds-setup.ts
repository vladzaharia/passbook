// Seeds for the webhook setup guides. Same contract as example-seeds.ts: a partial value the sampler fits to the schema.
const GUIDE = {
  direction: 'inbound',
  recipe: 'shopify-customers',
  version: '2026-11-25',
  checkedAt: '2026-11-25',
  provider: {
    name: 'Shopify',
    consoleUrl: null,
    docs: [
      {
        label: 'Shopify: webhooks',
        url: 'https://help.shopify.com/en/manual/orders/notifications/webhooks',
      },
    ],
  },
  secret: {
    origin: 'provider',
    allowPaste: true,
    prefix: null,
    minLength: 16,
    whereStep: 'secret',
  },
  subscriptions: {
    perWebhook: 'one',
    topics: [
      { id: 'customers/create', label: 'Customer creation', required: true, verified: true },
      { id: 'customers/update', label: null, required: true, verified: false },
    ],
  },
  steps: [
    {
      id: 'connect',
      side: 'provider',
      title: 'Add the webhooks',
      parts: [
        { t: 'path', items: ['Settings', 'Notifications', 'Webhooks', 'Create webhook'] },
        { t: 'field', label: 'Format', value: 'JSON', choose: false },
        { t: 'field', label: 'URL', copy: 'endpointUrl', choose: false },
        { t: 'topics' },
      ],
      verified: true,
    },
    {
      id: 'secret',
      side: 'provider',
      title: 'Copy the signing secret',
      parts: [
        {
          t: 'text',
          text: 'Shopify signs every webhook made in admin with one secret for the store.',
        },
      ],
      verified: false,
    },
  ],
  test: {
    kind: 'button',
    text: 'Row menu, **Send test**. The sample may not be a real record, so no pass is issued.',
    command: null,
    issues: false,
  },
  troubleshooting: {
    none: 'Check the webhook is listed. Shopify deletes one that keeps failing.',
    signature_mismatch: "The secret isn't the one signing these. Copy it again.",
  },
};

export const SETUP_SEEDS: Record<string, unknown> = {
  'connectors.getConnectorsWebhookPushRecipesByRecipeSetup response': GUIDE,
  'connections.getConnectionsByIdSetup response': {
    ...GUIDE,
    values: {
      endpointUrl: 'https://passbook.mobile/hooks/connections/0193a1b2-7c00-7000-8000-5c1e2f3a4b6d',
      signatureHeader: null,
      timestampHeader: null,
      hasSecret: true,
    },
  },
  'webhooks.getWebhookEndpointsSetup response': {
    direction: 'outbound',
    recipe: 'outbound',
    version: '2026-11-25',
    checkedAt: '2026-11-25',
    provider: { name: 'Your server', consoleUrl: null, docs: [] },
    secret: {
      origin: 'passbook',
      allowPaste: false,
      prefix: null,
      minLength: 38,
      whereStep: null,
    },
    subscriptions: { perWebhook: 'many', topics: [] },
    steps: [
      {
        id: 'verify',
        side: 'provider',
        title: 'Verify each request',
        parts: [
          { t: 'field', label: 'Signature header', value: 'x-passbook-signature', choose: false },
          { t: 'warn', text: 'Use the raw bytes, not re-serialized JSON.' },
        ],
        verified: true,
      },
    ],
    test: {
      kind: 'send',
      text: 'Send a test from PassBook. Done after one 2xx.',
      command: null,
      issues: false,
    },
    troubleshooting: { timeout: 'No answer in time. Answer 2xx first, then do the work.' },
  },
};
