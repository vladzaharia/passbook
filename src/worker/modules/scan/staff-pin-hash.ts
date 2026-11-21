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
