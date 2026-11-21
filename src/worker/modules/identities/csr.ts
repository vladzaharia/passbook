import * as asn1 from 'asn1js';
import * as pki from 'pkijs';
import { sha256Hex } from '../../platform/ids.ts';
import { engine, pemFromDer } from './cert.ts';

const CN_OID = '2.5.4.3';
const RSA = {
  name: 'RSASSA-PKCS1-v1_5',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
};

export interface GeneratedCsr {
  /** PKCS#10 DER; Apple takes it base64 encoded. */
  csrDer: Uint8Array;
  /** PKCS#8 PEM. Secret: encrypt it before it leaves the caller. */
  privateKeyPem: string;
  /** SHA-256 (hex) of the SubjectPublicKeyInfo DER. Matches a certificate back to this key. */
  pubkeySha256: string;
}

/** SHA-256 (hex) of a certificate's or request's SubjectPublicKeyInfo DER. */
export function spkiSha256(info: pki.PublicKeyInfo): Promise<string> {
  return sha256Hex(new Uint8Array(info.toSchema().toBER(false)));
}

/** SHA-256 (hex) of the public key inside a certificate DER, or null when it does not parse. */
export async function certPubkeySha256(der: Uint8Array): Promise<string | null> {
  const parsed = asn1.fromBER(
    der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) as ArrayBuffer,
  );
  if (parsed.offset === -1) return null;
  try {
    return await spkiSha256(new pki.Certificate({ schema: parsed.result }).subjectPublicKeyInfo);
  } catch {
    return null;
  }
}

/** RSA-2048 key and a CSR whose subject is the pass type identifier as CN and nothing else. */
export async function generateCsr(passTypeIdentifier: string): Promise<GeneratedCsr> {
  const keys = (await crypto.subtle.generateKey(RSA, true, ['sign', 'verify'])) as CryptoKeyPair;
  const request = new pki.CertificationRequest();
  request.version = 0;
  request.subject.typesAndValues.push(
    new pki.AttributeTypeAndValue({
      type: CN_OID,
      value: new asn1.Utf8String({ value: passTypeIdentifier }),
    }),
  );
  await request.subjectPublicKeyInfo.importKey(keys.publicKey, engine);
  await request.sign(keys.privateKey, 'SHA-256', engine);
  const pkcs8 = (await crypto.subtle.exportKey('pkcs8', keys.privateKey)) as ArrayBuffer;
  return {
    csrDer: new Uint8Array(request.toSchema().toBER(false)),
    privateKeyPem: pemFromDer('PRIVATE KEY', pkcs8),
    pubkeySha256: await spkiSha256(request.subjectPublicKeyInfo),
  };
}
