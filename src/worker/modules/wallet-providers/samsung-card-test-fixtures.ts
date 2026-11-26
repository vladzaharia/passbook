import { constants, privateDecrypt } from 'node:crypto';
import { compactVerify, importX509 } from 'jose';
import { fromBase64Url } from '../../platform/ids.ts';

/** Opens a Get Card Data `cdata`: the JWS around a JWE sealed to the partner certificate. */
export async function decryptCard(
  cdata: string,
  certificate: string,
  privateKey: string,
): Promise<unknown> {
  const outer = await compactVerify(cdata, await importX509(certificate, 'RS256'), {
    algorithms: ['RS256'],
  });
  const compact = new TextDecoder().decode(outer.payload).split('.');
  if (compact.length !== 5) throw new Error('Invalid encrypted card fixture');
  const [header = '', wrapped = '', iv = '', ciphertext = '', tag = ''] = compact;
  const block = privateDecrypt(
    { key: privateKey, padding: constants.RSA_NO_PADDING },
    fromBase64Url(wrapped),
  );
  const separator = block.indexOf(0, 2);
  if (block[0] !== 0 || block[1] !== 2 || separator < 10) throw new Error('Invalid key envelope');
  const key = await crypto.subtle.importKey(
    'raw',
    block.subarray(separator + 1),
    'AES-GCM',
    false,
    ['decrypt'],
  );
  const plain = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: fromBase64Url(iv) as BufferSource,
      additionalData: new TextEncoder().encode(header),
      tagLength: 128,
    },
    key,
    new Uint8Array([...fromBase64Url(ciphertext), ...fromBase64Url(tag)]),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}
