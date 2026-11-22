import { z } from 'zod';
import { IdSchema, ModeSchema, TimestampSchema } from './common.ts';
import { ReleaseDiffGroupSchema } from './template-release-flow.ts';

/** An org key leaves `orgId` out and reads its own org. */
export const TemplateRolloutQuerySchema = z.object({
  orgId: IdSchema.optional(),
  mode: ModeSchema,
});
export type TemplateRolloutQuery = z.infer<typeof TemplateRolloutQuerySchema> & { orgId: string };

export const RolloutFailedPassSchema = z.object({
  passId: IdSchema,
  title: z.string().nullable(),
  reason: z.string(),
});

/** Tell holders: a message to the holders whose passes are on the release now. Offered for 24 hours. */
export const RolloutTellSchema = z.object({
  /** A suggestion: right for a release or for a rollback. */
  text: z.string(),
  /** The offer ends 24 hours after the release. */
  until: TimestampSchema,
  /** The Idempotency-Key to send with: one send per release. */
  key: z.string(),
});

/** How far the approved release has reached the org's passes, computed on each read. */
export const TemplateRolloutSchema = z.object({
  /** Null while the scope has no approved release. */
  releaseVersion: z.string().nullable(),
  releaseId: IdSchema.nullable(),
  /** The version this release replaced, for "What changed". */
  fromVersion: z.string().nullable(),
  /** Active passes of the org on the template, in the mode. */
  total: z.number().int().nonnegative(),
  /** Of those, on the release or on an equivalent build. */
  onRelease: z.number().int().nonnegative(),
  /** Not yet on the release, including `failedCount`. */
  remaining: z.number().int().nonnegative(),
  /** Still on their way, by the version they are on. */
  updating: z.array(z.object({ version: z.string(), count: z.number().int().nonnegative() })),
  /** Left behind: the rebuild recorded why, or every rebuild since the release has finished. */
  failedCount: z.number().int().nonnegative(),
  /** The first 50, with the reason; empty unless the caller can read passes. */
  failed: z.array(RolloutFailedPassSchema).max(50),
  /** When the release was approved. */
  startedAt: TimestampSchema.nullable(),
  /** The latest rebuild of this release in this mode. */
  runId: z.string().nullable(),
  /** A rebuild is still moving passes. */
  running: z.boolean(),
  /** No rebuild started within the grace period: what remains will not move on its own. */
  stalled: z.boolean(),
  /** What changed from `fromVersion` to the release. */
  changes: z.array(ReleaseDiffGroupSchema),
  /** Null when nobody is on the release yet, holders were told, or the offer has ended. */
  tell: RolloutTellSchema.nullable(),
});
export type TemplateRollout = z.infer<typeof TemplateRolloutSchema>;
