import { derivedHmacKey } from '../../platform/crypto.ts';
import { toHex } from '../../platform/ids.ts';
import type { Pass } from '../passes/repo-map.ts';
import { canonicalJson } from '../templates/package/hash.ts';

const encoder = new TextEncoder();

/** Keyed commitment to the exact source class and canonical value, without storing personalization. */
export async function personalizationFingerprint(
  env: object,
  orgId: string,
  passId: string,
  walletVersion: number,
  raw: string | null,
): Promise<string | null> {
  if (raw === null) return null;
  let value = `raw\u0000${raw}`;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      value = `object\u0000${canonicalJson(parsed)}`;
  } catch {
    // Malformed source remains committed as raw bytes but is never projected as data.
  }
  const key = await derivedHmacKey(env, 'scan-pass-personalization.v1');
  const data = encoder.encode(`${orgId}\u0000${passId}\u0000${walletVersion}\u0000${value}`);
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, data)));
}

/** Keyed canonical Wallet commitment, never storing the raw pass JSON or serial. */
export async function passJsonFingerprint(
  env: object,
  pass: Pick<Pass, 'orgId' | 'id'>,
  snapshot: string,
  identityRevision: number,
): Promise<string | null> {
  let canonical: string;
  try {
    canonical = canonicalJson(JSON.parse(snapshot));
  } catch {
    return null;
  }
  const key = await derivedHmacKey(env, 'scan-pass-json.v1');
  const data = encoder.encode(
    `${pass.orgId}\u0000${pass.id}\u0000${identityRevision}\u0000${canonical}`,
  );
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, data)));
}
