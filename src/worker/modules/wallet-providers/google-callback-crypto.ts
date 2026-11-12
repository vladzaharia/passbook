import { Buffer } from 'node:buffer';
import { createPublicKey, type KeyObject, verify as verifySignature } from 'node:crypto';
import { PayloadTooLargeError } from '../../platform/errors.ts';
import { isGoogleIssuerId } from './google-credentials.ts';

// Google Wallet's documented ECv2SigningOnly endpoint, not the Google Pay payment-token key URL.
export const GOOGLE_CALLBACK_KEYS_URL = 'https://pay.google.com/gp/m/issuer/keys';
export const GOOGLE_CALLBACK_BODY_LIMIT = 16 * 1024;
const KEYS_BODY_LIMIT = 64 * 1024;
const PROTOCOL = 'ECv2SigningOnly';
const SENDER = 'GooglePayPasses';
const encoder = new TextEncoder();

export class GoogleCallbackInvalid extends Error {
  constructor() {
    super('Invalid Google Wallet callback.');
  }
}
export class GoogleCallbackKeysUnavailable extends Error {
  constructor() {
    super('Google Wallet verification keys are unavailable.');
  }
}

export interface VerifiedGoogleCallback {
  classId: string;
  objectId: string;
  eventType: 'save' | 'del';
  nonce: string;
  expiresAt: number;
  /** Earliest expiry of the event, optional Tink message expiry and its verified key chain. */
  validUntil: number;
}

/** Bound actual stream bytes, not merely the request's untrusted Content-Length. */
async function readBounded(response: Request | Response, limit: number): Promise<Uint8Array> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit))
    throw new PayloadTooLargeError();
  if (!response.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new PayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function readGoogleCallbackBody(request: Request): Promise<Uint8Array> {
  return readBounded(request, GOOGLE_CALLBACK_BODY_LIMIT);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new GoogleCallbackInvalid();
  return value as Record<string, unknown>;
}
function parse(value: string): Record<string, unknown> {
  try {
    return object(JSON.parse(value));
  } catch {
    throw new GoogleCallbackInvalid();
  }
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new GoogleCallbackInvalid();
  return value;
}
function expiry(value: unknown): number {
  if (
    (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 0
  )
    throw new GoogleCallbackInvalid();
  return Number(value);
}
function exactKeys(value: Record<string, unknown>, names: readonly string[]): void {
  if (Object.keys(value).length !== names.length || names.some((name) => !(name in value)))
    throw new GoogleCallbackInvalid();
}
function base64(value: unknown, maxBytes: number): Buffer {
  const text = string(value);
  if (
    text.length > Math.ceil(maxBytes / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)
  )
    throw new GoogleCallbackInvalid();
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length === 0 || bytes.length > maxBytes || bytes.toString('base64') !== text)
    throw new GoogleCallbackInvalid();
  return bytes;
}
function publicKey(value: unknown): KeyObject {
  try {
    const key = createPublicKey({ key: base64(value, 256), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
      throw new GoogleCallbackInvalid();
    return key;
  } catch {
    throw new GoogleCallbackInvalid();
  }
}

/** Tink PaymentMethodTokenUtil.toLengthValue: UTF-8 fields prefixed with uint32 LE lengths. */
function signedBytes(...fields: string[]): Uint8Array {
  const parts = fields.map((field) => encoder.encode(field));
  const result = new Uint8Array(parts.reduce((sum, part) => sum + 4 + part.length, 0));
  const view = new DataView(result.buffer);
  let offset = 0;
  for (const part of parts) {
    view.setUint32(offset, part.length, true);
    offset += 4;
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
function validSignature(key: KeyObject, signature: Buffer, data: Uint8Array): boolean {
  try {
    return verifySignature('sha256', data, key, signature);
  } catch {
    return false;
  }
}

async function googleRootKeys(now: () => number): Promise<{ key: KeyObject; expiresAt: number }[]> {
  let data: Record<string, unknown>;
  try {
    // Always fetch the pinned URL so newly rotated keys are available immediately. Redirects are
    // forbidden, and neither the request nor its headers can supply a verification key or URL.
    const response = await fetch(GOOGLE_CALLBACK_KEYS_URL, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error();
    data = parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
        await readBounded(response, KEYS_BODY_LIMIT),
      ),
    );
    if (!Array.isArray(data.keys)) throw new Error();
  } catch {
    throw new GoogleCallbackKeysUnavailable();
  }
  const keys: { key: KeyObject; expiresAt: number }[] = [];
  for (const item of data.keys as unknown[]) {
    try {
      const root = object(item);
      if (root.protocolVersion === PROTOCOL) {
        const expiresAt = expiry(root.keyExpiration);
        if (expiresAt > now()) keys.push({ key: publicKey(root.keyValue), expiresAt });
      }
    } catch {
      // A malformed or expired rotated key must not prevent another current key from working.
    }
  }
  if (!keys.length) throw new GoogleCallbackKeysUnavailable();
  return keys;
}

/** Verify the signed strings without reserializing them, as Tink's recipient implementation does. */
export async function verifyGoogleCallback(
  raw: Uint8Array,
  issuerId: string,
  now: () => number,
): Promise<VerifiedGoogleCallback> {
  if (
    !isGoogleIssuerId(issuerId) ||
    !Number.isSafeInteger(now()) ||
    raw.byteLength > GOOGLE_CALLBACK_BODY_LIMIT
  )
    throw new GoogleCallbackInvalid();
  let envelope: Record<string, unknown>;
  try {
    envelope = parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw));
  } catch {
    throw new GoogleCallbackInvalid();
  }
  exactKeys(envelope, ['protocolVersion', 'intermediateSigningKey', 'signature', 'signedMessage']);
  if (envelope.protocolVersion !== PROTOCOL) throw new GoogleCallbackInvalid();
  const intermediate = object(envelope.intermediateSigningKey);
  exactKeys(intermediate, ['signedKey', 'signatures']);
  const signedKey = string(intermediate.signedKey);
  const signedMessage = string(envelope.signedMessage);
  if (!Array.isArray(intermediate.signatures) || intermediate.signatures.length === 0)
    throw new GoogleCallbackInvalid();
  const intermediateSignatures = intermediate.signatures.map((value) => base64(value, 80));
  const signature = base64(envelope.signature, 80);
  const keys = await googleRootKeys(now);
  const intermediateBytes = signedBytes(SENDER, PROTOCOL, signedKey);
  const trustedUntil = keys.reduce(
    (latest, root) =>
      intermediateSignatures.some((sig) => validSignature(root.key, sig, intermediateBytes))
        ? Math.max(latest, root.expiresAt)
        : latest,
    0,
  );
  if (trustedUntil <= now()) throw new GoogleCallbackInvalid();
  const keyData = parse(signedKey);
  const intermediateUntil = expiry(keyData.keyExpiration);
  if (intermediateUntil <= now()) throw new GoogleCallbackInvalid();
  const messageKey = publicKey(keyData.keyValue);
  if (
    !validSignature(messageKey, signature, signedBytes(SENDER, issuerId, PROTOCOL, signedMessage))
  )
    throw new GoogleCallbackInvalid();
  const message = parse(signedMessage);
  const expiresAt = expiry(message.expTimeMillis);
  const messageUntil =
    'messageExpiration' in message ? expiry(message.messageExpiration) : expiresAt;
  const validUntil = Math.min(expiresAt, messageUntil, intermediateUntil, trustedUntil);
  const classId = string(message.classId);
  const objectId = string(message.objectId);
  const nonce = string(message.nonce);
  if (
    validUntil <= now() ||
    (message.eventType !== 'save' && message.eventType !== 'del') ||
    !new RegExp(`^${issuerId}\\.c_[A-Za-z0-9_-]{43}$`).test(classId) ||
    !new RegExp(`^${issuerId}\\.o_[A-Za-z0-9_-]{43}$`).test(objectId) ||
    encoder.encode(nonce).byteLength > 1024
  )
    throw new GoogleCallbackInvalid();
  return { classId, objectId, nonce, expiresAt, validUntil, eventType: message.eventType };
}
