import { z } from 'zod';
import { IdSchema, OrgIdSchema, TimestampSchema } from './common.ts';

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
  'not_included',
  'blocked',
  'never',
  'template_off',
  'pass_off',
] as const;
export const ChannelReasonSchema = z.enum(CHANNEL_REASONS);
export type ChannelReason = z.infer<typeof ChannelReasonSchema>;

/** Why a provider offer is withheld while its channel is on, after a channel-off retirement. */
export const OFFER_HOLDS = ['provider_retiring', 'provider_epoch_limit'] as const;
export const OfferHoldSchema = z.enum(OFFER_HOLDS);
export type OfferHold = z.infer<typeof OfferHoldSchema>;

export const ChannelStatusSchema = z.object({
  on: z.boolean(),
  source: ChannelSourceSchema,
  /** Present when off. */
  reason: ChannelReasonSchema.optional(),
  /** When the pass's copies in this channel were retired by a plain Turn off. */
  retiredAt: TimestampSchema.optional(),
  /** Which level turned it off when the copies were retired. */
  retiredCause: z.enum(['pass', 'template']).optional(),
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

/** An event or scanning session that admits a template: codes cannot change while it is open. */
export const ChannelWindowSchema = z.object({
  kind: z.enum(['event', 'session']),
  id: IdSchema,
  name: z.string(),
  /** Event: its start. Session with hours: the next open. Null for a session with no hours. */
  opensAt: TimestampSchema.nullable(),
  /** Null when no end is known. */
  closesAt: TimestampSchema.nullable(),
  /** Open now: a save that replaces codes is refused. */
  open: z.boolean(),
  /** False for a session with no hours (24/7): it warns, never blocks. */
  scheduled: z.boolean(),
});
export type ChannelWindow = z.infer<typeof ChannelWindowSchema>;

/** The open event or session that holds new codes, and when it ends (null when unknown). */
export const ChannelBlockSchema = z.object({
  name: z.string(),
  closesAt: TimestampSchema.nullable(),
});

/** Why "Turn off and replace codes" is not offered: the barcode is not the scan code, or no digital channel stays on. */
export const ChannelReplaceBlockSchema = z.enum(['barcode_not_scan_code', 'all_digital_off']);
export type ChannelReplaceBlock = z.infer<typeof ChannelReplaceBlockSchema>;

/** GET /api/v1/passes/{id}/channels */
export const PassChannelsResponseSchema = z.object({
  effective: EffectiveChannelsSchema,
  /** Per-pass overrides only; a channel absent here follows its template. */
  overrides: PassChannelOverridesSchema,
  /** "Turn off and replace codes": whether this pass's barcode allows it, and the windows within 48 hours. */
  replace: z.object({
    supported: z.boolean(),
    /** Opening within 48 hours, or a session with no hours: warnings. An open one is in `blocked`. */
    windows: z.array(ChannelWindowSchema),
    /** Turning off a digital channel would owe this pass a new code. */
    owed: z.boolean(),
    /** Set only when a code is owed and an event or session is open: a replace is refused. */
    blocked: ChannelBlockSchema.nullable(),
    /** Channels whose turn-off would leave no digital channel on: no new code is possible. */
    lastDigital: z.array(ChannelSchema),
  }),
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

/** Same cap as BULK_PASS_LIMIT (passes.ts imports settings, which imports this file). */
const BULK_CHANNEL_PASS_LIMIT = 100;

/** POST /api/v1/passes/bulk/channels */
export const BulkPassChannelsSchema = z.object({
  action: z.enum(['on', 'off', 'reset']),
  channels: z.array(ChannelSchema).min(1).max(CHANNELS.length),
  ids: z.array(IdSchema).min(1).max(BULK_CHANNEL_PASS_LIMIT),
  /** Holder emails are off by default for bulk. */
  notify: z.boolean().default(false),
  /** Also issue new scan codes ("Turn off and replace codes"). Off by default: turning off never rotates. */
  replaceCodes: z.boolean().default(false),
  /** Answer with what applying would do and change nothing. */
  dryRun: z.boolean().default(false),
  orgId: OrgIdSchema.optional(),
});
/** What a bulk change would do: passes turned off and new codes owed per channel, and what holds them. */
export const BulkChannelsPreviewSchema = z.object({
  impact: z.array(
    z.object({
      channel: ChannelSchema,
      passes: z.number().int().nonnegative(),
      rotated: z.number().int().nonnegative(),
    }),
  ),
  /** Passes whose barcode is not the scan code: they turn off without a new code. */
  unsupported: z.number().int().nonnegative(),
  /** Passes where no digital channel would stay on: no new code. */
  allOff: z.number().int().nonnegative(),
  /** An open event or session for the passes' templates: new codes wait for it. */
  blocked: ChannelBlockSchema.nullable(),
  /** Opening within 48 hours, or sessions with no hours: warnings. */
  windows: z.array(ChannelWindowSchema),
});
export const BulkPassChannelsResponseSchema = z.object({
  done: z.number().int(),
  skipped: z.array(z.object({ id: IdSchema, code: z.string() })),
  /** Only on a dry run. */
  preview: BulkChannelsPreviewSchema.optional(),
});

/** What saving would change, for "Turns off Apple for 412 passes and issues new codes." */
export const ChannelImpactSchema = z.object({
  channel: ChannelSchema,
  /** Passes of the caller's mode that go from on to off (approximate: uses the released version's capability, not each pass's pinned one). */
  passes: z.number().int().nonnegative(),
  /** Passes whose codes rotate: those with a copy in the channel, only when `replaceCodes` is set. */
  rotated: z.number().int().nonnegative(),
  /** Pass overrides a `never` deletes. */
  clearedOverrides: z.number().int().nonnegative(),
});

/** GET /api/v1/templates/{id}/channels */
export const TemplateChannelsResponseSchema = z.object({
  /** Stored policy, null when the template has none (defaults apply). */
  channels: z.partialRecord(ChannelSchema, TemplateChannelStateSchema).nullable(),
  /** Counts saves; 0 when none. Send it back on PUT: a stale one is refused (409). */
  revision: z.number().int().nonnegative(),
  /** The template's own view: platform, org and capability, before any pass override. */
  effective: EffectiveChannelsSchema,
  /** What each channel is when the policy is silent: the manifest default, else the global one. */
  defaults: z.record(ChannelSchema, z.enum(['on', 'off'])),
});
export type TemplateChannelsDto = z.infer<typeof TemplateChannelsResponseSchema>;

/** PUT /api/v1/templates/{id}/channels. `dryRun` returns the impact without saving. */
export const PutTemplateChannelsSchema = z.object({
  channels: TemplateChannelsSchema,
  /** The `revision` the editor read. */
  revision: z.number().int().nonnegative(),
  dryRun: z.boolean().default(false),
  /** Also issue new scan codes ("Turn off and replace codes"). Off by default: turning off never rotates. */
  replaceCodes: z.boolean().default(false),
  /** The cleared-override count the dry run showed; a save that would clear another number is refused (409). */
  expectedCleared: z.number().int().nonnegative().optional(),
  orgId: OrgIdSchema.optional(),
});
export const PutTemplateChannelsResponseSchema = TemplateChannelsResponseSchema.extend({
  impact: z.array(ChannelImpactSchema),
  /** The channel-apply run, when the save started one. */
  workflowInstanceId: z.string().nullable(),
  /** Whether the released version's barcode is the scan code (so codes can be replaced). */
  replaceSupported: z.boolean(),
  /** Opening within 48 hours or without hours: a dry run shows them as warnings. */
  windows: z.array(ChannelWindowSchema),
  /** The open event or session that refuses a replace (null when none). */
  blocked: ChannelBlockSchema.nullable(),
  /** No digital channel would stay on: no new code is possible. */
  allOff: z.boolean(),
});

export const ChannelApplyRunSchema = z.object({
  id: IdSchema,
  state: z.enum(['pending', 'running', 'done', 'dropped', 'failed']),
  /** When a pending run starts: pushed back by each save, ten minutes after the last. */
  dueAt: TimestampSchema,
  startedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
  counts: z.record(z.string(), z.number()),
  errorCode: z.string().nullable(),
  /** A running run that replaces codes and is held by an open event or session: its name and end (null when unknown). */
  waiting: z.object({ name: z.string(), until: TimestampSchema.nullable() }).nullable(),
});
export type ChannelApplyRunDto = z.infer<typeof ChannelApplyRunSchema>;

/** GET /api/v1/templates/{id}/channels/runs: the latest ten runs, newest first. */
export const ChannelApplyRunsResponseSchema = z.array(ChannelApplyRunSchema);
