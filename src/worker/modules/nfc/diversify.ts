import { aesCmac32 } from './aes-cmac.ts';

/**
 * NXP AN10922 section 2.2 AES-128 key diversification: D = 0x01 || input, padded with 0x80 00..
 * to 32 bytes, CMAC with K2 on the last block when padded. `input` is 1 to 31 bytes (the tag UID
 * for NTAG 424 DNA).
 */
export async function diversifyKey(master: Uint8Array, input: Uint8Array): Promise<Uint8Array> {
  if (input.length < 1 || input.length > 31)
    throw new RangeError('diversification input is 1-31 bytes');
  const d = new Uint8Array(32);
  d[0] = 0x01;
  d.set(input, 1);
  const padded = input.length < 31;
  if (padded) d[1 + input.length] = 0x80;
  return aesCmac32(master, d, padded);
}
