import { aesCmac } from '../aes-cmac.ts';
import { cbcDecrypt, cbcEncrypt } from './aes.ts';
import { INS, native } from './apdu.ts';
import { concat, Ntag424Error, xor, ZERO16 } from './bytes.ts';

/** An authenticated EV2 session: the keys, the transaction id and the command counter of the next command. */
export interface Ev2Session {
  keyNo: number;
  ti: Uint8Array;
  encKey: Uint8Array;
  macKey: Uint8Array;
  ctr: number;
  /** A bad MAC or a status other than 9100 ended the session on the tag; no command may use it again. */
  dead: boolean;
}

const rotl = (b: Uint8Array): Uint8Array => concat(b.slice(1), b.slice(0, 1));
const rotr = (b: Uint8Array): Uint8Array => concat(b.slice(15), b.slice(0, 15));

/** `90 71 00 00 02 KeyNo 00 00`: no PCD capabilities. */
export const authFirstApdu = (keyNo: number): Uint8Array =>
  native(INS.authFirst, new Uint8Array([keyNo, 0x00]));

/** SV = label || 00 01 00 80 || A[15:14] || (A[13:8] xor B[15:10]) || B[9:0] || A[7:0], indexes counted from the right. */
function sessionVector(label: [number, number], rndA: Uint8Array, rndB: Uint8Array): Uint8Array {
  return concat(
    new Uint8Array([...label, 0x00, 0x01, 0x00, 0x80]),
    rndA.slice(0, 2),
    xor(rndA.slice(2, 8), rndB.slice(0, 6)),
    rndB.slice(6, 16),
    rndA.slice(8, 16),
  );
}

/** SesAuthENCKey = CMAC(K, A55A SV), SesAuthMACKey = CMAC(K, 5AA5 SV). */
export async function deriveSessionKeys(
  key: Uint8Array,
  rndA: Uint8Array,
  rndB: Uint8Array,
): Promise<{ encKey: Uint8Array; macKey: Uint8Array }> {
  return {
    encKey: await aesCmac(key, sessionVector([0xa5, 0x5a], rndA, rndB)),
    macKey: await aesCmac(key, sessionVector([0x5a, 0xa5], rndA, rndB)),
  };
}

/** Part 2: `E(K, RndA || RndB rotated left)` as the `90 AF` APDU, and the RndB the tag proved it knows the key for. */
export async function authPart2(
  key: Uint8Array,
  encRndB: Uint8Array,
  rndA: Uint8Array,
): Promise<{ apdu: Uint8Array; rndB: Uint8Array }> {
  if (encRndB.length !== 16 || rndA.length !== 16)
    throw new Ntag424Error('NTAG_BAD_RESPONSE', 'The tag challenge is malformed.');
  const rndB = await cbcDecrypt(key, ZERO16, encRndB);
  const body = await cbcEncrypt(key, ZERO16, concat(rndA, rotl(rndB)));
  return { apdu: native(INS.additional, body), rndB };
}

/** Checks the tag's answer to part 2 (`E(K, TI || RndA rotated left || caps)`) and opens the session. */
export async function authFinish(
  key: Uint8Array,
  keyNo: number,
  rndA: Uint8Array,
  rndB: Uint8Array,
  answer: Uint8Array,
): Promise<Ev2Session> {
  if (answer.length !== 32)
    throw new Ntag424Error('NTAG_AUTH_FAILED', 'The tag answer is malformed.');
  const plain = await cbcDecrypt(key, ZERO16, answer);
  let diff = 0;
  const echoed = rotr(plain.slice(4, 20));
  for (let i = 0; i < 16; i++) diff |= (echoed[i] as number) ^ (rndA[i] as number);
  if (diff !== 0) throw new Ntag424Error('NTAG_AUTH_FAILED', 'The tag did not prove its key.');
  const { encKey, macKey } = await deriveSessionKeys(key, rndA, rndB);
  return { keyNo, ti: plain.slice(0, 4), encKey, macKey, ctr: 0, dead: false };
}
