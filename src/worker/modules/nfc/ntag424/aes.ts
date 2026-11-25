import { aesCbcDecryptNoPad } from '../aes-cmac.ts';
import { xor } from './bytes.ts';

const BLOCK = 16;

/** AES-128-CBC encrypt, no padding (whole blocks), any IV. WebCrypto always pads, so the extra block is dropped. */
export async function cbcEncrypt(
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  if (data.length === 0 || data.length % BLOCK !== 0) throw new RangeError('whole blocks only');
  const k = await crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['encrypt']);
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, k, data));
  return out.slice(0, data.length);
}

/** AES-128-CBC decrypt, no padding, any IV: a zero-IV pass, then the IV folds into the first block. */
export async function cbcDecrypt(
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  const plain = await aesCbcDecryptNoPad(key, data);
  plain.set(xor(plain.slice(0, BLOCK), iv));
  return plain;
}
