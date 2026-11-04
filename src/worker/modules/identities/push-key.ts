import { fromBase64 } from '../../platform/ids.ts';
import { invalid } from './cert.ts';

const KEY_ID = /^[A-Z0-9]{10}$/;
const P8 = /^-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----$/;

export const ES256_IMPORT = { name: 'ECDSA', namedCurve: 'P-256' } as const;

export function checkKeyId(keyId: string): string {
  const id = keyId.trim();
  if (!KEY_ID.test(id))
    throw invalid(
      'The key ID is 10 letters and digits, as shown in Apple Developer.',
      'PUSH_KEY_ID',
    );
  return id;
}

/** DER bytes of a PKCS#8 EC P-256 private key from a `.p8` file; throws a ValidationError otherwise. */
export async function readP8(text: string): Promise<Uint8Array> {
  const trimmed = text.trim();
  if (/BEGIN (ENCRYPTED|RSA|EC) PRIVATE KEY/.test(trimmed))
    throw invalid('Not an APNs key. Upload the .p8 from Apple Developer.', 'PUSH_KEY_FORMAT');
  const match = P8.exec(trimmed);
  if (!match?.[1])
    throw invalid('Not a .p8 file. Expected a BEGIN PRIVATE KEY block.', 'PUSH_KEY_FORMAT');
  let der: Uint8Array;
  try {
    der = fromBase64(match[1].replace(/\s+/g, ''));
  } catch {
    throw invalid('The .p8 file is not valid base64.', 'PUSH_KEY_FORMAT');
  }
  try {
    await importSigningKey(der);
  } catch {
    throw invalid('The key is not an EC P-256 key. Upload an APNs .p8.', 'PUSH_KEY_CURVE');
  }
  return der;
}

export function importSigningKey(der: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', der as BufferSource, ES256_IMPORT, false, ['sign']);
}
