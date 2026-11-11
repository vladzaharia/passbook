import type { Mode } from '../../../shared/contracts/common.ts';
import { derivedHmacKey } from '../../platform/crypto.ts';
import { toHex } from '../../platform/ids.ts';

/** Scope a scanner-identifier digest without retaining a guessable credential reference. */
export async function credentialTombstoneRef(
  env: object,
  orgId: string,
  mode: Mode,
  digest: string,
): Promise<string> {
  const key = await derivedHmacKey(env, 'pass-credential-tombstone-v1');
  const input = new TextEncoder().encode(JSON.stringify([orgId, mode, digest]));
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, input)));
}
