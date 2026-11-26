import { z } from 'zod';
import { safeNextPath } from '../next.ts';
import { IdSchema, ModeSchema, TimestampSchema } from './common.ts';

const ID_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;
const ID_VALUE = /^[A-Za-z0-9_.:-]+$/;

// Long-running actions: `GET /operations/{id}`, `GET /operations`, `POST /operations/{id}/cancel|retry`.
// An operation is the user-facing projection of progress. It never carries a secret or personal data.

export const OPERATION_MAX_STEPS = 16;

export const OperationStatusSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'cancelled',
]);
export type OperationStatus = z.infer<typeof OperationStatusSchema>;

export const OPERATION_ACTIVE: readonly OperationStatus[] = ['queued', 'running', 'waiting'];

export const OperationStepStateSchema = z.enum([
  'pending',
  'running',
  'waiting',
  'done',
  'failed',
  'skipped',
]);
export type OperationStepState = z.infer<typeof OperationStepStateSchema>;

export const OperationStepSchema = z.object({
  key: z.string(),
  label: z.string(),
  state: OperationStepStateSchema,
  /** Counts, for "4 of 12". */
  done: z.number().int().nullable(),
  total: z.number().int().nullable(),
  /** From the kind's copy only, never free text. */
  detail: z.string().nullable(),
  /** A waiting step: when it resumes (`blocked`) or by when it ends (`due`). */
  until: TimestampSchema.nullable(),
  /**
   * Why the step waits. `blocked`: the operation cannot go on until `until`, then it tries again.
   * `due`: a tail step that finishes by `until` after the operation is done. Null unless the step waits.
   */
  waitingReason: z.enum(['blocked', 'due']).nullable(),
  group: z.string().nullable(),
  startedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
});
export type OperationStep = z.infer<typeof OperationStepSchema>;

export const OperationActorSchema = z.object({
  type: z.enum(['user', 'api_key', 'system']),
  id: z.string().nullable(),
});

export const OperationErrorSchema = z.object({
  /** A stable code from the error catalog. */
  code: z.string(),
  /** A catalog sentence, never exception text. */
  message: z.string(),
  step: z.string().nullable(),
  retryable: z.boolean(),
});

export const OperationResultSchema = z.object({
  /** An app path (`safeNextPath`: no scheme, host, backslash or control character). A download is a separate authorized call. */
  href: z
    .string()
    .max(300)
    .nullable()
    .refine((h) => h === null || safeNextPath(h) !== null, 'An app path only.'),
  /** Ids of what the operation made: plain id characters only, so no free text or secret fits. */
  ids: z
    .record(z.string().regex(ID_KEY).max(40), z.string().regex(ID_VALUE).max(80))
    .refine((r) => Object.keys(r).length <= 16, 'At most 16 ids.'),
});
export type OperationResult = z.infer<typeof OperationResultSchema>;

export const OperationSchema = z.object({
  id: IdSchema,
  /** A dotted name such as `sandbox.delete`. The list is in the docs, not an enum, so a new kind is additive. */
  kind: z.string(),
  status: OperationStatusSchema,
  title: z.string(),
  /** The current line: "Removing Test passes · 4 of 12". */
  text: z.string(),
  orgId: IdSchema.nullable(),
  mode: ModeSchema.nullable(),
  target: z.object({ type: z.string(), id: z.string() }).nullable(),
  /** Key of the running, waiting or failed step. */
  step: z.string().nullable(),
  steps: z.array(OperationStepSchema),
  /** 1, then +1 per retry. */
  attempt: z.number().int(),
  cancelable: z.boolean(),
  cancelRequested: z.boolean(),
  startedBy: OperationActorSchema,
  createdAt: TimestampSchema,
  startedAt: TimestampSchema.nullable(),
  updatedAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
  error: OperationErrorSchema.nullable(),
  result: OperationResultSchema.nullable(),
  /** Moves on every write; the ETag is `"<id>:<revision>"`. */
  revision: z.number().int(),
  /** The server's hint: 1000 while running, 60000 while waiting, 0 once ended. */
  pollAfterMs: z.number().int(),
});
export type OperationDto = z.infer<typeof OperationSchema>;

/** The 202 body of an endpoint that starts an operation; `Location` names it. */
export const StartedOperationSchema = z.object({ operation: OperationSchema });

export const OperationParamsSchema = z.object({ id: IdSchema });

const flag = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

export const OperationListQuerySchema = z.object({
  active: flag,
  /** Only operations the caller started. */
  mine: flag,
  kind: z.string().max(80).optional(),
  /** `type:id`. */
  target: z
    .string()
    .max(160)
    .regex(/^[^:]+:.+$/)
    .optional(),
  /** An organization's operations; org keys may omit it. */
  orgId: IdSchema.optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const OperationListSchema = z.object({
  items: z.array(OperationSchema),
  nextCursor: z.string().nullable(),
});
