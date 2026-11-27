import type { SetupGuideInput } from '../../../../shared/contracts/connection-setup.ts';

type Provider = SetupGuideInput['provider'];
type Step = SetupGuideInput['steps'][number];

export const SHOPIFY_PROVIDER: Provider = {
  name: 'Shopify',
  consoleUrl: null,
  docs: [
    {
      label: 'Shopify: webhooks',
      url: 'https://help.shopify.com/en/manual/orders/notifications/webhooks',
    },
    {
      label: 'Shopify: verify a webhook',
      url: 'https://shopify.dev/docs/apps/build/webhooks/subscribe/https',
    },
  ],
};

export const SHOPIFY_SECRET = {
  origin: 'provider',
  allowPaste: true,
  prefix: null,
  minLength: 16,
  whereStep: 'secret',
} as const;

/** Shown at the foot of the Webhooks page; that line is community-sourced (recipes/UNVERIFIED.md). */
export const SHOPIFY_SECRET_STEP: Step = {
  id: 'secret',
  side: 'provider',
  title: 'Copy the signing secret',
  verified: false,
  parts: [
    {
      t: 'text',
      text: 'At the foot of the **Webhooks** page.',
    },
  ],
};

export const SHOPIFY_TEST_STEP: Step = {
  id: 'test',
  side: 'provider',
  title: 'Send a test',
  verified: false,
  parts: [
    { t: 'text', text: 'Open the row menu on the webhook and choose **Send test**.' },
    { t: 'note', text: 'A test is a sample, so it may not issue a pass.' },
  ],
};

export const SHOPIFY_TEST = {
  kind: 'button',
  text: 'Row menu, **Send test**. The sample may not be a real record, so no pass is issued.',
  command: null,
  issues: false,
} as const;

export const SHOPIFY_TROUBLE = {
  none: 'Check the webhook is listed. Shopify deletes one that keeps failing.',
  signature_missing:
    'Shopify sent no signature header. Make sure the webhook was created in Shopify admin.',
  signature_mismatch:
    "The secret isn't the one signing these. Copy it again from the foot of the Webhooks page. Made by an app? Use that app's client secret.",
  payload: 'The body was not JSON. Edit the webhook in Shopify and set **Format** to **JSON**.',
  stale: "Signed correctly. It's a sample, so nothing was issued.",
} as const;
