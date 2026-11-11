import type { Pass } from '../passes/repo-map.ts';
import { StaleScanAuthority } from './act-override.ts';
import type { CredentialTombstoneSnapshot } from './credential-input.ts';
import type { Stop } from './resolve.ts';

/** Retain an inactive pass for audit only when its captured candidate still matches. */
export function stoppedAuditPass(
  evaluated: Stop,
  credentials: CredentialTombstoneSnapshot,
): Pass | null {
  let auditPass = null;
  if (evaluated.auditPassId || evaluated.auditPassSnapshot) {
    const snapshot = evaluated.auditPassSnapshot;
    if (!evaluated.auditPassId || !snapshot) throw new StaleScanAuthority();
    const candidate = evaluated.auditCandidate;
    const fields = [
      'orgId',
      'mode',
      'identityId',
      'serial',
      'templateId',
      'templateVersion',
      'releaseId',
      'version',
      'revision',
      'linkGeneration',
      'credentialGeneration',
      'lifecycleGeneration',
      'imageGeneration',
      'status',
      'removedAt',
      'deletedAt',
      'testDataQuarantined',
      'connectionId',
    ] as const;
    if (
      !candidate ||
      candidate.credentialKeysetCommitment !== credentials.credentialKeysetCommitment ||
      candidate.transferPending !== false ||
      snapshot.transferPending !== false ||
      candidate.connectionGeneration !== snapshot.connectionGeneration ||
      candidate.passJsonSnapshot !== snapshot.passJsonSnapshot ||
      candidate.identityPassTypeIdentifier !== snapshot.identityPassTypeIdentifier ||
      candidate.identityTeamIdentifier !== snapshot.identityTeamIdentifier ||
      candidate.identityRevision !== snapshot.identityRevision ||
      candidate.activeTemplateVersion !== snapshot.activeTemplateVersion ||
      candidate.activeReleaseId !== snapshot.activeReleaseId ||
      candidate.activeReleaseGeneration !== snapshot.activeReleaseGeneration ||
      candidate.activeReleaseVersion !== snapshot.activeReleaseVersion ||
      candidate.activeReleaseCandidateHash !== snapshot.activeReleaseCandidateHash ||
      candidate.orgRevision !== snapshot.orgRevision ||
      candidate.templateRevision !== snapshot.templateRevision ||
      fields.some((field) => candidate.pass[field] !== snapshot[field])
    )
      throw new StaleScanAuthority();
    auditPass = candidate.pass;
  }
  return auditPass;
}
