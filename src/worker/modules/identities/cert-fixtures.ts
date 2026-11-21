import * as asn1 from 'asn1js';
import * as pki from 'pkijs';
import { engine, pemFromDer } from './cert.ts';

const RSA = {
  name: 'RSASSA-PKCS1-v1_5',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
};

function name(entries: [string, string][]): pki.RelativeDistinguishedNames {
  return new pki.RelativeDistinguishedNames({
    typesAndValues: entries.map(
      ([type, value]) =>
        new pki.AttributeTypeAndValue({ type, value: new asn1.Utf8String({ value }) }),
    ),
  });
}

export interface FakeWwdr {
  certificate: pki.Certificate;
  /** PEM, for `intermediatePem`. */
  pem: string;
  key: CryptoKey;
}

/** A throwaway stand-in for WWDR G4. Tests pass its PEM as the intermediate; production keeps the real one. */
export async function createFakeWwdr(now: number, days = 3650): Promise<FakeWwdr> {
  const keys = (await crypto.subtle.generateKey(RSA, true, ['sign', 'verify'])) as CryptoKeyPair;
  const certificate = new pki.Certificate();
  certificate.version = 2;
  certificate.serialNumber = new asn1.Integer({ value: 1 });
  certificate.subject = name([['2.5.4.3', 'Fake WWDR']]);
  certificate.issuer = certificate.subject;
  certificate.notBefore.value = new Date(now - 86400_000);
  certificate.notAfter.value = new Date(now + days * 86400_000);
  await certificate.subjectPublicKeyInfo.importKey(keys.publicKey, engine);
  await certificate.sign(keys.privateKey, 'SHA-256', engine);
  return {
    certificate,
    pem: pemFromDer('CERTIFICATE', certificate.toSchema(true).toBER(false)),
    key: keys.privateKey,
  };
}

/** What Apple does with a CSR: a pass type certificate for the CSR's public key, signed by the CA. */
export async function issueFromCsr(
  csrDer: Uint8Array,
  ca: FakeWwdr,
  subject: { passTypeIdentifier: string; teamIdentifier: string },
  options: { now: number; days?: number },
): Promise<Uint8Array> {
  const parsed = asn1.fromBER(
    csrDer.buffer.slice(csrDer.byteOffset, csrDer.byteOffset + csrDer.byteLength) as ArrayBuffer,
  );
  const request = new pki.CertificationRequest({ schema: parsed.result });
  const cert = new pki.Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1.Integer({ value: 2 });
  cert.subject = name([
    ['0.9.2342.19200300.100.1.1', subject.passTypeIdentifier],
    ['2.5.4.11', subject.teamIdentifier],
    ['2.5.4.3', `Pass Type ID: ${subject.passTypeIdentifier}`],
  ]);
  cert.issuer = ca.certificate.subject;
  cert.notBefore.value = new Date(options.now - 3600_000);
  cert.notAfter.value = new Date(options.now + (options.days ?? 365) * 86400_000);
  cert.subjectPublicKeyInfo = request.subjectPublicKeyInfo;
  await cert.sign(ca.key, 'SHA-256', engine);
  return new Uint8Array(cert.toSchema(true).toBER(false));
}
