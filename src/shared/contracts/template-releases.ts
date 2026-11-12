import { z } from 'zod';
import { IdSchema, ModeSchema, TimestampSchema } from './common.ts';

export const TemplateReleaseProviderSchema = z.enum(['apple', 'google', 'samsung']);
export type TemplateReleaseProvider = z.infer<typeof TemplateReleaseProviderSchema>;

/** Every release operation is bound to an organization, mode and provider. */
export const TemplateReleaseScopeSchema = z.strictObject({
  orgId: IdSchema,
  mode: ModeSchema,
  provider: TemplateReleaseProviderSchema,
});
export type TemplateReleaseScope = z.infer<typeof TemplateReleaseScopeSchema>;

export const TemplateApprovalSchema = z.object({
  id: IdSchema,
  candidateId: IdSchema,
  candidateHash: z.string(),
  reviewerId: IdSchema,
  reviewerName: z.string().nullable().optional(),
  createdAt: TimestampSchema,
});
export type TemplateApproval = z.infer<typeof TemplateApprovalSchema>;

export const TemplateCandidateSchema = z.object({
  id: IdSchema,
  templateId: IdSchema,
  orgId: IdSchema,
  mode: ModeSchema,
  provider: TemplateReleaseProviderSchema,
  version: z.string(),
  contentHash: z.string(),
  candidateHash: z.string(),
  adapterRevision: z.number(),
  adapterCapabilities: z.array(z.string()),
  audiencePolicyRevision: z.number(),
  authorId: IdSchema,
  versionAuthorId: IdSchema.nullable(),
  authorName: z.string().nullable().optional(),
  versionAuthorName: z.string().nullable().optional(),
  createdAt: TimestampSchema,
  /** Native projections pin the exact independently approved Apple source. */
  sourceReleaseId: IdSchema.optional(),
  sourceReleaseGeneration: z.number().int().positive().optional(),
  sourceReleaseHash: z.string().optional(),
  accountId: IdSchema.optional(),
  accountRevision: z.number().int().positive().optional(),
  providerIdentityHash: z.string().optional(),
  projection: z.unknown().optional(),
  approvals: z.array(TemplateApprovalSchema),
});
export type TemplateCandidate = z.infer<typeof TemplateCandidateSchema>;

export const TemplateReleaseSchema = z.object({
  id: IdSchema,
  templateId: IdSchema,
  orgId: IdSchema.nullable(),
  mode: ModeSchema,
  provider: TemplateReleaseProviderSchema,
  version: z.string(),
  generation: z.number().int().positive(),
  candidateHash: z.string(),
  source: z.enum(['approved', 'system', 'legacy']),
  action: z.enum(['release', 'rollback', 'system', 'legacy']),
  previousReleaseId: IdSchema.nullable(),
  createdBy: IdSchema.nullable(),
  createdByName: z.string().nullable().optional(),
  createdAt: TimestampSchema,
  candidateId: IdSchema.nullable(),
  approvalId: IdSchema.nullable(),
  sourceReleaseId: IdSchema.optional(),
  sourceReleaseGeneration: z.number().int().positive().optional(),
  sourceReleaseHash: z.string().optional(),
  accountId: IdSchema.optional(),
  accountRevision: z.number().int().positive().optional(),
  providerIdentityHash: z.string().optional(),
});
export type TemplateRelease = z.infer<typeof TemplateReleaseSchema>;

export const TemplateCandidateListSchema = z.object({ items: z.array(TemplateCandidateSchema) });
export type TemplateCandidateList = z.infer<typeof TemplateCandidateListSchema>;
export const TemplateReleaseListSchema = z.object({
  active: TemplateReleaseSchema.nullable(),
  items: z.array(TemplateReleaseSchema),
});
export type TemplateReleaseList = z.infer<typeof TemplateReleaseListSchema>;

export const CreateTemplateCandidateSchema = TemplateReleaseScopeSchema.extend({
  version: z.string(),
  sourceReleaseId: IdSchema.optional(),
  /** Provider-specific content is strictly parsed by the selected native adapter. */
  projection: z.unknown().optional(),
}).superRefine((candidate, ctx) => {
  if (candidate.provider === 'apple') {
    if (candidate.sourceReleaseId !== undefined || candidate.projection !== undefined)
      ctx.addIssue({
        code: 'custom',
        message: 'Apple candidates cannot contain projection fields.',
      });
  } else {
    if (candidate.sourceReleaseId === undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['sourceReleaseId'],
        message: 'Choose the approved Apple release.',
      });
    if (candidate.projection === undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['projection'],
        message: 'Provide the provider projection.',
      });
  }
});
export type CreateTemplateCandidate = z.infer<typeof CreateTemplateCandidateSchema>;

export const ApproveTemplateCandidateSchema = TemplateReleaseScopeSchema.extend({
  candidateHash: z.string(),
});
export type ApproveTemplateCandidate = z.infer<typeof ApproveTemplateCandidateSchema>;

export const PublishTemplateReleaseSchema = TemplateReleaseScopeSchema.extend({
  candidateId: IdSchema,
  approvalId: IdSchema,
  candidateHash: z.string(),
  expectedGeneration: z.number().int().nonnegative(),
});
export type PublishTemplateRelease = z.infer<typeof PublishTemplateReleaseSchema>;

export const RollbackTemplateReleaseSchema = TemplateReleaseScopeSchema.extend({
  releaseId: IdSchema,
  candidateHash: z.string(),
  expectedGeneration: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(500),
});
export type RollbackTemplateRelease = z.infer<typeof RollbackTemplateReleaseSchema>;

export const TemplateCandidateParamSchema = z.strictObject({
  id: IdSchema,
  candidateId: IdSchema,
});
export type TemplateCandidateParam = z.infer<typeof TemplateCandidateParamSchema>;

/** A release-backed choice for pass and scanner pickers; never exposes a draft manifest. */
export const EligibleTemplateSchema = z.object({
  templateId: IdSchema,
  name: z.string(),
  templateOrgId: IdSchema.nullable(),
  origin: z.enum(['uploaded', 'baked']),
  releaseId: IdSchema,
  releaseGeneration: z.number().int().positive(),
  version: z.string(),
  candidateHash: z.string(),
  supportsCheckIn: z.boolean(),
});
export type EligibleTemplate = z.infer<typeof EligibleTemplateSchema>;

export const EligibleTemplateListSchema = z.object({
  items: z.array(EligibleTemplateSchema),
  nextCursor: IdSchema.nullable(),
});
export type EligibleTemplateList = z.infer<typeof EligibleTemplateListSchema>;

export const EligibleTemplateQuerySchema = TemplateReleaseScopeSchema.extend({
  cursor: IdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type EligibleTemplateQuery = z.infer<typeof EligibleTemplateQuerySchema>;

/** One semantic difference between two versions, with display text for both sides. */
export const ReleaseChangeSchema = z.object({
  label: z.string(),
  kind: z.enum(['added', 'removed', 'changed']),
  from: z.string().nullable(),
  to: z.string().nullable(),
});
export type ReleaseChange = z.infer<typeof ReleaseChangeSchema>;

export const TemplateReleaseImpactQuerySchema = TemplateReleaseScopeSchema.extend({
  /** The version a publish or rollback would make current. */
  version: z.string().min(1).max(64),
});
export type TemplateReleaseImpactQuery = z.infer<typeof TemplateReleaseImpactQuerySchema>;

/** What a publish or rollback to `toVersion` changes, and for how many passes. */
export const TemplateReleaseImpactSchema = z.object({
  /** The release being replaced; for a rollback that restores an archived template, its last release. */
  fromVersion: z.string().nullable(),
  toVersion: z.string(),
  /** Passes of this org, in the release's mode, that are not yet on `toVersion`. Counted up to 10,000. */
  passes: z.object({ count: z.number().int(), capped: z.boolean() }),
  diff: z.object({
    fields: z.array(ReleaseChangeSchema),
    images: z.array(ReleaseChangeSchema),
    barcode: z.array(ReleaseChangeSchema),
    colors: z.array(ReleaseChangeSchema),
  }),
  /** Changes beyond the 50 listed per group. */
  more: z.object({
    fields: z.number().int(),
    images: z.number().int(),
    barcode: z.number().int(),
    colors: z.number().int(),
  }),
});
export type TemplateReleaseImpact = z.infer<typeof TemplateReleaseImpactSchema>;
