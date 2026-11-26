import type { SetupGuideInput } from '../../../../shared/contracts/connection-setup.ts';

type Step = SetupGuideInput['steps'][number];

export const STRIPE_PROVIDER: SetupGuideInput['provider'] = {
  name: 'Stripe',
  consoleUrl: 'https://dashboard.stripe.com/webhooks',
  docs: [
    { label: 'Stripe: webhooks', url: 'https://docs.stripe.com/webhooks' },
    { label: 'Stripe: Workbench', url: 'https://docs.stripe.com/workbench/overview' },
  ],
};

export const STRIPE_SECRET = {
  origin: 'provider',
  allowPaste: true,
  prefix: 'whsec_',
  minLength: 16,
  whereStep: 'secret',
} as const;

/** The destination steps shared by both Stripe recipes; the events come from `topics`. */
export const STRIPE_CONNECT_STEP: Step = {
  id: 'connect',
  side: 'provider',
  title: 'Create the destination',
  parts: [
    { t: 'path', items: ['Dashboard', 'Workbench', 'Webhooks'] },
    { t: 'text', text: 'Choose **Create an event destination**.' },
    { t: 'field', label: 'Events from', value: 'Your account' },
    { t: 'field', label: 'Payload style', choose: true, value: 'Snapshot' },
    {
      t: 'warn',
      text: "Not **Thin**. PassBook can't read a thin event, so nothing would be issued.",
    },
    { t: 'field', label: 'API version', choose: true, value: 'Account default' },
    { t: 'topics' },
    { t: 'field', label: 'Destination type', value: 'Webhook endpoint' },
    { t: 'field', label: 'Endpoint URL', copy: 'endpointUrl' },
    { t: 'text', text: 'Create the destination.' },
  ],
};

export const STRIPE_SECRET_STEP: Step = {
  id: 'secret',
  side: 'provider',
  title: 'Copy the signing secret',
  parts: [
    {
      t: 'text',
      text: 'Open the destination. Under **Signing secret**, choose **Reveal** and copy `whsec_…`.',
    },
    { t: 'note', text: 'Sandbox and live have different secrets.' },
  ],
};

export const STRIPE_TEST_STEP: Step = {
  id: 'test',
  side: 'provider',
  title: 'Send a test',
  parts: [
    {
      t: 'text',
      text: 'In a **sandbox**, make a destination with its own secret, then run the command in Stripe CLI or Workbench Shell.',
    },
    { t: 'code', lang: 'sh', code: 'stripe trigger checkout.session.completed' },
    { t: 'note', text: 'Live: wait for a real checkout, or resend one from the destination.' },
  ],
};

export const STRIPE_TEST = {
  kind: 'cli',
  text: 'Sandbox: run the command. Live: wait for a real checkout. A sandbox event passes the test, and issues a pass only when Test events is on.',
  command: 'stripe trigger checkout.session.completed',
  issues: false,
} as const;

export const STRIPE_TROUBLE = {
  none: "Check the destination is in the same sandbox or live account you're testing in.",
  signature_mismatch:
    "The secret isn't the one signing these. Copy it again from the destination, under **Signing secret**. Sandbox and live differ.",
  signature_expired: 'The signed time is over 5 minutes off. Check the sending clock.',
  thin_event: 'Stripe sent a thin event. Edit the destination and choose **Snapshot**.',
  test_mode: 'A sandbox event, signed correctly. Turn on Test events to issue from sandbox events.',
} as const;
