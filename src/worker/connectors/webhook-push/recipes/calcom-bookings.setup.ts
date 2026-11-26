import { CHECKED_AT, defineGuide } from './setup-define.ts';

const ids = [
  'BOOKING_CREATED',
  'BOOKING_RESCHEDULED',
  'BOOKING_CANCELLED',
  'BOOKING_REQUESTED',
  'BOOKING_REJECTED',
  'BOOKING_PAID',
];

export const calcomBookingsSetup = defineGuide({
  direction: 'inbound',
  recipe: 'calcom-bookings',
  version: '2026-11-25',
  checkedAt: CHECKED_AT,
  provider: {
    name: 'Cal.com',
    consoleUrl: null,
    docs: [{ label: 'Cal.com: webhooks', url: 'https://cal.com/features/webhooks' }],
  },
  secret: { origin: 'passbook', allowPaste: false, prefix: null, minLength: 16, whereStep: null },
  subscriptions: {
    perWebhook: 'many',
    topics: ids.map((id) => ({ id, label: null, required: true, verified: false })),
  },
  steps: [
    {
      id: 'connect',
      side: 'provider',
      title: 'Add the webhook',
      verified: false,
      parts: [
        { t: 'path', items: ['Settings', 'Developer', 'Webhooks', 'New'] },
        { t: 'field', label: 'Subscriber URL', copy: 'endpointUrl' },
        {
          t: 'field',
          label: 'Event triggers',
          choose: true,
          value: 'Leave the defaults on, or keep at least these.',
        },
        { t: 'topics' },
        { t: 'field', label: 'Secret', copy: 'secret' },
        { t: 'field', label: 'Payload template', value: 'Leave it empty.' },
        {
          t: 'note',
          text: 'A webhook on an event type fires for that event type only.',
        },
      ],
    },
    {
      id: 'test',
      side: 'provider',
      title: 'Send a test',
      verified: false,
      parts: [{ t: 'text', text: 'Press **Ping test** at the foot of the form.' }],
    },
  ],
  test: {
    kind: 'button',
    text: 'Press **Ping test** at the foot of the form. A ping is not a booking, so no pass is issued.',
    command: null,
    issues: false,
  },
  troubleshooting: {
    none: 'A webhook on an event type fires only for that event type.',
    signature_missing: 'Cal.com sent no signature. Paste the secret into the webhook.',
    signature_mismatch: 'Paste the secret into the Cal.com webhook again, whole, with no spaces.',
    unknown_type: 'Cal.com sent a trigger this connection does not read. Remove it or ignore it.',
    unrecognized_shape:
      "Signed correctly, but it isn't a booking. Clear the custom payload template.",
    ping: 'Cal.com pinged and the signature held. Make a booking to issue a pass.',
  },
});
