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

describe('the audit of a stopped scan compares the release the pass is used under', () => {
  it('keeps the pass when nothing moved', async () => {
    const { candidate, credentials, stop } = await audited();
    expect(stoppedAuditPass(stop(), credentials)?.id).toBe(candidate.pass.id);
  });

  it('ignores a head that only republishes the release, and refuses another effective release', async () => {
    const { candidate, credentials, stop } = await audited();
    // The head's own id, generation, version or hash moving is not a change by itself.
    expect(
      stoppedAuditPass(
        stop({ activeReleaseId: 'republished', activeReleaseGeneration: 99 }),
        credentials,
      )?.id,
    ).toBe(candidate.pass.id);
    expect(() =>
      stoppedAuditPass(stop({ effectiveRelease: ['other', 2, '2.0', 'hash'] }), credentials),
    ).toThrow(StaleScanAuthority);
  });
});
