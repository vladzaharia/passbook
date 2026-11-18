import { z } from 'zod';
import {
  IdSchema,
  JsonSchema,
  ModeSchema,
  OrgIdSchema,
  PageQuerySchema,
  PlainLineSchema,
  pageOf,
  TimestampSchema,
} from './common.ts';
import { ScanTargetSchema } from './scan.ts';
import { TimeZoneSchema } from './scan-base.ts';

export const BROADCAST_MAX_TEMPLATES = 20;
export const BROADCAST_MESSAGE_MAX = 256;
export const BROADCAST_MAX_LEAD_MS = 366 * 24 * 3_600_000;

/** `message` sets the template's messaging input; `change` sets any inputs. */
export const BroadcastKindSchema = z.enum(['message', 'change']);
export type BroadcastKind = z.infer<typeof BroadcastKindSchema>;

export const BroadcastStateSchema = z.enum([
  'draft',
  'scheduled',
  'sending',
  'sent',
  'partial',
  'failed',
  'cancelled',
]);
export type BroadcastState = z.infer<typeof BroadcastStateSchema>;

const InputKey = z.string().min(1).max(64);
/** `YYYY-MM-DD`, a real calendar date. */
export const IsoDateSchema = z
  .string()
  .regex(/^(?:19|2\d)\d{2}-\d{2}-\d{2}$/, 'Use a date from 1900 to 2999 as YYYY-MM-DD.')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
  }, 'Use a real date.');
/** The scan-event match shape: the input equals any of the values. */
const ValuesClause = z.object({
  input: InputKey,
  values: z.array(z.string().min(1).max(120)).min(1).max(20),
});
const NumberClause = z
  .object({
    input: InputKey,
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  })
  .refine((c) => c.min !== undefined || c.max !== undefined, 'Set a lowest or highest value.')
  .refine(
    (c) => c.min === undefined || c.max === undefined || c.min <= c.max,
    'Lowest is above highest.',
  );
const DateClause = z
  .object({
    input: InputKey,
    from: IsoDateSchema.optional(),
    to: IsoDateSchema.optional(),
    timeZone: TimeZoneSchema,
  })
  .refine((c) => c.from || c.to, 'Pick a start or end date.')
  .refine((c) => !c.from || !c.to || c.from <= c.to, 'Start is after end.');
/** 1-3 clauses, ANDed. Ranges are inclusive at both ends. */
export const InputMatchSchema = z
  .array(z.union([ValuesClause, NumberClause, DateClause]))
  .min(1)
  .max(3);
export type InputMatch = z.infer<typeof InputMatchSchema>;

/** Active passes only: voided, removed and expired passes are never targeted. */
export const BroadcastTargetSchema = z.object({
  templateIds: z.array(IdSchema).min(1).max(BROADCAST_MAX_TEMPLATES),
  onDevice: z.boolean().optional(),
  holderState: z.enum(['unassigned', 'waiting', 'owned']).optional(),
  q: z.string().trim().max(200).optional(),
  scan: ScanTargetSchema.optional(),
  match: InputMatchSchema.optional(),
});
export type BroadcastTarget = z.infer<typeof BroadcastTargetSchema>;

/** Input values. A `message` broadcast carries `{ message: text }`; an empty text clears it. */
export const BroadcastPatchSchema = z
  .record(z.string().min(1).max(64), JsonSchema)
  .refine((p) => Object.keys(p).length >= 1 && Object.keys(p).length <= 40, 'Set 1 to 40 inputs.');

export const BroadcastCountsSchema = z.object({
  targeted: z.number().int().nonnegative(),
  /** Passes that changed, including those updated silently. */
  updated: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  /** Updated without a notification because the pass hit its daily limit. */
  overBudget: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type BroadcastCounts = z.infer<typeof BroadcastCountsSchema>;

export const BroadcastSchema = z.object({
  id: IdSchema,
  orgId: OrgIdSchema,
  mode: ModeSchema,
  kind: BroadcastKindSchema,
  name: z.string(),
  state: BroadcastStateSchema,
  target: BroadcastTargetSchema,
  patch: z.record(z.string(), JsonSchema),
  notify: z.boolean(),
  /** When a scheduled broadcast starts. */
  at: TimestampSchema.nullable(),
  /** Milliseconds after the start that the message is cleared; null keeps it. */
  clearAfter: z.number().int().positive().nullable(),
  /** Set on the follow-up that clears another broadcast's message. */
  parentId: IdSchema.nullable(),
  /** The automatic message that made this one. */
  ruleId: IdSchema.nullable(),
  /** The follow-up that clears this message, once the send has finished. */
  followUp: z.object({ id: IdSchema, at: TimestampSchema.nullable() }).nullable(),
  counts: BroadcastCountsSchema,
  errorCode: z.string().nullable(),
  createdAt: TimestampSchema,
  startedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
});
export type BroadcastDto = z.infer<typeof BroadcastSchema>;

export const ClearAfterSchema = z
  .number()
  .int()
  .min(60_000)
  .max(BROADCAST_MAX_LEAD_MS)
  .nullable()
  .optional();

export const CreateBroadcastSchema = z
  .object({
    orgId: OrgIdSchema,
    kind: BroadcastKindSchema,
    name: PlainLineSchema(80).optional(),
    target: BroadcastTargetSchema,
    patch: BroadcastPatchSchema,
    /** Message the holder sees on the lock screen. Ignored when the text is empty. */
    notify: z.boolean().default(true),
    /** `draft` saves, `now` starts at once, `schedule` waits for `at`. */
    send: z.enum(['draft', 'now', 'schedule']).default('now'),
    at: TimestampSchema.optional(),
    clearAfter: ClearAfterSchema,
  })
  .superRefine((body, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (body.send === 'schedule' && body.at === undefined) issue('at', 'Pick a time.');
    if (body.send !== 'schedule' && body.at !== undefined)
      issue('at', 'Only a schedule has a time.');
    if (body.kind === 'message') {
      const text = body.patch.message;
      if (Object.keys(body.patch).length !== 1 || typeof text !== 'string')
        issue('patch', 'A message sets only "message" to text.');
      else if (text.length > BROADCAST_MESSAGE_MAX)
        issue('patch', `Keep the message to ${BROADCAST_MESSAGE_MAX} characters or fewer.`);
      else if (text.trim() === '' && body.clearAfter)
        issue('clearAfter', 'An empty message has nothing to clear.');
    } else if (body.clearAfter) issue('clearAfter', 'Only a message can be cleared later.');
  });
export type CreateBroadcastBody = z.infer<typeof CreateBroadcastSchema>;

/** Saves new values over a draft or a scheduled message that has not started. Same rules as create. */
export const UpdateBroadcastSchema = CreateBroadcastSchema;

export const BroadcastOutcomeSchema = z.enum(['updated', 'unchanged', 'failed']);
export type BroadcastOutcome = z.infer<typeof BroadcastOutcomeSchema>;

export const BroadcastItemSchema = z.object({
  passId: IdSchema,
  title: z.string().nullable(),
  holderEmail: z.string().nullable(),
  outcome: BroadcastOutcomeSchema,
  /** Updated without a notification because the pass hit its daily limit. */
  silent: z.boolean(),
});
export type BroadcastItemDto = z.infer<typeof BroadcastItemSchema>;
export const BroadcastItemListQuerySchema = PageQuerySchema.extend({
  outcome: BroadcastOutcomeSchema.optional(),
});
export const BroadcastItemListSchema = pageOf(BroadcastItemSchema);

export const SendBroadcastSchema = z.object({ at: TimestampSchema.optional() });

export const BroadcastListQuerySchema = PageQuerySchema.extend({
  orgId: OrgIdSchema.optional(),
  state: BroadcastStateSchema.optional(),
  /** `manual` (default) leaves out the runs of automatic messages; `rule` is those alone. */
  origin: z.enum(['manual', 'rule']).default('manual'),
});
export const BroadcastListSchema = pageOf(BroadcastSchema);

export const BroadcastPreviewBodySchema = z.object({
  orgId: OrgIdSchema,
  target: BroadcastTargetSchema,
});
export const BroadcastPreviewSchema = z.object({
  /** Active passes the target matches now. */
  targeted: z.number().int().nonnegative(),
  /** Of those, on at least one device. */
  onDevice: z.number().int().nonnegative(),
  /** Of those, already at the daily limit: they update without a notification. */
  overBudget: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
});
export type BroadcastPreviewDto = z.infer<typeof BroadcastPreviewSchema>;
