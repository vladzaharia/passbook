import { z } from 'zod';
import {
  BROADCAST_MAX_TEMPLATES,
  BROADCAST_MESSAGE_MAX,
  ClearAfterSchema,
  InputMatchSchema,
} from './broadcasts.ts';
import {
  IdSchema,
  ModeSchema,
  OrgIdSchema,
  PageQuerySchema,
  PlainLineSchema,
  pageOf,
  TimestampSchema,
} from './common.ts';
import { TimeZoneSchema } from './scan-base.ts';

const InputKey = z.string().min(1).max(64);

/** What a rule counts from: a date input on the pass, or the pass's last completed scan. */
export const RuleAnchorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('input'), input: InputKey }),
  z.object({ kind: z.literal('lastScan') }),
]);
export type RuleAnchor = z.infer<typeof RuleAnchorSchema>;

export const RuleOffsetSchema = z.object({
  amount: z.number().int().min(0).max(366),
  unit: z.enum(['day', 'hour']),
  when: z.enum(['before', 'after']),
});
export type RuleOffset = z.infer<typeof RuleOffsetSchema>;

export const RULE_SEND_AT_EARLIEST = '08:00';
export const RULE_SEND_AT_LATEST = '20:30';
export const RULE_MAX_ACTIVE = 10;

const SEND_AT = /^([01]\d|2[0-3]):[0-5]\d$/;

const ruleFields = {
  name: PlainLineSchema(80),
  templateIds: z.array(IdSchema).min(1).max(BROADCAST_MAX_TEMPLATES),
  match: InputMatchSchema.optional(),
  anchor: RuleAnchorSchema,
  offset: RuleOffsetSchema,
  yearly: z.boolean().default(false),
  /** Local time of day for day units. */
  sendAt: z.string().regex(SEND_AT, 'Use a time as HH:MM.').default('10:00'),
  timeZone: TimeZoneSchema,
  message: z.string().trim().min(1).max(BROADCAST_MESSAGE_MAX),
  /** Default 7 days. */
  clearAfter: ClearAfterSchema.default(7 * 86_400_000),
  on: z.boolean().default(true),
};

type RuleShape = {
  anchor: RuleAnchor;
  offset: RuleOffset;
  yearly: boolean;
  sendAt: string;
};

/** Rules that need no template: the editor and the server share them. */
function refineRule(body: RuleShape, ctx: z.RefinementCtx): void {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message });
  if (
    body.offset.unit === 'day' &&
    (body.sendAt < RULE_SEND_AT_EARLIEST || body.sendAt > RULE_SEND_AT_LATEST)
  )
    issue('sendAt', 'Pick a time between 08:00 and 20:30.');
  if (body.yearly) {
    if (body.anchor.kind !== 'input' || body.offset.unit !== 'day')
      issue('yearly', 'Every year works with a date input.');
  }
  if (body.anchor.kind === 'lastScan') {
    if (body.offset.when !== 'after' || body.offset.amount < 1 || body.offset.unit !== 'day')
      issue('offset', 'Count days after the last scan.');
  }
}

export const MessageRuleBodySchema = z
  .object({ orgId: OrgIdSchema, ...ruleFields })
  .superRefine(refineRule);
export type MessageRuleBody = z.infer<typeof MessageRuleBodySchema>;

export const RuleStateSchema = z.enum(['on', 'paused']);
export const RulePausedCodeSchema = z.enum([
  'RULE_CREATOR_REVOKED',
  'RULE_INPUT_MISSING',
  'ORG_INACTIVE',
]);
export type RulePausedCode = z.infer<typeof RulePausedCodeSchema>;

export const MessageRuleSchema = z.object({
  id: IdSchema,
  orgId: OrgIdSchema,
  mode: ModeSchema,
  ...ruleFields,
  yearly: z.boolean(),
  sendAt: z.string(),
  clearAfter: z.number().int().positive().nullable(),
  state: RuleStateSchema,
  pausedCode: RulePausedCodeSchema.nullable(),
  nextCheckAt: TimestampSchema.nullable(),
  sent: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  version: z.number().int().positive(),
});
export type MessageRuleDto = z.infer<typeof MessageRuleSchema>;

/** Saving over a rule: the version the editor read. A stale version is a conflict. */
export const UpdateMessageRuleSchema = z
  .object({ orgId: OrgIdSchema, ...ruleFields, version: z.number().int().positive() })
  .superRefine(refineRule);
export type UpdateMessageRuleBody = z.infer<typeof UpdateMessageRuleSchema>;

export const MessageRuleListQuerySchema = PageQuerySchema.extend({
  orgId: OrgIdSchema.optional(),
  state: RuleStateSchema.optional(),
});
export const MessageRuleListSchema = pageOf(MessageRuleSchema);

/** The unsaved body; `ruleId` of a saved rule leaves out passes it already sent this occurrence. */
export const RulePreviewBodySchema = z
  .object({ orgId: OrgIdSchema, ...ruleFields, ruleId: IdSchema.optional() })
  .superRefine(refineRule);
export const RulePreviewSchema = z.object({
  /** The next 14 local days, with the passes due each day. */
  days: z.array(z.object({ date: z.string(), count: z.number().int().nonnegative() })),
  total: z.number().int().nonnegative(),
  /** Of today's passes: those at the rule's daily notification limit now, which may send later. */
  atLimit: z.number().int().nonnegative(),
});

/** Sends the rule's text now to one of its passes. */
export const RuleTestBodySchema = z.object({ passId: IdSchema });
