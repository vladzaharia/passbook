import { z } from 'zod';
import { IdSchema, ModeSchema, pageOf, TimestampSchema } from './common.ts';

/**
 * What a template's page, the designer and Overview show next, computed by the server
 * (`src/shared/template-release-state.ts`). Apple heads only; each mode is its own line.
 */
export const TemplateReleaseStateSchema = z.object({
  /** The Live head. `by` is the publisher's name. */
  live: z
    .object({ version: z.string(), at: TimestampSchema, by: z.string().nullable() })
    .nullable(),
  /** The Test head: `following` is Live's version or older, `ahead` is newer (a Try). */
  test: z
    .object({
      version: z.string(),
      at: TimestampSchema,
      state: z.enum(['following', 'ahead']),
    })
    .nullable(),
  /** The newest valid saved version, when it is newer than Live. */
  draft: z.object({ version: z.string(), at: TimestampSchema }).nullable(),
  /** Review of the draft for Live. `by` is the requester's name (open) or the approver's (approved). */
  review: z.discriminatedUnion('state', [
    z.object({ state: z.literal('none') }),
    z.object({
      state: z.enum(['open', 'approved']),
      version: z.string(),
      by: z.string().nullable(),
      at: TimestampSchema,
    }),
  ]),
  /** The caller may author, publish and approve alone: the exact `sole` approval rule. */
  alone: z.boolean(),
  next: z.enum(['design', 'try', 'release', 'request_review', 'review', 'wait']).nullable(),
});
export type TemplateReleaseState = z.infer<typeof TemplateReleaseStateSchema>;
export type ReleaseNext = TemplateReleaseState['next'];

const ReleaseModesSchema = z
  .array(ModeSchema)
  .min(1)
  .max(2)
  .refine((modes) => new Set(modes).size === modes.length, { message: 'List each mode once.' });

/** `POST /templates/{id}/release`. Test runs first, then Live. */
export const ReleaseTemplateSchema = z.strictObject({
  /** Omitted for an org key or a template the org owns. */
  orgId: IdSchema.optional(),
  version: z.string().min(1).max(64),
  /** Defaults to both for a session. Try is `['test']`. A Test key may name only `test`. */
  modes: ReleaseModesSchema.optional(),
  /** The head generation each mode must still be at; `0` before its first release. */
  expected: z
    .strictObject({
      live: z.number().int().nonnegative().optional(),
      test: z.number().int().nonnegative().optional(),
    })
    .optional(),
  /** Request review instead of releasing: candidates are created or reused and reviewers told. */
  request: z.boolean().optional(),
});
export type ReleaseTemplate = z.infer<typeof ReleaseTemplateSchema>;

export const ReleaseTemplateQuerySchema = z.object({
  dryRun: z
    .enum(['true', 'false', '1', '0'])
    .transform((v) => v === 'true' || v === '1')
    .optional(),
});

const CountSchema = z.object({ count: z.number().int(), capped: z.boolean() });

/** A typed value in the release diff. `image` names an asset of `version`. */
export const ReleaseDiffValueSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('color'), color: z.string() }),
  z.object({ type: z.literal('date'), at: TimestampSchema }),
  z.object({ type: z.literal('image'), version: z.string(), asset: z.string() }),
]);
export type ReleaseDiffValue = z.infer<typeof ReleaseDiffValueSchema>;

export const ReleaseDiffGroupSchema = z.object({
  group: z.enum(['colors', 'front', 'back', 'images', 'barcode']),
  rows: z.array(
    z.object({
      label: z.string(),
      kind: z.enum(['added', 'removed', 'changed']),
      from: ReleaseDiffValueSchema.nullable(),
      to: ReleaseDiffValueSchema.nullable(),
    }),
  ),
  /** Rows beyond those listed. */
  more: z.number().int(),
});
export type ReleaseDiffGroup = z.infer<typeof ReleaseDiffGroupSchema>;

/** One mode's steps. `kept`: a newer Test head stays. `current`: the head is already `version`. */
export const ReleaseModePlanSchema = z.object({
  outcome: z.enum(['release', 'kept', 'current', 'review_required', 'review_requested']),
  from: z.string().nullable(),
  expectedGeneration: z.number().int().nonnegative(),
  candidate: z.object({ action: z.enum(['reuse', 'create']), id: IdSchema.nullable() }),
  /** `needed`: no approval the caller can write; the plan stops here. */
  approval: z.object({
    action: z.enum(['reuse', 'write', 'needed']),
    kind: z.enum(['peer', 'sole', 'test']).nullable(),
  }),
  impact: z.object({ passes: CountSchema, devices: CountSchema }),
});
export type ReleaseModePlan = z.infer<typeof ReleaseModePlanSchema>;

/** The dry run's response, and the 409 `TEMPLATE_REVIEW_REQUIRED` body's `plan`. */
export const ReleasePlanSchema = z.object({
  version: z.string(),
  modes: z.object({
    test: ReleaseModePlanSchema.optional(),
    live: ReleaseModePlanSchema.optional(),
  }),
  diff: z.array(ReleaseDiffGroupSchema),
  /** Null on a first release. */
  fromVersion: z.string().nullable(),
  state: TemplateReleaseStateSchema,
});
export type ReleasePlan = z.infer<typeof ReleasePlanSchema>;

const ReleaseModeResultSchema = z.object({
  outcome: z.enum(['released', 'kept', 'current', 'review_requested']),
  releaseId: IdSchema.nullable(),
  generation: z.number().int().nonnegative(),
  approvalKind: z.enum(['peer', 'sole', 'test']).nullable(),
});

export const ReleaseResultSchema = z.object({
  version: z.string(),
  modes: z.object({
    test: ReleaseModeResultSchema.optional(),
    live: ReleaseModeResultSchema.optional(),
  }),
  state: TemplateReleaseStateSchema,
});
export type ReleaseResult = z.infer<typeof ReleaseResultSchema>;

/** The release route answers a result, or a plan when `dryRun` is set. */
export const ReleaseResponseSchema = z.union([ReleaseResultSchema, ReleasePlanSchema]);

/** `POST /templates/{id}/review`: approvals on both modes' candidates for `version`; peer ones, or the author's own with `alone`. */
export const ReviewTemplateSchema = z.strictObject({
  orgId: IdSchema.optional(),
  version: z.string().min(1).max(64),
  /** Also release, when the reviewer can publish. */
  release: z.boolean().optional(),
  /** The author confirms approving their own work: allowed when they are the org's only reviewer. */
  alone: z.boolean().optional(),
  note: z.string().trim().min(1).max(500).optional(),
});
export type ReviewTemplate = z.infer<typeof ReviewTemplateSchema>;

/** The modes the reviewer approved, and the release when `release` was set. */
export const ReviewResultSchema = z.object({
  version: z.string(),
  approved: z.array(ModeSchema),
  release: ReleaseResultSchema.nullable(),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export const TemplateReviewQuerySchema = z.object({
  orgId: IdSchema.optional(),
  state: z.enum(['open']).default('open'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const TemplateReviewSchema = z.object({
  templateId: IdSchema,
  templateName: z.string(),
  orgId: IdSchema,
  version: z.string(),
  requestedBy: z.string().nullable(),
  requestedAt: TimestampSchema,
});
export type TemplateReview = z.infer<typeof TemplateReviewSchema>;

export const TemplateReviewListSchema = pageOf(TemplateReviewSchema);
export type TemplateReviewList = z.infer<typeof TemplateReviewListSchema>;
