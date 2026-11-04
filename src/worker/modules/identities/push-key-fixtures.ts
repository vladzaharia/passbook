import { toBase64 } from '../../platform/ids.ts';

const wrap = (der: Uint8Array) =>
  `-----BEGIN PRIVATE KEY-----\n${toBase64(der)
    .match(/.{1,64}/g)
    ?.join('\n')}\n-----END PRIVATE KEY-----\n`;

/** A throwaway APNs .p8: PKCS#8 EC P-256, plus the public key to verify signatures. */
export async function makeP8(curve: 'P-256' | 'P-384' = 'P-256') {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: curve }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const der = new Uint8Array(
    (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer,
  );
  return { pem: wrap(der), publicKey: pair.publicKey, privateKey: pair.privateKey };
}

export async function makeRsaPem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign'],
  )) as CryptoKeyPair;
  return wrap(
    new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer),
  );
}
