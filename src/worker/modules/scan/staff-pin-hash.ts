import { derivedHmacKey, macPreviousVersion } from '../../platform/crypto.ts';
import { safeEqual, toHex } from '../../platform/ids.ts';
import type { PinMatches } from './staff-pin-decide.ts';

/** HMAC-SHA256(K_pin, id:pin), hex. A database leak alone cannot be brute-forced offline. */
export async function hashPin(
  env: object,
  staffId: string,
  pin: string,
  version?: number,
): Promise<string> {
  const key = await derivedHmacKey(env, 'scan-pin', version);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${staffId}:${pin}`));
  return toHex(new Uint8Array(mac));
}

/**
 * Whether `stored` is the hash of `pin`: under the MAC root, or, while `MAC_KEY_VERSION_PREVIOUS` is set,
 * under the previous root. A correct PIN that was set before a rotation keeps working (and is not
 * counted as a miss) until the previous root is unset; it is then reset like any PIN.
 */
export const pinMatches: PinMatches = async (env, staffId, pin, stored) => {
  const current = await safeEqual(await hashPin(env, staffId, pin), stored);
  const previous = macPreviousVersion(env);
  if (previous === null) return current;
  const old = await safeEqual(await hashPin(env, staffId, pin, previous), stored);
  return current || old;
};

/** `pinMatches` with the keys derived once, for a pass over a whole roster. */
export async function pinMatcher(env: object): Promise<PinMatches> {
  const previousVersion = macPreviousVersion(env);
  const current = await derivedHmacKey(env, 'scan-pin');
  const previous =
    previousVersion === null ? null : await derivedHmacKey(env, 'scan-pin', previousVersion);
  const digest = async (key: CryptoKey, staffId: string, pin: string) =>
    toHex(
      new Uint8Array(
        await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${staffId}:${pin}`)),
      ),
    );
  return async (_env, staffId, pin, stored) => {
    const now = await safeEqual(await digest(current, staffId, pin), stored);
    if (!previous) return now;
    const before = await safeEqual(await digest(previous, staffId, pin), stored);
    return now || before;
  };
}

/**
 * HMAC(K_pin_tag, org:pin), hex. Same strength as the PIN hash (a 10^6 search with the key, none
 * without it) but equal PINs in one org give equal tags, so the database can hold one active person per
 * PIN and find a PIN without hashing the roster. The label is not rotatable (a tag outlives a MAC root change) and versioned: recovering from a root-1
 * compromise means resetting every PIN under a v2 label (docs/operations.md).
 */
export async function pinTag(env: object, orgId: string, pin: string): Promise<string> {
  const key = await derivedHmacKey(env, 'scan-pin-tag.v1');
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${orgId}:${pin}`));
  return toHex(new Uint8Array(mac));
}
