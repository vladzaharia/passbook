// The golden vectors of docs/api/webhook-vectors.json, signed by the server's own code (`sign.ts`), so a
// receiver in any language can check its verification against what PassBook really sends.
import type { WebhookVector } from '../../src/shared/webhook-verify.ts';
import { bodyOf, buildEnvelope } from '../../src/worker/modules/webhooks/payload.ts';
import { sampleRow } from '../../src/worker/modules/webhooks/sample-events.ts';
import { requestHeaders, signatureHeader } from '../../src/worker/modules/webhooks/sign.ts';

const SECRET = 'whsec_vector_current_0123456789abcdef';
const PREVIOUS = 'whsec_vector_previous_fedcba987654321';
/** Unix seconds. Every vector is checked at this instant, so none depends on the clock. */
const NOW = 1_795_153_320;
const ORG = 'org_vector';

const event = (type: 'pass.updated' | 'pass.issued', n: number, externalId = 'order-1042') => {
  const row = sampleRow(type, {
    eventId: `0193a2fb-0000-7000-8000-00000000000${n}`,
    orgId: ORG,
    mode: 'test',
    now: (NOW - 2) * 1000,
  });
  return bodyOf(buildEnvelope({ ...row, externalId }));
};

type Draft = Omit<WebhookVector, 'headers' | 'secrets' | 'now'> & {
  secrets?: string[];
  /** Sign with these secrets (default: the current one) at this many seconds before now. */
  signWith?: string[];
  age?: number;
  /** Replaces a header after signing. */
  override?: Record<string, string | null>;
  sign?: string;
};

async function build(d: Draft): Promise<WebhookVector> {
  const at = (NOW - (d.age ?? 2)) * 1000;
  const body = d.sign ?? d.body;
  const headers = await requestHeaders({
    eventId: '0193a2fb-0000-7000-8000-000000000001',
    eventType: 'pass.updated',
    secrets: d.signWith ?? [SECRET],
    nowMs: at,
    body,
  });
  for (const [k, v] of Object.entries(d.override ?? {})) {
    if (v === null) delete headers[k];
    else headers[k] = v;
  }
  const { signWith: _w, age: _a, override: _o, sign: _s, secrets, ...rest } = d;
  return { ...rest, secrets: secrets ?? [SECRET], headers, now: NOW };
}

export async function buildWebhookVectors(): Promise<string> {
  const body = event('pass.updated', 1);
  const pretty = JSON.stringify(JSON.parse(body), null, 2);
  const unicode = event('pass.issued', 2, 'café-☕-42');
  const ms = String((NOW - 2) * 1000);
  const rotated = await signatureHeader([SECRET, PREVIOUS], NOW - 2, body);
  const vectors = await Promise.all<WebhookVector>([
    build({ id: 'valid', title: 'A real pass.updated delivery', body, expect: null, sdk: 'ok' }),
    build({
      id: 'valid-unicode',
      title: 'A body with non-ASCII text',
      body: unicode,
      expect: null,
      sdk: 'ok',
    }),
    build({
      id: 'valid-rotation',
      title: 'Two v1 values while a secret rotates: the current secret matches the first',
      body,
      override: { 'x-passbook-signature': rotated },
      expect: null,
      sdk: 'ok',
    }),
    build({
      id: 'valid-previous-secret',
      title: 'Two v1 values while a secret rotates: the previous secret matches the second',
      body,
      secrets: [PREVIOUS],
      override: { 'x-passbook-signature': rotated },
      expect: null,
      sdk: 'ok',
    }),
    build({
      id: 'reserialized-json',
      title: 'The receiver parsed the body and printed it again',
      body: pretty,
      sign: body,
      expect: { step: 'signature', cause: 'reserialized' },
      sdk: 'mismatch',
    }),
    build({
      id: 'trailing-newline',
      title: 'The receiver added a newline to the body',
      body: `${body}\n`,
      sign: body,
      expect: { step: 'signature', cause: 'whitespace' },
      sdk: 'mismatch',
    }),
    build({
      id: 'secret-with-space',
      title: 'The secret was pasted with a trailing space',
      body,
      secrets: [`${SECRET} `],
      expect: { step: 'signature', cause: 'secret_whitespace' },
      sdk: 'mismatch',
    }),
    build({
      id: 'wrong-secret',
      title: 'Another endpoint’s secret, or the old one after a rotation',
      body,
      secrets: [PREVIOUS],
      expect: { step: 'signature', cause: 'mismatch' },
      sdk: 'mismatch',
    }),
    build({
      id: 'stale-timestamp',
      title: 'Signed 10 minutes ago',
      body,
      age: 600,
      expect: { step: 'timestamp', cause: 'stale' },
      sdk: 'timestamp_out_of_range',
    }),
    build({
      id: 'milliseconds-timestamp',
      title: 'A timestamp in milliseconds',
      body,
      override: { 'x-passbook-timestamp': ms },
      expect: { step: 'timestamp', cause: 'milliseconds' },
      sdk: 'malformed',
    }),
    build({
      id: 'missing-signature',
      title: 'A proxy dropped x-passbook-signature',
      body,
      override: { 'x-passbook-signature': null },
      expect: { step: 'signature', cause: 'missing_signature' },
      sdk: 'missing_header',
    }),
  ]);
  const file = {
    algorithm:
      'HMAC-SHA256 over "<x-passbook-timestamp>.<raw body>", lowercase hex, sent as v1=<hex>',
    toleranceSeconds: 300,
    note: 'Check your verification against every vector. secrets lists the secret to verify with; now is unix seconds. expect is the first failing step and its cause, or null when the request must verify; sdk is what verifyWebhook reports.',
    vectors,
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}
