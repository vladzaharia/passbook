import { aesCmac } from './aes-cmac.ts';

const DIV_CONST_AES128 = 0x01;

/**
 * NXP AN10922 AES-128 key diversification: CMAC(master, 0x01 || input). `input` is the
 * diversification data (1 to 31 bytes; the tag UID for NTAG 424 DNA).
 */
export async function diversifyKey(master: Uint8Array, input: Uint8Array): Promise<Uint8Array> {
  const data = new Uint8Array(1 + input.length);
  data[0] = DIV_CONST_AES128;
  data.set(input, 1);
  return aesCmac(master, data);
}
