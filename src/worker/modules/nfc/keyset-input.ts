import { loadKekRing } from '../../platform/crypto.ts';
import { ValidationError } from '../../platform/errors.ts';
import { randomBytes } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { KEY_BYTES, openVersion } from './keyset-seal.ts';
import { orgVersionEnvelopes } from './repo-keysets.ts';
import { bytesToHex, constantTimeEqual, hexToBytes } from './sun.ts';

export interface Keys {
  metaKey: string;
  fileKey: string;
}

type KeyInput = { generate: true } | { metaKey: string; fileKey?: string };

const SLUG_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Keys the caller entered or the server generates. A factory-default (all zero) key or one key for both roles
 * is refused. A keyset of imported tags takes the meta key only: its file key is random and nothing reads it.
 */
export function pickKeys(input: KeyInput): {
  meta: Uint8Array;
  file: Uint8Array;
  shown: Keys | null;
} {
  if ('generate' in input) {
    const meta = randomBytes(KEY_BYTES);
    const file = randomBytes(KEY_BYTES);
    return { meta, file, shown: { metaKey: bytesToHex(meta), fileKey: bytesToHex(file) } };
  }
  const meta = hexToBytes(input.metaKey);
  const file = input.fileKey === undefined ? randomBytes(KEY_BYTES) : hexToBytes(input.fileKey);
  if (meta?.length !== KEY_BYTES || file?.length !== KEY_BYTES)
    throw new ValidationError('A key is 32 hex digits.', [], 'KEYSET_KEY_INVALID');
  if (!meta.some(Boolean) || !file.some(Boolean) || bytesToHex(meta) === bytesToHex(file))
    throw new ValidationError(
      'Use two different keys, and not the factory default.',
      [],
      'KEYSET_KEY_WEAK',
    );
  return { meta, file, shown: null };
}

export function slug(): string {
  let out = '';
  // 252 = 7 x 36: bytes above it are dropped so every character is equally likely.
  while (out.length < 8)
    for (const b of randomBytes(16)) if (b < 252 && out.length < 8) out += SLUG_CHARS[b % 36];
  return out;
}

/**
 * Entered keys must be new to the org: a key any keyset of it, in either mode, has ever used (retired and
 * disabled ones included) is not a rotation, and one key in two keysets lets a tap's slug be swapped for the other.
 */
export async function assertKeysUnused(
  ctx: ServiceContext,
  orgId: string,
  meta: Uint8Array,
  file: Uint8Array,
): Promise<void> {
  const ring = await loadKekRing(ctx.env);
  for (const v of await orgVersionEnvelopes(ctx.env.DB, orgId)) {
    const old = await openVersion(
      ring,
      { orgId, mode: v.mode, keysetId: v.keysetId, keyId: v.id, version: v.version },
      v.envelope,
    );
    if ([old.meta, old.file].some((k) => constantTimeEqual(k, meta) || constantTimeEqual(k, file)))
      throw new ValidationError(
        'Enter keys this organization has not used.',
        [],
        'KEYSET_KEY_REUSED',
      );
  }
}
