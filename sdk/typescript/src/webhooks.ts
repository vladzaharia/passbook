import { WebhookSignatureError } from './errors.ts';
import type { WebhookEvent } from './generated/schemas.ts';

type HeaderBag = Headers | Record<string, string | ReadonlyArray<string> | undefined>;

export interface VerifyOptions {
  /** How far the signed timestamp may be from now, either way. Default 300. */
  toleranceSeconds?: number;
  /** Unix seconds; for tests. */
  now?: number;
}

const encoder = new TextEncoder();

function header(headers: HeaderBag, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name)
      return Array.isArray(value) ? value.join(', ') : (value as string | undefined);
  }
  return undefined;
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Checks a webhook delivery and returns the event. Pass the raw body exactly as received, before any
 * JSON parsing. The signature is HMAC-SHA256 over `<timestamp>.<body>`; while a secret rotates the
 * header lists one `v1=` value per live secret and any match passes.
 * Throws `WebhookSignatureError` on a missing, malformed, stale or wrong signature.
 */
export async function verifyWebhook(
  payload: string | ArrayBuffer | Uint8Array,
  headers: HeaderBag,
  secret: string | ReadonlyArray<string>,
  options: VerifyOptions = {},
): Promise<WebhookEvent> {
  const signature = header(headers, 'x-passbook-signature');
  const timestamp = header(headers, 'x-passbook-timestamp');
  if (!signature || !timestamp)
    throw new WebhookSignatureError(
      'missing_header',
      'The x-passbook-signature and x-passbook-timestamp headers are required.',
    );
  const candidates = signature
    .split(',')
    .map((part) => /^v1=([0-9a-f]{64})$/.exec(part.trim())?.[1])
    .filter((hex): hex is string => hex !== undefined);
  if (!/^\d{9,12}$/.test(timestamp) || candidates.length === 0)
    throw new WebhookSignatureError('malformed', 'The signature or timestamp header is malformed.');

  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > (options.toleranceSeconds ?? 300))
    throw new WebhookSignatureError(
      'timestamp_out_of_range',
      'The timestamp is outside the tolerance.',
    );

  const body = typeof payload === 'string' ? encoder.encode(payload) : new Uint8Array(payload);
  const head = encoder.encode(`${timestamp}.`);
  const message = new Uint8Array(head.length + body.length);
  message.set(head);
  message.set(body, head.length);

  let matched = false;
  for (const s of Array.isArray(secret) ? secret : [secret]) {
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(s as string),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    for (const hex of candidates) {
      if (await crypto.subtle.verify('HMAC', key, fromHex(hex), message)) matched = true;
    }
  }
  if (!matched) throw new WebhookSignatureError('mismatch', 'The signature does not match.');
  return JSON.parse(new TextDecoder().decode(body)) as WebhookEvent;
}
