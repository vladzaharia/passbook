import { toHex } from '../../platform/ids.ts';
import { ConnectorError } from '../types.ts';

export const SIGNATURE_HEADER = 'x-wallet-signature';
export const TIMESTAMP_HEADER = 'x-wallet-timestamp';
export const REPLAY_WINDOW_MS = 5 * 60_000;
const FUTURE_SKEW_MS = 60_000;
export const MAX_WEBHOOK_BYTES = 256 * 1024;

const encoder = new TextEncoder();

function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

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
}

/** Checks size, timestamp window and the HMAC (constant time). Throws ConnectorError('AUTH'). */
export async function verifySignedRequest(
  req: Request,
  options: {
    secret: string | undefined;
    now: number;
    signatureHeader?: string;
    timestampHeader?: string;
  },
): Promise<VerifiedWebhook> {
  const { secret } = options;
  if (!secret) throw new ConnectorError('AUTH', { permanent: true });
  const sigHeader = req.headers.get(options.signatureHeader ?? SIGNATURE_HEADER);
  const tsHeader = req.headers.get(options.timestampHeader ?? TIMESTAMP_HEADER);
  if (Number(req.headers.get('content-length') ?? 0) > MAX_WEBHOOK_BYTES) {
    throw new ConnectorError('INVALID_PAYLOAD');
  }
  const body = await req.text();
  if (encoder.encode(body).length > MAX_WEBHOOK_BYTES) throw new ConnectorError('INVALID_PAYLOAD');
  if (!sigHeader || !tsHeader || !/^\d{9,12}$/.test(tsHeader)) throw new ConnectorError('AUTH');
  const skew = options.now - Number(tsHeader) * 1000;
  if (skew > REPLAY_WINDOW_MS || skew < -FUTURE_SKEW_MS) throw new ConnectorError('AUTH');
  const match = /^v1=([0-9a-f]{64})$/.exec(sigHeader.trim());
  if (!match?.[1]) throw new ConnectorError('AUTH');
  const given = Uint8Array.from(match[1].match(/../g) ?? [], (h) => Number.parseInt(h, 16));
  const ok = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret, 'verify'),
    given,
    encoder.encode(`${tsHeader}.${body}`),
  );
  if (!ok) throw new ConnectorError('AUTH');
  return { body, signature: match[1] };
}

export function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new ConnectorError('INVALID_PAYLOAD');
  }
}
