import { fromBase64, randomBytes } from './ids.ts';

/**
 * Envelope encryption. Each secret gets a random 256-bit DEK (AES-256-GCM); the DEK is wrapped
 * with a versioned KEK from a Worker secret (KEK_V1, KEK_V2, ...; base64, 32 bytes). AAD binds
 * the record to its identity (`id|org_id|kind`) so rows cannot be swapped.
 */
export interface Envelope {
  kekVersion: number;
  iv: Uint8Array;
  /** wrapping iv (12 bytes) followed by the wrapped DEK. */
  wrappedDek: Uint8Array;
  ciphertext: Uint8Array;
}

export interface KekRing {
  current: number;
  keys: Map<number, CryptoKey>;
}

const IV_BYTES = 12;
const encoder = new TextEncoder();

export function credentialAad(id: string, orgId: string | null, kind: string): string {
  return `${id}|${orgId ?? ''}|${kind}`;
}

export async function importKek(base64: string): Promise<CryptoKey> {
  const raw = fromBase64(base64.trim());
  if (raw.length !== 32) throw new Error('KEK must be 32 bytes, base64 encoded');
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

/** Builds a ring from `KEK_V<n>` entries; the highest version encrypts. */
export async function loadKekRing(env: object): Promise<KekRing> {
  const keys = new Map<number, CryptoKey>();
  for (const [name, value] of Object.entries(env as Record<string, unknown>)) {
    const match = /^KEK_V(\d+)$/.exec(name);
    if (match && typeof value === 'string' && value)
      keys.set(Number(match[1]), await importKek(value));
  }
  if (keys.size === 0) throw new Error('No KEK configured (KEK_V1)');
  return { current: Math.max(...keys.keys()), keys };
}

function kekFor(ring: KekRing, version: number): CryptoKey {
  const key = ring.keys.get(version);
  if (!key) throw new Error(`KEK version ${version} is not available`);
  return key;
}

export async function encryptSecret(
  ring: KekRing,
  plaintext: Uint8Array | string,
  aad: string,
): Promise<Envelope> {
  const data = typeof plaintext === 'string' ? encoder.encode(plaintext) : plaintext;
  const additionalData = encoder.encode(aad);
  const dekRaw = randomBytes(32);
  const dek = await crypto.subtle.importKey('raw', dekRaw as BufferSource, 'AES-GCM', false, [
    'encrypt',
  ]);
  const iv = randomBytes(IV_BYTES);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, additionalData },
      dek,
      data as BufferSource,
    ),
  );
  const wrapIv = randomBytes(IV_BYTES);
  const wrapped = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: wrapIv as BufferSource, additionalData },
      kekFor(ring, ring.current),
      dekRaw as BufferSource,
    ),
  );
  const wrappedDek = new Uint8Array(wrapIv.length + wrapped.length);
  wrappedDek.set(wrapIv);
  wrappedDek.set(wrapped, wrapIv.length);
  return { kekVersion: ring.current, iv, wrappedDek, ciphertext };
}

export async function decryptSecret(
  ring: KekRing,
  envelope: Envelope,
  aad: string,
): Promise<Uint8Array> {
  const additionalData = encoder.encode(aad);
  const wrapIv = envelope.wrappedDek.subarray(0, IV_BYTES);
  const wrapped = envelope.wrappedDek.subarray(IV_BYTES);
  const dekRaw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: wrapIv as BufferSource, additionalData },
    kekFor(ring, envelope.kekVersion),
    wrapped as BufferSource,
  );
  const dek = await crypto.subtle.importKey('raw', dekRaw, 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: envelope.iv as BufferSource, additionalData },
      dek,
      envelope.ciphertext as BufferSource,
    ),
  );
}

export async function decryptSecretText(
  ring: KekRing,
  envelope: Envelope,
  aad: string,
): Promise<string> {
  return new TextDecoder().decode(await decryptSecret(ring, envelope, aad));
}

/** Re-wraps the DEK under the current KEK without touching the ciphertext. */
export async function rewrapSecret(
  ring: KekRing,
  envelope: Envelope,
  aad: string,
): Promise<Envelope> {
  if (envelope.kekVersion === ring.current) return envelope;
  const additionalData = encoder.encode(aad);
  const dekRaw = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: envelope.wrappedDek.subarray(0, IV_BYTES) as BufferSource,
      additionalData,
    },
    kekFor(ring, envelope.kekVersion),
    envelope.wrappedDek.subarray(IV_BYTES) as BufferSource,
  );
  const wrapIv = randomBytes(IV_BYTES);
  const wrapped = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: wrapIv as BufferSource, additionalData },
      kekFor(ring, ring.current),
      dekRaw,
    ),
  );
  const wrappedDek = new Uint8Array(wrapIv.length + wrapped.length);
  wrappedDek.set(wrapIv);
  wrappedDek.set(wrapped, wrapIv.length);
  return { ...envelope, kekVersion: ring.current, wrappedDek };
}

/**
 * An HMAC-SHA256 key derived (HKDF) from the oldest configured KEK and a purpose label. The oldest
 * version keeps stored MACs valid when a newer KEK is added. Never reuse a label across purposes.
 */
export async function derivedHmacKey(env: object, label: string): Promise<CryptoKey> {
  const versions = Object.entries(env as Record<string, unknown>)
    .map(([name, value]) => ({ match: /^KEK_V(\d+)$/.exec(name), value }))
    .filter((e) => e.match && typeof e.value === 'string' && e.value)
    .map((e) => ({ version: Number(e.match?.[1]), value: e.value as string }))
    .sort((a, b) => a.version - b.version);
  const oldest = versions[0];
  if (!oldest) throw new Error('No KEK configured (KEK_V1)');
  const raw = fromBase64(oldest.value.trim());
  if (raw.length !== 32) throw new Error('KEK must be 32 bytes, base64 encoded');
  const ikm = await crypto.subtle.importKey('raw', raw as BufferSource, 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('passbook.derived-hmac.v1') as BufferSource,
      info: encoder.encode(label) as BufferSource,
    },
    ikm,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}
