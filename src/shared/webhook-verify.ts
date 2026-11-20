/**
 * The Verify steps of the webhook tester, run in the browser on a captured request and in tests on
 * `docs/api/webhook-vectors.json`. The rule is the server's (`connectors/lib/hmac.ts`) and the SDK's
 * (`verifyWebhook`): HMAC-SHA256 over `<timestamp>.<raw body>`, hex, sent as `v1=<hex>`, one value per live
 * secret, with the timestamp in unix seconds within 5 minutes of now.
 */
export const TOLERANCE_SECONDS = 300;

export type VerifyStepId = 'timestamp' | 'string' | 'signature';
/** Why a step failed: each has one fix sentence. */
export type VerifyCause =
  | 'missing_timestamp'
  | 'milliseconds'
  | 'malformed_timestamp'
  | 'stale'
  | 'empty_body'
  | 'missing_signature'
  | 'reserialized'
  | 'whitespace'
  | 'secret_whitespace'
  | 'mismatch';

export interface VerifyStep {
  id: VerifyStepId;
  ok: boolean;
  title: string;
  /** What was checked: the values, never the secret. */
  detail: string;
  /** One sentence; null when the step passes. */
  fix: string | null;
  cause: VerifyCause | null;
}

export interface VerifyInput {
  /** The request headers, any case. */
  headers: Readonly<Record<string, string>>;
  /** The raw body: what the receiver read before parsing. */
  body: string;
  /** The endpoint's signing secret, or every live one while a rotation overlaps. */
  secrets: readonly string[];
  /** Unix seconds. */
  now: number;
}

const FIXES: Record<VerifyCause, string> = {
  missing_timestamp: 'Read x-passbook-timestamp from the request headers; it is missing here.',
  milliseconds:
    'The timestamp is in milliseconds; PassBook sends unix seconds, so use the header as is.',
  malformed_timestamp:
    'The timestamp is not a number of seconds; use the x-passbook-timestamp value unchanged.',
  stale:
    'Check your clock: a request signed more than 5 minutes ago or ahead is refused as a replay.',
  empty_body: 'Read the raw request body before anything parses it; it is empty here.',
  missing_signature:
    'Read x-passbook-signature from the request headers; it is missing or not v1=<64 hex>.',
  reserialized: 'You signed re-serialized JSON; sign the raw request body, before parsing.',
  whitespace: 'The body has changed whitespace; sign the raw bytes exactly as received.',
  secret_whitespace: 'The secret has spaces or a newline around it; paste it without them.',
  mismatch:
    "The secret is not this endpoint's current one; use the current secret, or the previous one while a rotation overlaps.",
};

const encoder = new TextEncoder();
const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

/** `v1=<hex>` over `<timestamp>.<body>`, as the server signs it. */
export async function sign(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return `v1=${hex(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${body}`)))}`;
}

const header = (h: VerifyInput['headers'], name: string): string | undefined =>
  Object.entries(h).find(([k]) => k.toLowerCase() === name)?.[1];

const short = (v: string) => (v.length > 20 ? `${v.slice(0, 11)}…${v.slice(-8)}` : v);

/** Pretty and compact forms of the same JSON: what a framework's parse and stringify gives back. */
function reserialized(body: string): string[] {
  try {
    const value: unknown = JSON.parse(body);
    return [JSON.stringify(value), JSON.stringify(value, null, 2)].filter((v) => v !== body);
  } catch {
    return [];
  }
}

/** Timestamp, string to sign, signature: in this order, each with one fix when it fails. */
export async function verifySteps(input: VerifyInput): Promise<VerifyStep[]> {
  const ts = header(input.headers, 'x-passbook-timestamp');
  const received = (header(input.headers, 'x-passbook-signature') ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => /^v1=[0-9a-f]{64}$/.test(p));
  const step = (
    id: VerifyStepId,
    title: string,
    cause: VerifyCause | null,
    detail: string,
  ): VerifyStep => ({
    id,
    ok: cause === null,
    title,
    detail,
    fix: cause === null ? null : FIXES[cause],
    cause,
  });

  let tsCause: VerifyCause | null = null;
  if (ts === undefined || ts === '') tsCause = 'missing_timestamp';
  else if (/^\d{13}$/.test(ts)) tsCause = 'milliseconds';
  else if (!/^\d{9,12}$/.test(ts)) tsCause = 'malformed_timestamp';
  else if (Math.abs(input.now - Number(ts)) > TOLERANCE_SECONDS) tsCause = 'stale';
  const skew =
    ts === undefined || tsCause === 'malformed_timestamp' ? null : input.now - Number(ts);
  const timestamp = step(
    'timestamp',
    tsCause === null
      ? 'Timestamp is recent'
      : tsCause === 'stale'
        ? 'Timestamp is out of range'
        : 'Timestamp is not usable',
    tsCause,
    `t=${ts ?? 'missing'}${skew === null || tsCause === 'milliseconds' ? '' : ` · ${Math.abs(skew)} s ${skew < 0 ? 'ahead' : 'ago'}`} · limit 5 min`,
  );

  const text = `${ts ?? ''}.${input.body}`;
  const string = step(
    'string',
    'String to sign',
    input.body === '' ? 'empty_body' : null,
    text.length > 120 ? `${text.slice(0, 80)}…${text.slice(-30)}` : text,
  );

  let cause: VerifyCause | null = null;
  let expected = '';
  if (received.length === 0) cause = 'missing_signature';
  else {
    const check = async (secret: string, body: string) => {
      const mac = await sign(secret, ts ?? '', body);
      return { mac, ok: received.includes(mac) };
    };
    const results = await Promise.all(input.secrets.map((s) => check(s, input.body)));
    expected = results[0]?.mac ?? '';
    if (!results.some((r) => r.ok)) {
      cause = 'mismatch';
      const tries: [VerifyCause, string, string][] = [];
      for (const s of input.secrets) {
        if (s.trim() !== s) tries.push(['secret_whitespace', s.trim(), input.body]);
        for (const b of [input.body.trim(), input.body.replace(/\r\n/g, '\n')])
          if (b !== input.body) tries.push(['whitespace', s, b]);
        for (const b of reserialized(input.body)) tries.push(['reserialized', s, b]);
      }
      for (const [why, secret, body] of tries) {
        if ((await check(secret, body)).ok) {
          cause = why;
          break;
        }
      }
    }
  }
  const signature = step(
    'signature',
    cause === null ? 'Signature matches' : 'Signature does not match',
    cause,
    cause === null
      ? `${short(expected)} expected and received`
      : `expected ${short(expected || 'v1=…')} · received ${short(received[0] ?? 'none')}`,
  );
  return [timestamp, string, signature];
}

export interface WebhookVector {
  id: string;
  title: string;
  secrets: string[];
  headers: Record<string, string>;
  body: string;
  /** Unix seconds the vector is checked at. */
  now: number;
  /** The first failing step and why, or null when the request verifies. */
  expect: { step: VerifyStepId; cause: VerifyCause } | null;
  /** What the SDK's `verifyWebhook` reports: `ok` or its error reason. */
  sdk: 'ok' | 'missing_header' | 'malformed' | 'timestamp_out_of_range' | 'mismatch';
}

/** The first failing step of a result, as a vector states it. */
export const firstFailure = (steps: readonly VerifyStep[]): WebhookVector['expect'] => {
  const bad = steps.find((s) => !s.ok);
  return bad?.cause ? { step: bad.id, cause: bad.cause } : null;
};

/** How many vectors the verifier agrees with. */
export async function runVectors(vectors: readonly WebhookVector[]) {
  let passed = 0;
  for (const v of vectors) {
    const got = firstFailure(await verifySteps({ ...v }));
    if (JSON.stringify(got) === JSON.stringify(v.expect)) passed++;
  }
  return { passed, total: vectors.length };
}
