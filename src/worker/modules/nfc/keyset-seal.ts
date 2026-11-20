import type { Mode } from '../../../shared/contracts/common.ts';
import {
  credentialAad,
  decryptSecret,
  type Envelope,
  encryptSecret,
  type KekRing,
} from '../../platform/crypto.ts';
import { AppError } from '../../platform/errors.ts';

/**
 * Secure-tag keys at rest: AES-128 keys sealed with the platform envelope (`platform/crypto.ts`) into the four
 * standard columns, so cron keys.rewrap moves them with the other envelopes (rewrap-tables.ts). The AAD binds
 * each seal to its org, mode, keyset and version (or tag): a row copied elsewhere does not open.
 */
export const KEY_BYTES = 16;

export interface KeyScope {
  orgId: string;
  mode: Mode;
  keysetId: string;
}

/** A keyset version: its row id carries the AAD id, the scope and version the rest. */
export interface VersionScope extends KeyScope {
  keyId: string;
  version: number;
}

/** The AAD kind of a keyset version and of a per-tag key; rewrap-tables.ts builds the same ones. */
export const versionKind = (mode: string, keysetId: string, version: number | string) =>
  `nfc_sun_key:${mode}:${keysetId}:v${version}`;
export const tagKeyKind = (mode: string, keysetId: string) => `nfc_sun_tag:${mode}:${keysetId}`;

export const unreadable = () =>
  new AppError('TAG_KEY_UNREADABLE', 500, 'A tag key could not be read.');

/** The columns of an envelope as D1 returns them. */
export interface EnvelopeRaw {
  kek_version: number;
  iv: number[] | ArrayBuffer;
  wrapped_dek: number[] | ArrayBuffer;
  ciphertext: number[] | ArrayBuffer;
}
export const envelopeOf = (r: EnvelopeRaw): Envelope => ({
  kekVersion: r.kek_version,
  iv: new Uint8Array(r.iv),
  wrappedDek: new Uint8Array(r.wrapped_dek),
  ciphertext: new Uint8Array(r.ciphertext),
});

/** Fails with TAG_KEY_UNREADABLE on a wrong AAD, a wrong KEK, damaged columns or a plaintext of the wrong size. */
async function open(ring: KekRing, e: Envelope, aad: string, bytes: number): Promise<Uint8Array> {
  let plain: Uint8Array;
  try {
    plain = await decryptSecret(ring, e, aad);
  } catch {
    throw unreadable();
  }
  if (plain.length !== bytes) throw unreadable();
  return plain;
}

const versionAad = (s: VersionScope) =>
  credentialAad(s.keyId, s.orgId, versionKind(s.mode, s.keysetId, s.version));
const tagAad = (s: KeyScope, tagId: string) =>
  credentialAad(tagId, s.orgId, tagKeyKind(s.mode, s.keysetId));

/** One envelope for both keys of a version: meta, then file. */
export async function sealVersion(
  ring: KekRing,
  s: VersionScope,
  meta: Uint8Array,
  file: Uint8Array,
): Promise<Envelope> {
  if (meta.length !== KEY_BYTES || file.length !== KEY_BYTES) throw unreadable();
  const both = new Uint8Array(KEY_BYTES * 2);
  both.set(meta);
  both.set(file, KEY_BYTES);
  return encryptSecret(ring, both, versionAad(s));
}

export async function openVersion(ring: KekRing, s: VersionScope, e: Envelope) {
  const both = await open(ring, e, versionAad(s), KEY_BYTES * 2);
  return { meta: both.slice(0, KEY_BYTES), file: both.slice(KEY_BYTES) };
}

/** A supplier's per-tag file key (`nfc_tag_sun` envelope columns). */
export async function sealTagKey(ring: KekRing, s: KeyScope, tagId: string, key: Uint8Array) {
  if (key.length !== KEY_BYTES) throw unreadable();
  return encryptSecret(ring, key, tagAad(s, tagId));
}
export const openTagKey = (ring: KekRing, s: KeyScope, tagId: string, e: Envelope) =>
  open(ring, e, tagAad(s, tagId), KEY_BYTES);
