import { CHECKED_AT, defineGuide } from './setup-define.ts';

export const tickettailorTicketsSetup = defineGuide({
  direction: 'inbound',
  recipe: 'tickettailor-tickets',
  version: '2026-11-26',
  checkedAt: CHECKED_AT,
  provider: {
    name: 'Ticket Tailor',
    consoleUrl: 'https://app.tickettailor.com/box-office/webhooks',
    docs: [
      {
        label: 'Ticket Tailor: create a webhook',
        url: 'https://help.tickettailor.com/en/articles/5149215-how-can-i-create-a-webhook',
      },
      {
        label: 'Ticket Tailor: webhook security',
        url: 'https://developers.tickettailor.com/docs/webhook/security/',
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
    perWebhook: 'many',
    topics: [
      {
        id: 'ISSUED_TICKET.CREATED',
        label: 'Issued ticket: Created',
        required: true,
        verified: false,
      },
      {
        id: 'ISSUED_TICKET.UPDATED',
        label: 'Issued ticket: Updated',
        required: true,
        verified: false,
      },
    ],
  },
  steps: [
    {
      id: 'connect',
      side: 'provider',
      title: 'Add the webhook',
      verified: false,
      parts: [
        {
          t: 'path',
          items: ['Box office', 'Settings', 'API', 'Webhooks', 'Create new webhook'],
        },
        { t: 'field', label: 'Events', value: 'Both events below.' },
        { t: 'topics' },
        { t: 'field', label: 'URL', copy: 'endpointUrl' },
        { t: 'note', text: 'If it takes one event each, add a webhook for each.' },
        {
          t: 'warn',
          text: 'Use an API key with customer data access. The events carry the holder.',
        },
      ],
    },
    {
      id: 'secret',
      side: 'provider',
      title: 'Copy the signing secret',
      verified: false,
      parts: [{ t: 'text', text: "Copy the webhook's signing secret from the **Webhooks** page." }],
    },
    {
      id: 'test',
      side: 'provider',
      title: 'Send a test',
      parts: [{ t: 'text', text: 'Issue a free test ticket to yourself.' }],
    },
  ],
  test: {
    kind: 'real-event',
    text: 'Issue a free test ticket to yourself. Ticket Tailor has no test button.',
    command: null,
    issues: true,
  },
  troubleshooting: {
    none: 'Check the webhook is on the **Webhooks** page and set to both issued ticket events.',
    signature_missing: 'Ticket Tailor sent no signature. Check the webhook has a secret.',
    signature_mismatch:
      "The secret isn't the one signing these. Copy it again from the **Webhooks** page, whole.",
    signature_expired: 'The signed time is over 5 minutes off. Check the sending clock.',
    unknown_type:
      'Ticket Tailor sent an event this connection does not read. Remove it or ignore it.',
    unrecognized_shape: "Signed correctly, but it isn't an issued ticket. Check the event.",
  },
});
