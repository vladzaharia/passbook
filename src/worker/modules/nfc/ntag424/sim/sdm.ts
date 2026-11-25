import { aesCmac } from '../../aes-cmac.ts';
import { bytesToHex } from '../../sun.ts';
import { cbcEncrypt } from '../aes.ts';
import { concat, macT, u24, ZERO16 } from '../bytes.ts';
import type { NdefFile, SimTag } from './state.ts';

const ascii = (hex: string) => new TextEncoder().encode(hex.toUpperCase());

/**
 * The NDEF file as a reader sees it: with SDM on, 32 digits of encrypted PICCData (`C7 || UID || SDMReadCtr ||
 * random`, under the meta key) and 16 digits of MACt (CMAC of the input range under the session key made from
 * the file key). The read counter moves on every read.
 */
export async function mirroredRead(
  tag: SimTag,
  file: NdefFile,
  random: (n: number) => Uint8Array,
): Promise<Uint8Array> {
  const out = file.data.slice();
  const sdm = file.sdm;
  if (!sdm) return out;
  tag.readCounter += 1;
  const ctr = u24(tag.readCounter);
  const picc = new Uint8Array(16);
  picc[0] = 0xc7;
  picc.set(tag.uid, 1);
  picc.set(ctr, 8);
  picc.set(random(5), 11);
  const enc = await cbcEncrypt(tag.keys[sdm.metaKey] as Uint8Array, ZERO16, picc);
  out.set(ascii(bytesToHex(enc)), sdm.piccOffset);
  const sv2 = concat(new Uint8Array([0x3c, 0xc3, 0x00, 0x01, 0x00, 0x80]), tag.uid, ctr);
  const kses = await aesCmac(tag.keys[sdm.fileKey] as Uint8Array, sv2);
  const input = out.slice(sdm.macInputOffset, sdm.macOffset);
  out.set(ascii(bytesToHex(macT(await aesCmac(kses, input)))), sdm.macOffset);
  return out;
}
