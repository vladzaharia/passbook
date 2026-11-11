import type { RetainedRow } from './repo-webhook-retention.ts';
import type { RetainedWebhookCandidate } from './webhook-retention-items.ts';

type Existing = Extract<RetainedWebhookCandidate, { kind: 'existing' }>;
type New = Extract<RetainedWebhookCandidate, { kind: 'new' }>;

export const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const nonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function existingValid(candidate: Existing, row: RetainedRow, ref: string): boolean {
  const s = candidate.snapshot;
  return (
    nonempty(s.passId) &&
    s.orgId === row.orgId &&
    s.connectionId === row.connectionId &&
    s.externalRef === ref &&
    s.generation === row.generation &&
    s.mode === 'live' &&
    s.status === 'active' &&
    s.expectedConnectionMode === row.connectionMode &&
    positive(s.expectedVersion) &&
    positive(s.expectedRowVersion) &&
    nonempty(s.identityId) &&
    positive(s.credentialGeneration) &&
    nonnegative(s.lifecycleGeneration) &&
    typeof s.transferPending === 'boolean' &&
    candidate.credentialKeysetCommitment === row.credentialKeysetCommitment &&
    s.credentialKeysetCommitment === candidate.credentialKeysetCommitment &&
    (s.ownerUserId === null || typeof s.ownerUserId === 'string') &&
    positive(s.linkGeneration) &&
    nonempty(candidate.templateId) &&
    nonempty(candidate.templateVersion) &&
    (candidate.releaseId === null || nonempty(candidate.releaseId))
  );
}

export function newValid(candidate: New, row: RetainedRow, ref: string): boolean {
  const release = candidate.expectedRelease;
  return (
    nonempty(candidate.reservedPassId) &&
    candidate.orgId === row.orgId &&
    candidate.connectionId === row.connectionId &&
    candidate.externalRef === ref &&
    candidate.generation === row.generation &&
    (candidate.templateId === null || nonempty(candidate.templateId)) &&
    candidate.credentialKeysetCommitment === row.credentialKeysetCommitment &&
    (release === null ||
      (release.kind === 'approved' &&
        nonempty(release.id) &&
        positive(release.generation) &&
        nonempty(release.version)) ||
      (release.kind === 'blocked' &&
        (release.code === 'TEMPLATE_RELEASE_REQUIRED' ||
          release.code === 'TEMPLATE_RELEASE_CONFLICT')))
  );
}
