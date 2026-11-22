import { fromBER } from 'asn1js';
import { CertificationRequest } from 'pkijs';
import { refuse } from './policy.ts';

/** The CSR subject the provisioner accepts: CN is the pass type identifier, nothing else. */
export function csrSubjectFor(identifier: string): string {
  return identifier;
}

/** Accepts a self-signed RSA-2048 PKCS#10 whose only subject attribute is CN = the pass type identifier. */
export async function assertCsr(der: Uint8Array, identifier: string): Promise<void> {
  if (der.byteLength < 200 || der.byteLength > 2048) refuse('CSR size is out of range.');
  const asn1 = fromBER(der.slice().buffer);
  if (asn1.offset === -1 || asn1.offset !== der.byteLength) refuse('CSR is not DER.');
  let csr: CertificationRequest;
  try {
    csr = new CertificationRequest({ schema: asn1.result });
  } catch (error) {
    refuse(`CSR does not parse: ${error instanceof Error ? error.name : 'error'}.`);
  }
  if (csr.attributes && csr.attributes.length > 0) refuse('CSR must carry no attributes.');
  const subject = csr.subject.typesAndValues;
  const [only] = subject;
  if (
    subject.length !== 1 ||
    only?.type !== '2.5.4.3' ||
    only.value.valueBlock.value !== csrSubjectFor(identifier)
  )
    refuse('CSR subject must be CN with the pass type identifier.');
  const spki = csr.subjectPublicKeyInfo;
  if (spki.algorithm.algorithmId !== '1.2.840.113549.1.1.1') refuse('CSR key must be RSA.');
  const key = spki.parsedKey as unknown as {
    modulus: { valueBlock: { valueHexView: Uint8Array } };
    publicExponent: { valueBlock: { valueHexView: Uint8Array } };
  };
  const modulus = new Uint8Array(key.modulus.valueBlock.valueHexView);
  const exponent = key.publicExponent.valueBlock.valueHexView;
  if (exponent.length !== 3 || exponent[0] !== 1 || exponent[1] !== 0 || exponent[2] !== 1)
    refuse('CSR key exponent must be 65537.');
  const bytes = modulus[0] === 0 ? modulus.subarray(1) : modulus;
  if (bytes.length !== 256 || (bytes[0] ?? 0) < 0x80) refuse('CSR key must be RSA-2048.');
  if (!(await csr.verify())) refuse('CSR signature is invalid.');
}
