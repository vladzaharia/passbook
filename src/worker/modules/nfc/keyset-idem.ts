import { derivedHmacKey } from '../../platform/crypto.ts';
import { toHex } from '../../platform/ids.ts';

const SECRET_FIELDS = ['metaKey', 'fileKey', 'csv'] as const;

/**
 * The request as the idempotency store hashes it: typed-in keys and the import file replaced by their
 * HMACs, so a weak key cannot be confirmed offline from `request_hash`.
 */
export async function keysetRequestBody(
  env: object,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const key = await derivedHmacKey(env, 'nfc-idem.v1');
  const out = { ...body };
  for (const field of SECRET_FIELDS) {
    const value = out[field];
    if (typeof value === 'string')
      out[field] = toHex(
        new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))),
      );
  }
  return out;
}
