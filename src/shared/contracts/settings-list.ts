import { z } from 'zod';
import { JsonSchema } from './common.ts';

export const SettingScopeSchema = z.union([z.literal('platform'), z.string().regex(/^org:.+$/)]);
export const SettingEntrySchema = z.object({
  scope: SettingScopeSchema,
  key: z.string(),
  value: JsonSchema,
  default: JsonSchema.optional(),
  updatedAt: z.number().int().nullable(),
  updatedBy: z.string().nullable(),
});
export const SettingsListQuerySchema = z.object({ scope: SettingScopeSchema.default('platform') });
export const SettingsListSchema = z.object({
  items: z.array(SettingEntrySchema),
  /** An org scope: send it back with a save; a save made from older values is a 409 SETTINGS_CHANGED. */
  configRevision: z.number().int().optional(),
  /** Read-only: managed in Polaris ID. */
  oidc: z.object({
    issuer: z.string(),
    adminGroup: z.string().nullable(),
    userGroup: z.string().nullable(),
  }),
});
export const UpdateSettingsSchema = z.object({
  scope: SettingScopeSchema.default('platform'),
  values: z.record(z.string(), JsonSchema),
  /** The `configRevision` the form was loaded with. Omitted, the server's current one applies. */
  configRevision: z.number().int().optional(),
});
/** What turning a sign-in method off would cost: active users who can only sign in by email. */
export const SettingsImpactSchema = z.object({ emailOnlyUsers: z.number().int() });
