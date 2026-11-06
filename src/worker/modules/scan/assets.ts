import { derivedHmacKey } from '../../platform/crypto.ts';
import { fromBase64Url, safeEqualBytes, toBase64Url } from '../../platform/ids.ts';

const HOUR = 3_600_000;
const EXP_BYTES = 8;

async function mac(
  env: object,
  actorKey: string,
  passId: string,
  exp: number,
): Promise<Uint8Array> {
  const key = await derivedHmacKey(env, 'scan-asset');
  const data = new TextEncoder().encode(`${actorKey}\u0000${passId}\u0000${exp}`);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

/**
 * A card and a lookup row write no scan row, so "this actor scanned it" cannot gate images. The
 * grant is stateless: an HMAC of the actor, the pass and an hour's expiry, useless without that
 * actor's credential (SA 5.1).
 */
export async function mintAssetGrant(
  env: object,
  actorKey: string,
  passId: string,
  now: number,
): Promise<string> {
  const exp = now + HOUR;
  const tag = await mac(env, actorKey, passId, exp);
  const out = new Uint8Array(tag.length + EXP_BYTES);
  out.set(tag);
  new DataView(out.buffer).setBigUint64(tag.length, BigInt(exp));
  return toBase64Url(out);
}

export async function assetGrantValid(
  env: object,
  actorKey: string,
  passId: string,
  grant: string | undefined,
  now: number,
): Promise<boolean> {
  if (!grant || !/^[A-Za-z0-9_-]{54}$/.test(grant)) return false;
  const bytes = fromBase64Url(grant);
  const tag = bytes.slice(0, bytes.length - EXP_BYTES);
  const exp = Number(new DataView(bytes.buffer).getBigUint64(tag.length));
  if (exp <= now) return false;
  return safeEqualBytes(tag, await mac(env, actorKey, passId, exp));
}

export const assetBaseUrl = (passId: string) => `/api/v1/scan/passes/${passId}/assets/`;
