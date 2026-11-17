import { beforeAll, describe, expect, it } from 'vitest';
import { stoppedAuditPass } from './act-attempt-audit.ts';
import { StaleScanAuthority } from './act-override.ts';
import { candidateById } from './repo-lookup.ts';
import type { Stop } from './resolve.ts';
import { candidateAudit } from './resolve-candidates.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let templateId: string;
beforeAll(async () => {
  kit = await setupScanKit();
  templateId = await kit.scanTemplate('Audit card', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
});

async function audited() {
  const pass = await kit.scanPass(templateId);
  const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
  if (!candidate) throw new Error('Missing candidate');
  const audit = candidateAudit(candidate);
  const credentials = {
    credentialKeysetCommitment: candidate.credentialKeysetCommitment,
    credentialTombstoneRefs: [],
    otherModeCredentialTombstoneRefs: [],
  };
  const stop = (over: Partial<typeof audit.auditPassSnapshot> = {}) =>
    ({ ...audit, auditPassSnapshot: { ...audit.auditPassSnapshot, ...over } }) as unknown as Stop;
  return { candidate, credentials, stop };
}

describe('the audit of a stopped scan', () => {
  it('keeps the pass when nothing moved', async () => {
    const { candidate, credentials, stop } = await audited();
    expect(stoppedAuditPass(stop(), credentials)?.id).toBe(candidate.pass.id);
  });

  it('refuses a pass that is not the one captured, and does not compare the head release', async () => {
    const { candidate, credentials, stop } = await audited();
    expect(() =>
      stoppedAuditPass(stop({ version: candidate.pass.version + 1 }), credentials),
    ).toThrow(StaleScanAuthority);
    // The release is the commit grant's to check; a head that only republished never refuses here.
    expect(
      stoppedAuditPass(
        stop({ activeReleaseId: 'republished', activeReleaseGeneration: 99 }),
        credentials,
      )?.id,
    ).toBe(candidate.pass.id);
  });
});
