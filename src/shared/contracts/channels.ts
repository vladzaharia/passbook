import { z } from 'zod';
import { IdSchema, ModeSchema, OrgIdSchema, TimestampSchema } from './common.ts';
import { BULK_PASS_LIMIT } from './passes.ts';

export const CHANNELS = ['mobile', 'apple', 'google', 'samsung', 'paper', 'nfc'] as const;
export const ChannelSchema = z.enum(CHANNELS);
export type Channel = z.infer<typeof ChannelSchema>;

/** `off` lets a pass turn the channel on; `never` does not. */
export const TemplateChannelStateSchema = z.enum(['on', 'off', 'never']);
export type TemplateChannelState = z.infer<typeof TemplateChannelStateSchema>;

export const PassChannelStateSchema = z.enum(['on', 'off']);
export type PassChannelState = z.infer<typeof PassChannelStateSchema>;

/** Where the deciding level sits: the first failing level when off, the pass or template when on. */
export const ChannelSourceSchema = z.enum(['pass', 'template', 'org', 'platform']);
export type ChannelSource = z.infer<typeof ChannelSourceSchema>;

export const CHANNEL_REASONS = [
  'not_released',
  'not_enrolled',
  'no_design',
  'tags_off',
  'printing_off',
  'blocked',
  'never',
  'template_off',
  'pass_off',
] as const;
export const ChannelReasonSchema = z.enum(CHANNEL_REASONS);
export type ChannelReason = z.infer<typeof ChannelReasonSchema>;

export const ChannelStatusSchema = z.object({
  on: z.boolean(),
  source: ChannelSourceSchema,
  /** Present when off. */
  reason: ChannelReasonSchema.optional(),
  /** When the pass's copies in this channel were retired by a plain Turn off. */
  retiredAt: TimestampSchema.optional(),
});
export type ChannelStatus = z.infer<typeof ChannelStatusSchema>;

export const EffectiveChannelsSchema = z.record(ChannelSchema, ChannelStatusSchema) as z.ZodType<
  Record<Channel, ChannelStatus>
>;
export type EffectiveChannels = Record<Channel, ChannelStatus>;

/** A partial map: only the named channels change. */
export const TemplateChannelsSchema = z
  .partialRecord(ChannelSchema, TemplateChannelStateSchema)
  .refine((r) => Object.keys(r).length > 0, { message: 'Name at least one channel.' });
export const PassChannelOverridesSchema = z.partialRecord(ChannelSchema, PassChannelStateSchema);

export const ChannelsQuerySchema = z.object({ orgId: OrgIdSchema.optional() });

/** GET /api/v1/passes/{id}/channels */
export const PassChannelsResponseSchema = z.object({
  effective: EffectiveChannelsSchema,
  /** Per-pass overrides only; a channel absent here follows its template. */
  overrides: PassChannelOverridesSchema,
});
export type PassChannelsDto = z.infer<typeof PassChannelsResponseSchema>;

/** PUT /api/v1/passes/{id}/channels. `null` removes the override ("Use template"). */
export const PutPassChannelsSchema = z.object({
  channels: z
    .partialRecord(ChannelSchema, PassChannelStateSchema.nullable())
    .refine((r) => Object.keys(r).length > 0, { message: 'Name at least one channel.' }),
  /** Email the holder that a copy stopped working. Default on. */
  notify: z.boolean().default(true),
  /** Also issue new scan codes ("Turn off and replace codes"). Off by default: turning off never rotates. */
  replaceCodes: z.boolean().default(false),
  orgId: OrgIdSchema.optional(),
});

/** POST /api/v1/passes/bulk/channels */
export const BulkPassChannelsSchema = z.object({
  action: z.enum(['on', 'off', 'reset']),
  channels: z.array(ChannelSchema).min(1).max(CHANNELS.length),
  ids: z.array(IdSchema).min(1).max(BULK_PASS_LIMIT),
  /** Holder emails are off by default for bulk. */
  notify: z.boolean().default(false),
  /** Also issue new scan codes ("Turn off and replace codes"). Off by default: turning off never rotates. */
  replaceCodes: z.boolean().default(false),
  orgId: OrgIdSchema.optional(),
});
export const BulkPassChannelsResponseSchema = z.object({
  done: z.number().int(),
  skipped: z.array(z.object({ id: IdSchema, code: z.string() })),
});

/** What saving would change, for "Turns off Apple for 412 passes and issues new codes." */
export const ChannelImpactSchema = z.object({
  channel: ChannelSchema,
  /** Passes of the caller's mode that go from on to off. */
  passes: z.number().int().nonnegative(),
  /** Passes whose codes rotate: those with a copy in the channel, only when `replaceCodes` is set. */
  rotated: z.number().int().nonnegative(),
});

/** GET /api/v1/templates/{id}/channels */
export const TemplateChannelsResponseSchema = z.object({
  /** Stored policy, null when the template has none (defaults apply). */
  channels: z.partialRecord(ChannelSchema, TemplateChannelStateSchema).nullable(),
  /** The template's own view: platform, org and capability, before any pass override. */
  effective: EffectiveChannelsSchema,
});
export type TemplateChannelsDto = z.infer<typeof TemplateChannelsResponseSchema>;

/** PUT /api/v1/templates/{id}/channels. `dryRun` returns the impact without saving. */
export const PutTemplateChannelsSchema = z.object({
  channels: TemplateChannelsSchema,
  dryRun: z.boolean().default(false),
  /** Also issue new scan codes ("Turn off and replace codes"). Off by default: turning off never rotates. */
  replaceCodes: z.boolean().default(false),
  orgId: OrgIdSchema.optional(),
});
export const PutTemplateChannelsResponseSchema = TemplateChannelsResponseSchema.extend({
  impact: z.array(ChannelImpactSchema),
  /** The bulk-reissue run, when the save started one. */
  workflowInstanceId: z.string().nullable(),
});
