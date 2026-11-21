import wwdrG4 from '../../../generated/wwdr-g4.ts';
import { buildManifest, signManifest } from '../../../passkit/sign/index.ts';
import { type IdentityCheck, invalid, pemFromDer, validateIdentityMaterial } from './cert.ts';

export interface IssuedCertificateInput {
  /** The certificate Apple returned. */
  certificateDer: Uint8Array;
  /** The pending key's PKCS#8 PEM. */
  privateKeyPem: string;
  passTypeIdentifier: string;
  teamIdentifier: string;
  intermediatePem?: string;
  now: number;
}

/**
 * Turns Apple's certificate plus the pending key into identity material: chain to WWDR, pass type
 * and team match, key match, dates, then a probe signature. Throws a ValidationError with a stable
 * code on any failure; nothing is written.
 */
export async function buildIdentityMaterial(input: IssuedCertificateInput): Promise<IdentityCheck> {
  const checked = await validateIdentityMaterial({
    certificatePem: pemFromDer('CERTIFICATE', input.certificateDer),
    privateKeyPem: input.privateKeyPem,
    intermediatePem: input.intermediatePem,
    now: input.now,
  });
  const { details } = checked;
  if (details.passTypeIdentifier !== input.passTypeIdentifier)
    throw invalid(
      'The certificate is for a different pass type ID than this identity.',
      'CERT_PTI_MISMATCH',
    );
  if (details.teamIdentifier !== input.teamIdentifier)
    throw invalid(
      'The certificate is for a different team than this identity.',
      'CERT_TEAM_MISMATCH',
    );
  await probeSign(checked, input);
  return checked;
}

/** Signs a one-file manifest with the new material; proves the pair works for passes. */
async function probeSign(checked: IdentityCheck, input: IssuedCertificateInput): Promise<void> {
  const { bytes } = await buildManifest({ 'pass.json': new TextEncoder().encode('{}') });
  try {
    await signManifest(
      bytes,
      {
        certificate: checked.certificatePem,
        privateKey: checked.privateKeyPem,
        intermediate: input.intermediatePem ?? wwdrG4,
      },
      {
        now: new Date(input.now),
        expectedIdentity: {
          passTypeIdentifier: input.passTypeIdentifier,
          teamIdentifier: input.teamIdentifier,
        },
      },
    );
  } catch {
    throw invalid(
      'The new certificate cannot sign a pass. Retry the renewal.',
      'CERT_PROBE_FAILED',
    );
  }
}
