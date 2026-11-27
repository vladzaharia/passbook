import { SetupGuideSchema } from '../../../shared/contracts/connection-setup.ts';

/** What the receiving server does with each delivery (docs/api.md "Receive and verify"). */
export const outboundSetup = SetupGuideSchema.parse({
  direction: 'outbound',
  recipe: 'outbound',
  version: '2026-11-27',
  checkedAt: '2026-11-25',
  provider: { name: 'Your server', consoleUrl: null, docs: [] },
  secret: {
    origin: 'passbook',
    allowPaste: false,
    prefix: 'whsec_',
    minLength: 38,
    whereStep: null,
  },
  subscriptions: { perWebhook: 'many', topics: [] },
  steps: [
    {
      id: 'store',
      side: 'provider',
      title: 'Store the secret',
      parts: [{ t: 'field', label: 'Secret', copy: 'secret' }],
    },
    {
      id: 'verify',
      side: 'provider',
      title: 'Verify each request',
      parts: [
        { t: 'field', label: 'Signature header', value: 'x-passbook-signature' },
        { t: 'field', label: 'Timestamp', value: 'x-passbook-timestamp' },
        {
          t: 'text',
          text: 'Sign `{timestamp}.{raw body}` with HMAC-SHA256 and the secret, in hex. Compare it with the `v1=` value in constant time.',
        },
        { t: 'warn', text: 'Use the raw bytes, not re-serialized JSON.' },
        { t: 'text', text: 'Reject a timestamp more than 5 minutes off.' },
      ],
    },
    {
      id: 'answer',
      side: 'provider',
      title: 'Answer fast',
      parts: [{ t: 'text', text: 'Reply 2xx first, then do the work.' }],
    },
  ],
  test: {
    kind: 'send',
    text: 'Send a test from PassBook. Done after one 2xx.',
    command: null,
    issues: false,
  },
  troubleshooting: {
    refused:
      'Your server refused it. Check it verifies with the secret you copied, over the raw body.',
    wrong_path: 'Nothing at that path accepts a POST.',
    redirected: "Redirects aren't followed. Use the final URL.",
    server_error: 'Your server failed. Check its logs for this request id.',
    timeout: 'No answer in time. Answer 2xx first, then do the work.',
    unreachable: "PassBook couldn't reach your server. Check the host, port and certificate.",
  },
});
