import { ConnectorError } from '../types.ts';

/** Stripe's v1 entries to try; during a rollover Stripe sends one per active secret. */
const MAX_STRIPE_V1 = 8;

type Bytes = Uint8Array<ArrayBuffer>;

// Strict decoders: exact length, exact alphabet, null on anything else.

/** Lowercase hex, exactly 64 characters. */
export function decodeHex32(s: string): Bytes | null {
  if (!/^[0-9a-f]{64}$/.test(s)) return null;
  return Uint8Array.from(s.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
}

/** Standard-alphabet base64, padded, 44 characters, canonical (no stray trailing bits). */
export function decodeBase64_32(s: string): Bytes | null {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(s)) return null;
  const bytes = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  return btoa(String.fromCharCode(...bytes)) === s ? bytes : null;
}

/** Stripe's `t=<seconds>,v1=<hex>,…`. Unknown entries are ignored; `v0` is never read. */
export function parseStripeSignature(h: string): { t: number; v1: Bytes[] } | null {
  let t: string | null = null;
  const v1: Bytes[] = [];
  let seen = 0;
  for (const entry of h.split(',')) {
    const eq = entry.indexOf('=');
    if (eq < 0) continue;
    const key = entry.slice(0, eq);
    const value = entry.slice(eq + 1);
    if (key === 't') {
      if (t !== null || !/^[1-9]\d{8,11}$/.test(value)) return null;
      t = value;
    } else if (key === 'v1' && seen < MAX_STRIPE_V1) {
      seen += 1;
      const sig = decodeHex32(value);
      if (sig) v1.push(sig);
    }
  }
  return t === null || v1.length === 0 ? null : { t: Number(t), v1 };
}

/** The decoded body only ever comes after the MAC: invalid UTF-8 is a bad payload, not bad auth. */
export function decodeUtf8Strict(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new ConnectorError('INVALID_PAYLOAD');
  }
}

export function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new ConnectorError('INVALID_PAYLOAD');
  }
}

export function decodeJsonStrict(bytes: Uint8Array): unknown {
  return parseJsonBody(decodeUtf8Strict(bytes));
}
