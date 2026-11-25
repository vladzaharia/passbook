import { type Point, verifyUidSignature } from './p224.ts';

/** NXP's public key for the NTAG 424 DNA originality signature (AN12196 section 7.2, secp224r1). Fixed in code: never read from config or a request. */
const NXP_ORIGINALITY_KEY: Point = [
  0x8a9b380af2ee1b98dc417fecc263f8449c7625cece82d9b916c992dan,
  0x209d68422b81ec20b65a66b5102a61596af3379200599316a00a1410n,
];

/** True when NXP signed this UID. */
export const verifyOriginality = (uid: Uint8Array, signature: Uint8Array): boolean =>
  verifyUidSignature(NXP_ORIGINALITY_KEY, uid, signature);
