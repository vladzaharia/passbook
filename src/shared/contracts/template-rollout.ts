import { z } from 'zod';
import { IdSchema, ModeSchema, TimestampSchema } from './common.ts';

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

/** What Tell holders would do now: `change` before passes move (the template's change messages), `message` after. */
export const RolloutTellSchema = z.object({
  path: z.enum(['change', 'message']),
  /** `message` only: the lock-screen text to send. */
  text: z.string().nullable(),
  /** The offer ends 24 hours after the release. */
  until: TimestampSchema,
});

/** How far the approved release has reached the org's live passes, computed on each read. */
export const TemplateRolloutSchema = z.object({
  /** Null while the scope has no approved release. */
  releaseVersion: z.string().nullable(),
  /** Active passes of the org on the template, in the mode. */
  total: z.number().int().nonnegative(),
  /** Of those, on the release or on an equivalent build. */
  onRelease: z.number().int().nonnegative(),
  /** Not yet on the release, including `failed`. */
  remaining: z.number().int().nonnegative(),
  /** Left behind after every rebuild since the release finished; the first 50. */
  failed: z.array(RolloutFailedPassSchema).max(50),
  /** How many passes `failed` stands for. */
  failedCount: z.number().int().nonnegative(),
  /** When the release was approved. */
  startedAt: TimestampSchema.nullable(),
  /** The latest rebuild since then. */
  runId: z.string().nullable(),
  /** A rebuild is still moving passes. */
  running: z.boolean(),
  /** Null when there is nothing to tell, the offer has ended, or there is no release. */
  tell: RolloutTellSchema.nullable(),
});
export type TemplateRollout = z.infer<typeof TemplateRolloutSchema>;
