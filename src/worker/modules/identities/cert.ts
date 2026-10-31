import * as asn1 from 'asn1js';
import * as pki from 'pkijs';
import wwdrG4 from '../../../generated/wwdr-g4.ts';
import { ValidationError } from '../../platform/errors.ts';

const UID_OID = '0.9.2342.19200300.100.1.1';
const OU_OID = '2.5.4.11';
const NAME_OIDS: Record<string, string> = {
  '2.5.4.3': 'CN',
  '2.5.4.11': 'OU',
  '2.5.4.10': 'O',
  '2.5.4.6': 'C',
  [UID_OID]: 'UID',
};

const engine = new pki.CryptoEngine({
  name: 'WebCrypto',
  crypto,
  subtle: crypto.subtle,
}) as unknown as pki.ICryptoEngine;

export interface CertDetails {
  sha256: string;
  subject: string;
  serial: string;
  passTypeIdentifier: string | undefined;
  teamIdentifier: string | undefined;
  notBefore: number;
  notAfter: number;
}

export function invalid(message: string, code: string): ValidationError {
  return new ValidationError(message, [], code);
}

export function pemBlocks(pem: string, label: string): string[] {
  const re = new RegExp(`-----BEGIN ${label}-----([\\s\\S]+?)-----END ${label}-----`, 'g');
  return [...pem.matchAll(re)].map((m) => m[0]);
}

export function derFromPem(pem: string): Uint8Array {
  const body = pem.replace(/-----[^-]+-----|\s/g, '');
  try {
    return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  } catch {
    throw invalid('The PEM is not valid base64.', 'PEM_INVALID');
  }
}

export function pemFromDer(label: string, der: ArrayBuffer | Uint8Array): string {
  const bytes = der instanceof Uint8Array ? der : new Uint8Array(der);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const lines =
    btoa(binary)
      .match(/.{1,64}/g)
      ?.join('\n') ?? '';
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function hex(buffer: ArrayBuffer | Uint8Array): string {
  return Array.from(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

export function parseCertificate(pem: string): pki.Certificate {
  const parsed = asn1.fromBER(toBuffer(derFromPem(pem)));
  if (parsed.offset === -1) throw invalid('The certificate is not valid PEM/DER.', 'CERT_INVALID');
  try {
    return new pki.Certificate({ schema: parsed.result });
  } catch {
    throw invalid('The certificate is not valid PEM/DER.', 'CERT_INVALID');
  }
}

function subjectValue(cert: pki.Certificate, oid: string): string | undefined {
  const value = cert.subject.typesAndValues.find((v) => v.type === oid)?.value.valueBlock.value;
  return typeof value === 'string' ? value : undefined;
}

function subjectString(cert: pki.Certificate): string {
  return cert.subject.typesAndValues
    .map((v) => `${NAME_OIDS[v.type] ?? v.type}=${v.value.valueBlock.value}`)
    .join(', ');
}

export async function certDetails(pem: string): Promise<CertDetails> {
  const cert = parseCertificate(pem);
  return {
    sha256: hex(await crypto.subtle.digest('SHA-256', toBuffer(derFromPem(pem)))),
    subject: subjectString(cert),
    serial: hex(cert.serialNumber.valueBlock.valueHexView),
    passTypeIdentifier: subjectValue(cert, UID_OID),
    teamIdentifier: subjectValue(cert, OU_OID),
    notBefore: cert.notBefore.value.getTime(),
    notAfter: cert.notAfter.value.getTime(),
  };
}

/** PKCS#8 PEM only; says what to do for the common wrong formats. */
export function checkKeyPem(pem: string): string {
  if (/BEGIN ENCRYPTED PRIVATE KEY/.test(pem))
    throw invalid(
      'The private key is encrypted. Decrypt it first or upload a PKCS#12 file.',
      'KEY_ENCRYPTED',
    );
  if (/BEGIN (RSA|EC) PRIVATE KEY/.test(pem))
    throw invalid(
      'The private key is not PKCS#8. Convert it with openssl pkcs8 -topk8 -nocrypt.',
      'KEY_FORMAT',
    );
  const [block] = pemBlocks(pem, 'PRIVATE KEY');
  if (!block) throw invalid('No PKCS#8 private key found in the PEM.', 'KEY_MISSING');
  return block;
}

export interface IdentityCheck {
  details: CertDetails;
  certificatePem: string;
  privateKeyPem: string;
}

/**
 * Validates an uploaded pass-type certificate and key: format, validity window, Apple subject
 * fields, chain to the intermediate, and that the key belongs to the certificate.
 */
export async function validateIdentityMaterial(input: {
  certificatePem: string;
  privateKeyPem: string;
  intermediatePem?: string;
  now: number;
}): Promise<IdentityCheck> {
  const [certificatePem] = pemBlocks(input.certificatePem, 'CERTIFICATE');
  if (!certificatePem) throw invalid('No certificate found in the PEM.', 'CERT_MISSING');
  const privateKeyPem = checkKeyPem(input.privateKeyPem);
  const cert = parseCertificate(certificatePem);
  const details = await certDetails(certificatePem);

  if (!details.passTypeIdentifier || !details.teamIdentifier)
    throw invalid(
      'The certificate has no pass type ID or team ID. Upload a Pass Type ID certificate.',
      'CERT_NOT_PASS_TYPE',
    );
  if (details.notBefore > input.now)
    throw invalid('The certificate is not valid yet.', 'CERT_NOT_YET_VALID');
  if (details.notAfter < input.now) throw invalid('The certificate has expired.', 'CERT_EXPIRED');

  const intermediate = parseCertificate(input.intermediatePem ?? wwdrG4);
  if (
    !cert.issuer.isEqual(intermediate.subject) ||
    !(await cert.verify(intermediate, engine).catch(() => false))
  )
    throw invalid('The certificate was not issued by Apple WWDR G4.', 'CERT_CHAIN_INVALID');
  if (intermediate.notAfter.value.getTime() < input.now)
    throw invalid('The WWDR intermediate has expired.', 'CERT_CHAIN_EXPIRED');

  await assertKeyMatches(privateKeyPem, cert);
  return { details, certificatePem, privateKeyPem };
}

async function assertKeyMatches(privateKeyPem: string, cert: pki.Certificate): Promise<void> {
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'pkcs8',
      toBuffer(derFromPem(privateKeyPem)),
      algorithm,
      false,
      ['sign'],
    );
  } catch {
    throw invalid('The private key is not a valid RSA PKCS#8 key.', 'KEY_INVALID');
  }
  const probe = crypto.getRandomValues(new Uint8Array(32));
  const signature = await crypto.subtle.sign(algorithm, key, probe);
  const spki = cert.subjectPublicKeyInfo.toSchema().toBER(false);
  const publicKey = await crypto.subtle
    .importKey('spki', spki, algorithm, false, ['verify'])
    .catch(() => null);
  if (!publicKey || !(await crypto.subtle.verify(algorithm, publicKey, signature, probe)))
    throw invalid('The private key does not match the certificate.', 'KEY_MISMATCH');
}
