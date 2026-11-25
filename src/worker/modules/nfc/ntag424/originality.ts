import { ecdsaVerify, fromInt, type Point, toInt } from './p224.ts';

/** NXP's public key for the NTAG 424 DNA originality signature (AN12196 section 7.2, secp224r1). */
export const NXP_ORIGINALITY_KEY: Point = [
  0x8a9b380af2ee1b98dc417fecc263f8449c7625cece82d9b916c992dan,
  0x209d68422b81ec20b65a66b5102a61596af3379200599316a00a1410n,
];

/** The signature is 56 bytes, `r || s`, over the 7-byte UID read as a big-endian integer (no hash). */
export function verifyOriginality(
  uid: Uint8Array,
  signature: Uint8Array,
  key: Point = NXP_ORIGINALITY_KEY,
): boolean {
  if (uid.length !== 7 || signature.length !== 56) return false;
  return ecdsaVerify(key, toInt(signature.slice(0, 28)), toInt(signature.slice(28)), toInt(uid));
}

/** `r || s` as the tag returns it. */
export const encodeSignature = (r: bigint, s: bigint): Uint8Array => {
  const out = new Uint8Array(56);
  out.set(fromInt(r, 28));
  out.set(fromInt(s, 28), 28);
  return out;
};
