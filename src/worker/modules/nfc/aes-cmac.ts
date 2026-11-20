/** AES-CMAC (RFC 4493) over WebCrypto. WebCrypto has no ECB, so one zero-IV CBC pass stands in. */

const BLOCK = 16;
const ZERO_IV = new Uint8Array(BLOCK);

const importKey = (key: Uint8Array) =>
  crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);

/** Left-shift by one bit; the carry folds back as 0x87 (the GF(2^128) reduction). */
function double(block: Uint8Array): Uint8Array {
  const out = new Uint8Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) {
    out[i] = ((block[i] as number) << 1) & 0xff;
    if (i < BLOCK - 1) out[i] = (out[i] as number) | ((block[i + 1] as number) >> 7);
  }
  if (((block[0] as number) & 0x80) !== 0) out[BLOCK - 1] = (out[BLOCK - 1] as number) ^ 0x87;
  return out;
}

/** CBC-encrypts whole blocks with a zero IV and returns the last ciphertext block. */
async function cbcMacBlocks(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const out = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-CBC', iv: ZERO_IV }, key, data),
  );
  // WebCrypto appends one padding block; the MAC is the block for the last data block.
  return out.slice(data.length - BLOCK, data.length);
}

export async function aesCmac(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const k = await importKey(key);
  const l = await cbcMacBlocks(k, new Uint8Array(BLOCK));
  const k1 = double(l);
  const complete = message.length > 0 && message.length % BLOCK === 0;
  const blocks = complete ? message.length / BLOCK : Math.ceil(message.length / BLOCK) || 1;
  const padded = new Uint8Array(blocks * BLOCK);
  padded.set(message);
  if (!complete) padded[message.length] = 0x80;
  const subkey = complete ? k1 : double(k1);
  const last = padded.length - BLOCK;
  for (let i = 0; i < BLOCK; i++)
    padded[last + i] = (padded[last + i] as number) ^ (subkey[i] as number);
  return cbcMacBlocks(k, padded);
}

/** AES-128-CBC decrypt, zero IV, no padding (one or more whole blocks). */
export async function aesCbcDecryptNoPad(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await importKey(key);
  // WebCrypto always strips PKCS#7, so append a valid padding block: encrypt 16 bytes of 0x10
  // chained from the last ciphertext block, then decrypt everything and drop the pad.
  const pad = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-CBC', iv: data.slice(data.length - BLOCK) },
      k,
      new Uint8Array(0),
    ),
  );
  const full = new Uint8Array(data.length + BLOCK);
  full.set(data);
  full.set(pad.slice(0, BLOCK), data.length);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ZERO_IV }, k, full));
}
