import { describe, expect, it } from 'vitest';
import { createFakeWwdr, issueFromCsr } from './cert-fixtures.ts';
import { buildIdentityMaterial } from './certificates.ts';
import { generateCsr } from './csr.ts';

const NOW = Date.UTC(2026, 10, 20);
const PTI = 'pass.mobile.passbook.acme';
const TEAM = '48H7CLBV8Y';

async function setup(subject = { passTypeIdentifier: PTI, teamIdentifier: TEAM }, days = 365) {
  const ca = await createFakeWwdr(NOW);
  const csr = await generateCsr(PTI);
  const certificateDer = await issueFromCsr(csr.csrDer, ca, subject, { now: NOW, days });
  return {
    csr,
    ca,
    input: {
      certificateDer,
      privateKeyPem: csr.privateKeyPem,
      passTypeIdentifier: PTI,
      teamIdentifier: TEAM,
      intermediatePem: ca.pem,
      now: NOW,
    },
  };
}

describe('buildIdentityMaterial', () => {
  it('accepts a certificate issued for the CSR and reports its details', async () => {
    const { input } = await setup();
    const out = await buildIdentityMaterial(input);
    expect(out.details.passTypeIdentifier).toBe(PTI);
    expect(out.details.teamIdentifier).toBe(TEAM);
    expect(out.certificatePem).toContain('BEGIN CERTIFICATE');
    expect(out.details.notAfter).toBeGreaterThan(NOW);
  });

  it('refuses another pass type ID', async () => {
    const { input } = await setup({
      passTypeIdentifier: 'pass.mobile.passbook.other',
      teamIdentifier: TEAM,
    });
    await expect(buildIdentityMaterial(input)).rejects.toMatchObject({ code: 'CERT_PTI_MISMATCH' });
  });

  it('refuses another team', async () => {
    const { input } = await setup({ passTypeIdentifier: PTI, teamIdentifier: 'OTHERTEAM1' });
    await expect(buildIdentityMaterial(input)).rejects.toMatchObject({
      code: 'CERT_TEAM_MISMATCH',
    });
  });

  it('refuses a certificate for a different key', async () => {
    const { input } = await setup();
    const other = await generateCsr(PTI);
    await expect(
      buildIdentityMaterial({ ...input, privateKeyPem: other.privateKeyPem }),
    ).rejects.toMatchObject({ code: 'KEY_MISMATCH' });
  });

  it('refuses a chain that does not end at the WWDR intermediate', async () => {
    const { input } = await setup();
    const stranger = await createFakeWwdr(NOW);
    await expect(
      buildIdentityMaterial({ ...input, intermediatePem: stranger.pem }),
    ).rejects.toMatchObject({ code: 'CERT_CHAIN_INVALID' });
  });

  it('refuses the real WWDR G4 for a fake chain (production validation is intact)', async () => {
    const { input } = await setup();
    await expect(
      buildIdentityMaterial({ ...input, intermediatePem: undefined }),
    ).rejects.toMatchObject({ code: 'CERT_CHAIN_INVALID' });
  });

  it('refuses an expired certificate', async () => {
    const { input } = await setup();
    await expect(
      buildIdentityMaterial({ ...input, now: NOW + 400 * 86400_000 }),
    ).rejects.toMatchObject({ code: 'CERT_EXPIRED' });
  });
});
