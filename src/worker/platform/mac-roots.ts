import { fromBase64, toBase64 } from './ids.ts';

/**
 * MAC roots. The HMAC keys behind retained evidence (tombstones, retention proofs, commitments, token
 * MACs) derive by HKDF-SHA256 from a KEK. HKDF is Extract then Expand: `PRK = HMAC(salt, KEK)`, then
 * `key = HMAC(PRK, label || 0x01)` (one block, since the output is 32 bytes). `MAC_ROOT_V<n>` holds the
 * PRK of `KEK_V<n>`: it yields every derived key byte for byte, but it is not an AES key, so it cannot
 * unwrap a DEK. With it set, `KEK_V<n>` can be deleted once no envelope uses it (docs/operations.md,
 * KEK rotation).
 */
const SALT = new TextEncoder().encode('passbook.derived-hmac.v1');
const encoder = new TextEncoder();

const hmacImport = (raw: Uint8Array, usages: ('sign' | 'verify')[]) =>
  crypto.subtle.importKey(
    'raw',
    raw as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages,
  );

const rawKey = (base64: string, what: string): Uint8Array => {
  const raw = fromBase64(base64.trim());
  if (raw.length !== 32) throw new Error(`${what} must be 32 bytes, base64 encoded`);
  return raw;
};

/** The versions `env` holds a secret for, ascending: `KEK_V<n>` when `prefix` is KEK, else `MAC_ROOT_V<n>`. */
export function secretVersions(env: object, prefix: 'KEK' | 'MAC_ROOT'): number[] {
  const pattern = new RegExp(`^${prefix}_V(\\d+)$`);
  return Object.entries(env as Record<string, unknown>)
    .flatMap(([name, value]) => {
      const match = pattern.exec(name);
      return match && typeof value === 'string' && value ? [Number(match[1])] : [];
    })
    .sort((a, b) => a - b);
}

/** Every version a MAC key can derive from: the KEKs and the extracted roots. */
export const macRootVersions = (env: object): number[] =>
  [...new Set([...secretVersions(env, 'KEK'), ...secretVersions(env, 'MAC_ROOT')])].sort(
    (a, b) => a - b,
  );

/** HKDF-Extract of a KEK (base64): the value of `MAC_ROOT_V<n>`, base64. */
export async function extractMacRoot(kekBase64: string): Promise<string> {
  const key = await hmacImport(SALT, ['sign']);
  const prk = await crypto.subtle.sign('HMAC', key, rawKey(kekBase64, 'KEK') as BufferSource);
  return toBase64(new Uint8Array(prk));
}

/** The derived key from a KEK: HKDF as WebCrypto runs it. */
async function fromKek(kekBase64: string, label: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey(
    'raw',
    rawKey(kekBase64, 'KEK') as BufferSource,
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: SALT as BufferSource,
      info: encoder.encode(label) as BufferSource,
    },
    ikm,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}

/** The same key from the extracted root: HKDF-Expand by hand. */
async function fromRoot(rootBase64: string, label: string): Promise<CryptoKey> {
  const info = encoder.encode(label);
  const block = new Uint8Array(info.length + 1);
  block.set(info);
  block[info.length] = 1;
  const prk = await hmacImport(rawKey(rootBase64, 'MAC root'), ['sign']);
  const okm = new Uint8Array(await crypto.subtle.sign('HMAC', prk, block as BufferSource));
  return hmacImport(okm, ['sign', 'verify']);
}

/**
 * The derived HMAC key for `label` under root `version`. `KEK_V<n>` wins over `MAC_ROOT_V<n>` when both
 * are set, so a wrong root cannot cause an outage before the KEK is retired (Status flags the mismatch).
 */
export async function derivedMacKey(
  env: object,
  version: number,
  label: string,
): Promise<CryptoKey> {
  const vars = env as Record<string, unknown>;
  const kek = vars[`KEK_V${version}`];
  if (typeof kek === 'string' && kek) return fromKek(kek, label);
  const root = vars[`MAC_ROOT_V${version}`];
  if (typeof root === 'string' && root) return fromRoot(root, label);
  throw new Error(`KEK version ${version} is not available for MAC keys`);
}

/**
 * Whether `MAC_ROOT_V<n>` derives the same keys as `KEK_V<n>`, compared on a fixed probe. Null unless
 * both are set.
 */
export async function macRootAgrees(env: object, version: number): Promise<boolean | null> {
  const vars = env as Record<string, unknown>;
  const kek = vars[`KEK_V${version}`];
  const root = vars[`MAC_ROOT_V${version}`];
  if (typeof kek !== 'string' || !kek || typeof root !== 'string' || !root) return null;
  const probe = encoder.encode('passbook.mac-root.probe');
  try {
    const [a, b] = await Promise.all([fromKek(kek, 'probe'), fromRoot(root, 'probe')]);
    const [x, y] = await Promise.all([
      crypto.subtle.sign('HMAC', a, probe),
      crypto.subtle.sign('HMAC', b, probe),
    ]);
    return toBase64(new Uint8Array(x)) === toBase64(new Uint8Array(y));
  } catch {
    return false;
  }
}
