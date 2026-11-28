import type { SqlValue } from '../../platform/db.ts';
import { APPLE_ADAPTER_CAPABILITIES } from './release-content.ts';
import type { ActivateReleaseArgs } from './repo-release-write.ts';
import type { CandidateRow } from './repo-releases.ts';

const capabilities = JSON.stringify(APPLE_ADAPTER_CAPABILITIES);

// The grant supplies org_id; the mode is the caller's (an org grant does not own it).
export const CANDIDATE_COLUMNS = [
  'id',
  'template_id',
  'mode',
  'provider',
  'version',
  'candidate_hash',
  'content_hash',
  'adapter_revision',
  'adapter_capabilities',
  'audience_policy_revision',
  'author_id',
  'version_author_id',
  'created_at',
];
export const RELEASE_COLUMNS = [
  'id',
  'template_id',
  'mode',
  'provider',
  'generation',
  'version',
  'candidate_hash',
  'content_hash',
  'adapter_revision',
  'adapter_capabilities',
  'audience_policy_revision',
  'source',
  'action',
  'candidate_id',
  'approval_id',
  'previous_release_id',
  'rollback_of_release_id',
  'created_by',
  'created_at',
];

export function candidateValues(c: CandidateRow): SqlValue[] {
  return [
    c.id,
    c.templateId,
    c.mode,
    c.provider,
    c.version,
    c.candidateHash,
    c.contentHash,
    c.adapterRevision,
    JSON.stringify(c.adapterCapabilities),
    c.audiencePolicyRevision,
    c.authorId,
    c.versionAuthorId,
    c.createdAt,
  ];
}

export function releaseValues(input: ActivateReleaseArgs): SqlValue[] {
  const c = input.candidate;
  return [
    input.id,
    c.templateId,
    c.mode,
    c.provider,
    input.expectedGeneration + 1,
    c.version,
    c.candidateHash,
    c.contentHash,
    c.adapterRevision,
    capabilities,
    c.audiencePolicyRevision,
    'approved',
    input.action,
    c.id,
    input.approvalId,
    input.expectedReleaseId,
    input.targetReleaseId,
    input.createdBy,
    input.createdAt,
  ];
}
