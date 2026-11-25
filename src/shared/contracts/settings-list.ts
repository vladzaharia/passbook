import { z } from 'zod';
import { ChannelSchema } from './channels.ts';
import { JsonSchema } from './common.ts';

export const SettingScopeSchema = z.union([z.literal('platform'), z.string().regex(/^org:.+$/)]);
export const SettingEntrySchema = z.object({
  scope: SettingScopeSchema,
  key: z.string(),
  value: JsonSchema,
  /** Org scope: what applies when the org sets none (the platform default, within its ceiling). */
  default: JsonSchema.optional(),
  /** `org`: this scope stores a value. `default`: none stored; `value` is the effective default. */
  source: z.enum(['org', 'default']),
  /** Org scope: the most the platform allows. `value` is already clamped to it. */
  ceiling: z.number().int().optional(),
  /** The platform kill switch for this setting is off: the control does nothing until it is on. */
  blockedByPlatform: z.boolean().optional(),
  /** The organization's plan does not include the feature: the control does nothing until PassBook turns it on. */
  blockedByPlan: z.boolean().optional(),
  /** On `channels.blocked`: the channels the plan does not include. Absent when it includes them all. */
  planBlocked: z.array(ChannelSchema).optional(),
  updatedAt: z.number().int().nullable(),
  updatedBy: z.string().nullable(),
});
export const SettingsListQuerySchema = z.object({ scope: SettingScopeSchema.default('platform') });
export const SettingsListSchema = z.object({
  items: z.array(SettingEntrySchema),
  /** An org scope: send it back with a save; a save made from older values is a 409 SETTINGS_CHANGED. */
  configRevision: z.number().int().optional(),
  /** Read-only: managed in Polaris ID. Group lists hold exact names; empty means unset. */
  oidc: z.object({
    issuer: z.string(),
    platformAdminGroup: z.array(z.string()),
    adminGroup: z.array(z.string()),
    developerGroup: z.array(z.string()),
    userGroup: z.array(z.string()),
    /** How many Polaris ID subjects pin platform admin; 0 means the group alone decides. */
    platformAdminPinned: z.number().int(),
    /** Whether org console access needs the admin group. */
    consoleGroupRequired: z.boolean(),
  }),
  /** Platform scope, read-only: whether each wallet provider is released in any mode. */
  released: z.object({ google: z.boolean(), samsung: z.boolean() }).optional(),
});
export const UpdateSettingsSchema = z.object({
  scope: SettingScopeSchema.default('platform'),
  values: z.record(z.string(), JsonSchema),
  /** The `configRevision` the form was loaded with. Omitted, the server's current one applies. */
  configRevision: z.number().int().optional(),
});
/** What turning a sign-in method off would cost: active users who can only sign in by email. */
export const SettingsImpactSchema = z.object({ emailOnlyUsers: z.number().int() });
