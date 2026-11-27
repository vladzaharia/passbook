import { CHECKED_AT, defineGuide } from './setup-define.ts';

const SEND = `BODY='{"id":"evt-1","records":[{"ref":"m-001","record":{},"deleted":false}]}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$PASSBOOK_SECRET" -hex | sed 's/^.* //')
curl -X POST "$WEBHOOK_URL" \\
  -H 'content-type: application/json' \\
  -H "x-passbook-timestamp: $TS" \\
  -H "x-passbook-signature: v1=$SIG" \\
  -d "$BODY"`;

/** PassBook's own scheme, the same one outbound webhooks use. */
export const customSetup = defineGuide({
  direction: 'inbound',
  recipe: 'custom',
  version: '2026-11-25',
  checkedAt: CHECKED_AT,
  provider: { name: 'Your system', consoleUrl: null, docs: [] },
  secret: { origin: 'passbook', allowPaste: true, prefix: null, minLength: 16, whereStep: null },
  subscriptions: { perWebhook: 'many', topics: [] },
  steps: [
    {
      id: 'sign',
      side: 'provider',
      title: 'Sign each request',
      parts: [
        { t: 'field', label: 'URL', copy: 'endpointUrl' },
        { t: 'field', label: 'Signature header', copy: 'signatureHeader' },
        { t: 'field', label: 'Timestamp', copy: 'timestampHeader' },
        {
          t: 'text',
          text: 'The timestamp is in seconds. Sign `{timestamp}.{raw body}` with HMAC-SHA256 and the secret, in hex. Send the signature as `v1=<hex>`.',
        },
        { t: 'note', text: 'The time may be 5 minutes behind or 1 minute ahead.' },
        {
          t: 'note',
          text: 'Send JSON of at most 256 KB and 100 records. Each record has a ref and the record.',
        },
      ],
    },
    {
      id: 'send',
      side: 'provider',
      title: 'Send a test',
      parts: [
        { t: 'text', text: 'Set `PASSBOOK_SECRET` and `WEBHOOK_URL`, then run this.' },
        { t: 'code', lang: 'curl', code: SEND },
      ],
    },
  ],
  test: {
    kind: 'snippet',
    text: 'Send a signed record from your system. A valid one issues a pass.',
    command: null,
    issues: true,
  },
  troubleshooting: {
    none: 'Check the URL matches exactly and your system sent a request.',
    signature_missing: 'Send `x-passbook-signature` and `x-passbook-timestamp`.',
    signature_mismatch:
      'Sign `{timestamp}.{raw body}` with the secret from the Secret step, whole, with no spaces.',
    signature_expired: 'The signed time is over 5 minutes off. Check the sending clock.',
    payload: 'Check the payload matches the shape you set in Setup.',
    too_large: 'Over 256 KB. Send fewer records per request.',
    no_secret: 'Save the secret first.',
    unrecognized_shape: 'Signed correctly, but the records are not where Setup says.',
    no_ref: 'Signed correctly, but a record has no id PassBook can use.',
  },
});
