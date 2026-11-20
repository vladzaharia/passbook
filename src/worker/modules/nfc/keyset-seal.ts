import type { Mode } from '../../../shared/contracts/common.ts';
import {
  credentialAad,
  decryptSecret,
  type Envelope,
  encryptSecret,
  type KekRing,
} from '../../platform/crypto.ts';
import { AppError } from '../../platform/errors.ts';
import { fromBase64, toBase64 } from '../../platform/ids.ts';

/**
 * Secure-tag keys at rest: AES-128 keys sealed with the platform envelope (`platform/crypto.ts`) and stored as
 * `v1.<kek>.<iv>.<wrapped dek>.<ciphertext>`. The AAD binds each seal to its org, mode, keyset and version (or
 * tag), so a row copied to another keyset, mode, tag or org does not open.
 */
export const KEY_BYTES = 16;

export interface KeysetScope {
  orgId: string;
  mode: Mode;
  keysetId: string;
}

export type KeyRole = 'meta' | 'file';

const roleAad = (s: KeysetScope, role: KeyRole, version: number) =>
  credentialAad(s.keysetId, s.orgId, `nfc_sun_${role}:${s.mode}:v${version}`);
const tagAad = (s: KeysetScope, tagId: string) =>
  credentialAad(tagId, s.orgId, `nfc_sun_tag:${s.mode}:${s.keysetId}`);

export const unreadable = () =>
  new AppError('TAG_KEY_UNREADABLE', 500, 'A tag key could not be read.');

const text = (e: Envelope) =>
  `v1.${e.kekVersion}.${toBase64(e.iv)}.${toBase64(e.wrappedDek)}.${toBase64(e.ciphertext)}`;

function parse(value: string): Envelope {
  const [v, kek, iv, wrappedDek, ciphertext, ...extra] = value.split('.');
  if (
    v !== 'v1' ||
    !kek ||
    !iv ||
    !wrappedDek ||
    !ciphertext ||
    extra.length ||
    !/^[1-9]\d*$/.test(kek)
  )
    throw unreadable();
  try {
    return {
      kekVersion: Number(kek),
      iv: fromBase64(iv),
      wrappedDek: fromBase64(wrappedDek),
      ciphertext: fromBase64(ciphertext),
    };
  } catch {
    throw unreadable();
  }
}

async function seal(ring: KekRing, key: Uint8Array, aad: string): Promise<string> {
  if (key.length !== KEY_BYTES) throw unreadable();
  return text(await encryptSecret(ring, key, aad));
}

/** Fails with TAG_KEY_UNREADABLE on a wrong AAD, a wrong KEK, a damaged value or a key of the wrong length. */
async function open(ring: KekRing, sealed: string, aad: string): Promise<Uint8Array> {
  let key: Uint8Array;
  try {
    key = await decryptSecret(ring, parse(sealed), aad);
  } catch {
    throw unreadable();
  }
  if (key.length !== KEY_BYTES) throw unreadable();
  return key;
}

export const sealKeyVersion = (
  ring: KekRing,
  s: KeysetScope,
  role: KeyRole,
  version: number,
  key: Uint8Array,
) => seal(ring, key, roleAad(s, role, version));
export const openKeyVersion = (
  ring: KekRing,
  s: KeysetScope,
  role: KeyRole,
  version: number,
  sealed: string,
) => open(ring, sealed, roleAad(s, role, version));
/** A supplier's per-tag file key (`nfc_tag_sun.file_key`). */
export const sealTagKey = (ring: KekRing, s: KeysetScope, tagId: string, key: Uint8Array) =>
  seal(ring, key, tagAad(s, tagId));
export const openTagKey = (ring: KekRing, s: KeysetScope, tagId: string, sealed: string) =>
  open(ring, sealed, tagAad(s, tagId));
