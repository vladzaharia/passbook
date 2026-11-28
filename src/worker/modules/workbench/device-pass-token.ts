import { keyedDigest } from '../../platform/crypto.ts';
import { safeEqual } from '../../platform/ids.ts';

export const DEVICE_PASS_SERIAL_PREFIX = 'dp_';

export const devicePassSerial = (id: string): string => `${DEVICE_PASS_SERIAL_PREFIX}${id}`;

/** The device pass id a serial names, or null for any other serial. */
export const devicePassIdOf = (serial: string): string | null =>
  serial.startsWith(DEVICE_PASS_SERIAL_PREFIX) && serial.length > DEVICE_PASS_SERIAL_PREFIX.length
    ? serial.slice(DEVICE_PASS_SERIAL_PREFIX.length)
    : null;

/**
 * The web service token inside the signed pass. Never stored: it is made again from the row's id and nonce
 * under a server key, so a database read gives no token and a rebuilt pass carries the same one.
 */
export const devicePassToken = (env: object, id: string, nonce: string): Promise<string> =>
  keyedDigest(env, 'device-pass-auth.v1', `${id}|${nonce}`);

export async function tokenIsValid(
  env: object,
  row: { id: string; auth_nonce: string } | null,
  presented: string,
): Promise<boolean> {
  // A missing pass is compared too, so the answer takes the same time.
  const expected = await devicePassToken(env, row?.id ?? 'none', row?.auth_nonce ?? 'none');
  return (await safeEqual(expected, presented)) && row !== null;
}
