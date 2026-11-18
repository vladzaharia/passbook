import { toHex } from '../../platform/ids.ts';
import { readCapped } from '../../platform/read-capped.ts';
import { ConnectorError } from '../types.ts';
import { decodeBase64_32, decodeHex32, decodeUtf8Strict, parseStripeSignature } from './decode.ts';

export const SIGNATURE_HEADER = 'x-wallet-signature';
export const TIMESTAMP_HEADER = 'x-wallet-timestamp';
export const REPLAY_WINDOW_MS = 5 * 60_000;
const FUTURE_SKEW_MS = 60_000;
export const MAX_WEBHOOK_BYTES = 256 * 1024;
/** The oldest signed time any scheme accepts. It stays below the 7-day webhook dedupe retention. */
export const MAX_REPLAY_AGE_MS = 48 * 3_600_000;
/** How far ahead of now a body-window time may be. */
export const BODY_FUTURE_SKEW_MS = 5 * 60_000;
const SHOPIFY_MAX_BYTES = 1024 * 1024;
const MAX_SECRETS = 2;

/** Always ArrayBuffer-backed, as SubtleCrypto requires. */
type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();

// ---- primitives ----

function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

/** Constant-time compare (SubtleCrypto verify). `signature` must already be a strictly decoded MAC. */
export async function hmacVerify(
  secret: string,
  signature: Bytes,
  message: Bytes,
): Promise<boolean> {
  return crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), signature, message);
}

/** The message is exactly `prefix` then the received bytes, never re-encoded text. */
function withPrefix(prefix: string, bytes: Bytes): Bytes {
  const head = encoder.encode(prefix);
  const out = new Uint8Array(head.byteLength + bytes.byteLength);
  out.set(head, 0);
  out.set(bytes, head.byteLength);
  return out;
}

/** Content-length check, then a capped read. The only reader of `req.body`. */
export async function readSignedBytes(req: Request, maxBytes: number): Promise<Bytes> {
  // readCapped allocates its result, so it is never shared memory.
  return (await readCapped(
    req.body,
    maxBytes,
    () => new ConnectorError('INVALID_PAYLOAD'),
    Number(req.headers.get('content-length') ?? 0),
  )) as Bytes;
}

async function sha256Hex(bytes: Bytes): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

/** The index of the first secret with a matching signature, else -1; at most MAX_SECRETS x MAX_STRIPE_V1 compares. */
async function matchesAny(
  secrets: readonly string[],
  signatures: readonly Bytes[],
  message: Bytes,
): Promise<number> {
  let matched = -1;
  for (const [index, secret] of secrets.entries()) {
    for (const signature of signatures) {
      if ((await hmacVerify(secret, signature, message)) && matched < 0) matched = index;
    }
  }
  return matched;
}

/** `signedAt` is not older than `pastMs` and not further ahead than `futureMs`. */
export function withinWindow(now: number, signedAt: number, pastMs: number, futureMs: number) {
  const age = now - signedAt;
  return age <= pastMs && age >= -futureMs;
}

// ---- verifier strategies ----

export interface SignedBody {
  /** Exactly what was received; read once. */
  bytes: Bytes;
  /** sha256(bytes) hex; the event id for senders without one. */
  digest: string;
  /** ms; only when the scheme signs a timestamp (custom, stripe). */
  signedAt?: number;
  /** True when only the previous secret (not the current one) matched. */
  usedPrevious?: true;
  /** Hex of the matched MAC (custom scheme only). */
  signature?: string;
}

export interface CustomHeaders {
  signatureHeader?: string;
  timestampHeader?: string;
}

export interface WebhookVerifier {
  id: 'custom' | 'shopify' | 'stripe' | 'calcom';
  maxBytes: number;
  /** Where the replay bound comes from: a signed header, or a signed time in the body that the recipe must bound. */
  replay: 'header-window' | 'body-window';
  /** Throws ConnectorError('AUTH') on any mismatch and 'INVALID_PAYLOAD' on size. `secrets`: current first. */
  verify(
    req: Request,
    secrets: readonly string[],
    now: number,
    opts?: CustomHeaders,
  ): Promise<SignedBody>;
}

function checkSecrets(secrets: readonly string[]): void {
  if (secrets.length > MAX_SECRETS) throw new ConnectorError('CONFIG', { permanent: true });
  if (secrets.length === 0 || secrets.some((s) => s.length === 0)) {
    throw new ConnectorError('AUTH', { permanent: true });
  }
}

const auth = () => new ConnectorError('AUTH');

/** What the headers say, parsed before the body is read: candidate MACs and the text signed before the body. */
interface ParsedSignature {
  signatures: Bytes[];
  prefix: string;
}

async function signed(
  req: Request,
  secrets: readonly string[],
  maxBytes: number,
  parsed: ParsedSignature | null,
): Promise<{ bytes: Bytes; digest: string; usedPrevious?: true }> {
  checkSecrets(secrets);
  // A missing or malformed header costs no body read.
  if (!parsed) throw auth();
  const bytes = await readSignedBytes(req, maxBytes);
  const message = parsed.prefix ? withPrefix(parsed.prefix, bytes) : bytes;
  const hit = await matchesAny(secrets, parsed.signatures, message);
  if (hit < 0) throw auth();
  return {
    bytes,
    digest: await sha256Hex(bytes),
    ...(hit > 0 ? { usedPrevious: true as const } : {}),
  };
}

const orNull = (sig: Bytes | null): ParsedSignature | null =>
  sig && { signatures: [sig], prefix: '' };

const shopify: WebhookVerifier = {
  id: 'shopify',
  maxBytes: SHOPIFY_MAX_BYTES,
  replay: 'body-window',
  verify: async (req, secrets) => {
    const header = req.headers.get('x-shopify-hmac-sha256');
    return signed(
      req,
      secrets,
      SHOPIFY_MAX_BYTES,
      orNull(header === null ? null : decodeBase64_32(header)),
    );
  },
};

/** Cal.com sends the lowercase hex digest alone (calcom/cal.com sendPayload.ts). */
const calcom: WebhookVerifier = {
  id: 'calcom',
  maxBytes: MAX_WEBHOOK_BYTES,
  replay: 'body-window',
  verify: async (req, secrets) => {
    const header = req.headers.get('x-cal-signature-256');
    return signed(
      req,
      secrets,
      MAX_WEBHOOK_BYTES,
      orNull(header === null ? null : decodeHex32(header)),
    );
  },
};

const stripe: WebhookVerifier = {
  id: 'stripe',
  maxBytes: MAX_WEBHOOK_BYTES,
  replay: 'header-window',
  verify: async (req, secrets, now) => {
    const header = req.headers.get('stripe-signature');
    const parsed = header === null ? null : parseStripeSignature(header);
    const body = await signed(
      req,
      secrets,
      MAX_WEBHOOK_BYTES,
      parsed && { signatures: parsed.v1, prefix: `${parsed.t}.` },
    );
    // A matching MAC proves `t` is authentic; the window then bounds replays.
    const signedAt = (parsed?.t ?? 0) * 1000;
    if (!withinWindow(now, signedAt, REPLAY_WINDOW_MS, FUTURE_SKEW_MS)) throw auth();
    return { ...body, signedAt };
  },
};

const custom: WebhookVerifier = {
  id: 'custom',
  maxBytes: MAX_WEBHOOK_BYTES,
  replay: 'header-window',
  verify: async (req, secrets, now, opts = {}) => {
    const header = req.headers.get(opts.signatureHeader ?? SIGNATURE_HEADER);
    const ts = req.headers.get(opts.timestampHeader ?? TIMESTAMP_HEADER);
    const match = header === null ? null : /^v1=([0-9a-f]{64})$/.exec(header);
    const sig = match?.[1] ? decodeHex32(match[1]) : null;
    const parsed =
      sig && ts !== null && /^\d{9,12}$/.test(ts) ? { signatures: [sig], prefix: `${ts}.` } : null;
    const body = await signed(req, secrets, MAX_WEBHOOK_BYTES, parsed);
    const signedAt = Number(ts) * 1000;
    if (!withinWindow(now, signedAt, REPLAY_WINDOW_MS, FUTURE_SKEW_MS)) throw auth();
    return { ...body, signedAt, signature: match?.[1] ?? '' };
  },
};

export const VERIFIERS: Record<WebhookVerifier['id'], WebhookVerifier> = {
  custom,
  shopify,
  stripe,
  calcom,
};

/** Current secret first, the previous one only while its overlap lasts (runtime.ts decides). */
export function webhookSecretsOf(ctx: {
  webhookSecret?: string;
  webhookSecrets?: readonly string[];
}): readonly string[] {
  return ctx.webhookSecrets ?? (ctx.webhookSecret ? [ctx.webhookSecret] : []);
}

// ---- the custom scheme's public surface ----

/** Header value `v1=<hex>` over `<timestamp>.<body>`; the timestamp is in seconds. */
export async function signWebhook(
  secret: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const mac = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret, 'sign'),
    encoder.encode(`${timestamp}.${body}`),
  );
  return `v1=${toHex(new Uint8Array(mac))}`;
}

export interface VerifiedWebhook {
  body: string;
  /** Hex digest; stable across retransmissions of the same delivery. */
  signature: string;
  /** ms; the signed timestamp that passed the window. */
  signedAt: number;
}

/** Custom scheme: size, HMAC over the received bytes (constant time), then the timestamp window. */
export async function verifySignedRequest(
  req: Request,
  options: { secrets: readonly string[]; now: number } & CustomHeaders,
): Promise<VerifiedWebhook> {
  const { bytes, signature, signedAt } = await custom.verify(
    req,
    options.secrets,
    options.now,
    options,
  );
  return { body: decodeUtf8Strict(bytes), signature: signature ?? '', signedAt: signedAt ?? 0 };
}
