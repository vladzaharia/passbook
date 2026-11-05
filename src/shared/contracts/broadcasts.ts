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

export const BROADCAST_MAX_TEMPLATES = 20;
export const BROADCAST_MESSAGE_MAX = 256;
const MAX_LEAD_MS = 366 * 24 * 3_600_000;

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

/** Active passes only: voided, removed and expired passes are never targeted. */
export const BroadcastTargetSchema = z.object({
  templateIds: z.array(IdSchema).min(1).max(BROADCAST_MAX_TEMPLATES),
  onDevice: z.boolean().optional(),
  holderState: z.enum(['unassigned', 'waiting', 'owned']).optional(),
  q: z.string().trim().max(200).optional(),
  scan: ScanTargetSchema.optional(),
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
  /** The follow-up that clears this message, once the send has finished. */
  followUp: z.object({ id: IdSchema, at: TimestampSchema.nullable() }).nullable(),
  counts: BroadcastCountsSchema,
  errorCode: z.string().nullable(),
  createdAt: TimestampSchema,
  startedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
});
export type BroadcastDto = z.infer<typeof BroadcastSchema>;

const ClearAfterSchema = z.number().int().min(60_000).max(MAX_LEAD_MS).nullable().optional();

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
        issue('patch', `Keep the message under ${BROADCAST_MESSAGE_MAX} characters.`);
      else if (text.trim() === '' && body.clearAfter)
        issue('clearAfter', 'An empty message has nothing to clear.');
    } else if (body.clearAfter) issue('clearAfter', 'Only a message can be cleared later.');
  });
export type CreateBroadcastBody = z.infer<typeof CreateBroadcastSchema>;

export const SendBroadcastSchema = z.object({ at: TimestampSchema.optional() });

export const BroadcastListQuerySchema = PageQuerySchema.extend({
  orgId: OrgIdSchema.optional(),
  state: BroadcastStateSchema.optional(),
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
