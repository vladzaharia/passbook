import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.ts';
import { REMOVE_MESSAGE_MAX } from './events.ts';
import { PASS_SELECTION_MAX, PassFilterSchema } from './pass-selection.ts';

// A bulk action over every pass a filter matches, run in the background: `POST /passes/bulk-runs`.

export const BulkRunActionSchema = z.enum(['void', 'send_email', 'remove']);

export const StartBulkRunSchema = z.strictObject({
  action: BulkRunActionSchema,
  /** For `remove`: shown to holders on the lock screen. */
  message: z.string().trim().max(REMOVE_MESSAGE_MAX).optional(),
  /** Org-bound keys may omit it. */
  orgId: IdSchema.optional(),
  selection: z.strictObject({
    filter: PassFilterSchema,
    /** The count the admin saw; any difference answers 409 `SELECTION_CHANGED`. */
    expectCount: z.number().int().min(1).max(PASS_SELECTION_MAX),
  }),
});

export const BulkRunStateSchema = z.enum(['queued', 'running', 'done', 'stopped', 'failed']);

export const BulkRunSchema = z.object({
  id: z.string(),
  orgId: IdSchema,
  action: BulkRunActionSchema,
  state: BulkRunStateSchema,
  /** Passes the run covers, fixed when it started. */
  total: z.number().int(),
  done: z.number().int(),
  /** Passes left as they were, with the count of each reason code. */
  skipped: z.number().int(),
  skippedBy: z.record(z.string(), z.number().int()),
  stopRequested: z.boolean(),
  createdAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
  /** Why a failed or stopped run ended. */
  code: z.string().nullable(),
});
export type BulkRunDto = z.infer<typeof BulkRunSchema>;

/** The organization's running run, or the last one that ended within the hour; absent when there is none. */
export const CurrentBulkRunSchema = z.object({ run: BulkRunSchema.optional() });
