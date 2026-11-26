import { z } from 'zod';
import { IdSchema, ModeSchema, pageOf, TimestampSchema } from './common.ts';

export const TemplateReleaseProviderSchema = z.enum(['apple', 'google', 'samsung']);
export type TemplateReleaseProvider = z.infer<typeof TemplateReleaseProviderSchema>;

/** Every release operation is bound to an organization, mode and provider. */
export const TemplateReleaseScopeSchema = z.strictObject({
  orgId: IdSchema,
  mode: ModeSchema,
  provider: TemplateReleaseProviderSchema,
});
export type TemplateReleaseScope = z.infer<typeof TemplateReleaseScopeSchema>;

/** The scope as a read's query: an org key leaves `orgId` out and reads its own org. */
export const TemplateReleaseQueryScopeSchema = TemplateReleaseScopeSchema.extend({
  orgId: IdSchema.optional(),
});

export const TemplateApprovalSchema = z.object({
  id: IdSchema,
  candidateId: IdSchema,
  candidateHash: z.string(),
  reviewerId: IdSchema,
  reviewerName: z.string().nullable().optional(),
  /** `sole` and `test` are the author's own approval; the release shows them as self-approved. */
  kind: z.enum(['peer', 'sole', 'test']).optional(),
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
  /** Google releases: the review of the classes the release wrote. Absent until one is written. */
  googleReview: z.enum(['waiting', 'rejected', 'approved']).optional(),
});
export type TemplateRelease = z.infer<typeof TemplateReleaseSchema>;

export const TemplateCandidateListSchema = pageOf(TemplateCandidateSchema);
export type TemplateCandidateList = z.infer<typeof TemplateCandidateListSchema>;
export const TemplateReleaseListSchema = z.object({
  active: TemplateReleaseSchema.nullable(),
  items: z.array(TemplateReleaseSchema),
  nextCursor: z.string().nullable(),
  /** Live scope: versions released in Test that Live can take with one review. */
  promotable: z.array(z.string()).optional(),
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
  /** The author confirms approving their own work (sole reviewer, or Test mode). */
  alone: z.boolean().optional(),
});
export type ApproveTemplateCandidate = z.infer<typeof ApproveTemplateCandidateSchema>;

/** A version released in Test becomes a Live candidate, the same version. */
export const PromoteTemplateSchema = z.strictObject({
  orgId: IdSchema,
  mode: z.literal('live'),
  provider: z.literal('apple'),
  version: z.string(),
});
export type PromoteTemplate = z.infer<typeof PromoteTemplateSchema>;

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

/** A pass type's entry rule as its template sets it: what a session shows beside each admitted type. */
export const EntryRuleSchema = z.object({
  /** How often a pass checks in; `unlimited` is every visit. */
  mode: z.enum(['single', 'daily', 'unlimited']),
  /** Ends at local midnight after this many days. */
  days: z.number().int().nullable(),
  durationMinutes: z.number().int().nullable(),
  durationFrom: z.enum(['first_scan', 'issued']).nullable(),
  /** The kinds of its access plans; empty without an access card. */
  plans: z.array(z.enum(['always', 'timed', 'guest'])).max(24),
  /** `template`: the type's own `scan.checkIn`. `action`: the check-in action's setting. */
  source: z.enum(['template', 'action']),
});
export type EntryRule = z.infer<typeof EntryRuleSchema>;

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
  /** Null without a check-in action. */
  rule: EntryRuleSchema.nullable().default(null),
});
export type EligibleTemplate = z.infer<typeof EligibleTemplateSchema>;

export const EligibleTemplateListSchema = z.object({
  items: z.array(EligibleTemplateSchema),
  nextCursor: IdSchema.nullable(),
});
export type EligibleTemplateList = z.infer<typeof EligibleTemplateListSchema>;

export const EligibleTemplateQuerySchema = TemplateReleaseQueryScopeSchema.extend({
  /** `issue` lists templates a pass can be made from; `scan` also lists blueprints the org has live passes on. */
  purpose: z.enum(['issue', 'scan']).default('issue'),
  cursor: IdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
/** The query once the route has resolved `orgId`. */
export type EligibleTemplateQuery = z.infer<typeof EligibleTemplateQuerySchema> & { orgId: string };

/** One semantic difference between two versions, with display text for both sides. */
export const ReleaseChangeSchema = z.object({
  label: z.string(),
  kind: z.enum(['added', 'removed', 'changed']),
  from: z.string().nullable(),
  to: z.string().nullable(),
});
export type ReleaseChange = z.infer<typeof ReleaseChangeSchema>;

export const TemplateReleaseImpactQuerySchema = TemplateReleaseQueryScopeSchema.extend({
  /** The version a publish or rollback would make current. */
  version: z.string().min(1).max(64),
});
export type TemplateReleaseImpactQuery = z.infer<typeof TemplateReleaseImpactQuerySchema> & {
  orgId: string;
};

/** What a publish or rollback to `toVersion` changes, and for how many passes. */
export const TemplateReleaseImpactSchema = z.object({
  /** The release being replaced; for a rollback that restores an archived template, its last release. */
  fromVersion: z.string().nullable(),
  toVersion: z.string(),
  /** Active passes of this org, in the release's mode, that the rollout would move: on another version whose build differs from `toVersion`'s. Counted up to 10,000. */
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

export {
  type ReleaseDiffGroup,
  ReleaseDiffGroupSchema,
  type ReleaseDiffValue,
  ReleaseDiffValueSchema,
  type ReleaseModePlan,
  ReleaseModePlanSchema,
  type ReleaseNext,
  type ReleasePlan,
  ReleasePlanSchema,
  ReleaseResponseSchema,
  type ReleaseResult,
  ReleaseResultSchema,
  type ReleaseTemplate,
  ReleaseTemplateQuerySchema,
  ReleaseTemplateSchema,
  type ReviewResult,
  ReviewResultSchema,
  type ReviewTemplate,
  ReviewTemplateSchema,
  type TemplateReleaseState,
  TemplateReleaseStateSchema,
  type TemplateReview,
  type TemplateReviewList,
  TemplateReviewListSchema,
  TemplateReviewQuerySchema,
  TemplateReviewSchema,
} from './template-release-flow.ts';
