import { fromBase64, randomBytes, toHex } from './ids.ts';
import { parseKekVersion } from './mac-key-config.ts';
import { derivedMacKey, macRootVersions, secretVersions } from './mac-roots.ts';

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
  if (keys.size === 0) throw new Error('No KEK configured');
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

/** The env entries that decide key material: the KEK ring and the pinned MAC root versions. */
export const isKeyEnvName = (name: string): boolean =>
  /^(KEK_V|MAC_ROOT_V)\d+$/.test(name) ||
  name === 'MAC_KEY_VERSION' ||
  name === 'MAC_KEY_VERSION_PREVIOUS';

/** The KEK version numbers configured in `env`, ascending. */
export const kekVersionsOf = (env: object): number[] => secretVersions(env, 'KEK');

/**
 * The root version the MAC keys derive from: `MAC_KEY_VERSION` when set, else the oldest KEK or extracted
 * root (so a deployment that never sets it keeps every stored MAC valid).
 */
export function macKeyVersion(env: object): number {
  const oldest = macRootVersions(env)[0];
  if (oldest === undefined) throw new Error('No KEK configured');
  return versionSetting(env, 'MAC_KEY_VERSION') ?? oldest;
}

function versionSetting(env: object, name: string): number | null {
  const raw = (env as Record<string, unknown>)[name];
  if (raw === undefined || raw === null || raw === '') return null;
  const version = parseKekVersion(raw);
  if (version === null) throw new Error(`${name} must be a KEK version number`);
  return version;
}

/**
 * During a MAC root rotation, the version stored MACs may still be under (`MAC_KEY_VERSION_PREVIOUS`):
 * lookups accept both until `tokens.remac` has rewritten every row. Null when unset or equal to the root.
 */
export function macPreviousVersion(env: object): number | null {
  const previous = versionSetting(env, 'MAC_KEY_VERSION_PREVIOUS');
  return previous === null || previous === macKeyVersion(env) ? null : previous;
}

/**
 * The labels whose keys follow `MAC_KEY_VERSION`: the MACs of capability and device tokens (re-MACed from
 * their sealed copies by cron tokens.remac), staff PINs (checked under both roots while `MAC_KEY_VERSION_PREVIOUS` is set), pair codes
 * (ten minutes), scanner asset grants (one hour) and the scan CSRF proofs (computed on every request). Every other label stays on the oldest KEK: its MACs are retained evidence bound
 * to the credential-reference keyset commitment (tombstones, retention proofs, webhook and action
 * references), which a changed root would fail closed. docs/operations.md, MAC key rotation.
 */
const ROTATABLE_LABELS: ReadonlySet<string> = new Set([
  'capability-token.v1',
  'apple-auth-token.v1',
  'scan-pin',
  'scan-pair-code.v1',
  'scan-asset-grant-v2',
  'scan-asset-claim',
  'scan-asset-session-id',
  'scan-session-csrf.v1',
  'scan-scanner-csrf.v1',
]);

/**
 * An HMAC-SHA256 key derived (HKDF) from a KEK (or its extracted `MAC_ROOT_V<n>`, mac-roots.ts) and a purpose
 * label: the MAC root (`macKeyVersion`) for the rotatable labels above, the oldest root for the rest. Removing
 * or changing the root a stored MAC was made with breaks it. `version` derives under another KEK, for the job that moves MACs between roots.
 * Never reuse a label across purposes.
 */
export async function derivedHmacKey(
  env: object,
  label: string,
  version?: number,
): Promise<CryptoKey> {
  const oldest = macRootVersions(env)[0];
  if (oldest === undefined) throw new Error('No KEK configured');
  const wanted = version ?? (ROTATABLE_LABELS.has(label) ? macKeyVersion(env) : oldest);
  return derivedMacKey(env, wanted, label);
}

/**
 * A 128-bit hex digest of `value` under the derived key for `label`. For counter and rate-limit
 * keys built from an address: a plain hash falls to a dictionary of emails, this one does not
 * without the KEK. Stored counters under an older scheme just expire. The `counter.*` labels are not
 * rotatable labels: they stay on the oldest KEK, so a MAC root rotation does not reset their buckets.
 */
export async function keyedDigest(env: object, label: string, value: string): Promise<string> {
  const key = await derivedHmacKey(env, label);
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(value) as BufferSource);
  return toHex(new Uint8Array(mac)).slice(0, 32);
}
