import type { Mode } from '../../../shared/contracts/common.ts';
import { derivedHmacKey } from '../../platform/crypto.ts';
import { toHex } from '../../platform/ids.ts';

/**
 * The stored identity of a tag: a keyed HMAC of its UID per org and mode, on the oldest KEK (the label is
 * not rotatable, like pass-credential-tombstone-v1). A database leak gives no UIDs, and a test tag and a
 * live tag of the same UID are different rows.
 */
export async function tagRef(
  env: object,
  orgId: string,
  mode: Mode,
  uid: string,
): Promise<{ ref: string; hint: string }> {
  const key = await derivedHmacKey(env, 'nfc-tag-ref-v1');
  const input = new TextEncoder().encode(JSON.stringify([orgId, mode, canonicalUid(uid)]));
  const ref = toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, input)));
  return { ref, hint: ref.slice(0, 4).toUpperCase() };
}

const UID = /^(?:[0-9a-f]{8}|[0-9a-f]{14}|[0-9a-f]{20})$/;

/** Lower-case hex of a 4, 7 or 10 byte UID. Anything else is not a tag ID. */
export function canonicalUid(uid: string): string {
  const hex = uid.toLowerCase();
  if (!UID.test(hex)) throw new RangeError('A tag ID has 4, 7 or 10 bytes.');
  return hex;
}

/** How a USB reader types a UID. */
export type TagIdFormat = 'hex' | 'hex-reversed' | 'decimal' | 'decimal-reversed';

const reverse = (hex: string): string => (hex.match(/../g) ?? []).reverse().join('');

/**
 * Maps what a keyboard-wedge reader typed to the canonical UID hex, so the same fob read by a phone and by a
 * reader hashes to one ref. Separators (`:`, `-`, space) and `0x` are dropped. A decimal ID is a 4 byte UID.
 * Returns null when the text is not a tag ID in that format.
 */
export function normalizeTagId(text: string, format: TagIdFormat = 'hex'): string | null {
  const plain = text
    .trim()
    .replace(/^0x/i, '')
    .replace(/[\s:-]/g, '');
  let hex = plain;
  if (format === 'decimal' || format === 'decimal-reversed') {
    if (!/^\d{1,10}$/.test(plain) || Number(plain) > 0xffff_ffff) return null;
    hex = Number(plain).toString(16).padStart(8, '0');
  }
  if (format === 'hex-reversed' || format === 'decimal-reversed') hex = reverse(hex);
  hex = hex.toLowerCase();
  return UID.test(hex) ? hex : null;
}
